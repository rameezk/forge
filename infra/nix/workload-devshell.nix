{
  lib,
  stdenv,
  testers,
  writeShellScriptBin,
  writeText,
  runCommand,
  bash,
  git,
  nodejs,
  openssl,
  forge-runner,
  sopsModule,
  secretsFile,
  secretsHostKey,
}:
let
  system = stdenv.hostPlatform.system;
  githubFixtures = ../../runtime/packages/runner/test/fixtures/github;

  githubCertificate = runCommand "fake-github-certificate" { nativeBuildInputs = [ openssl ]; } ''
    mkdir $out
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
      -subj /CN=api.github.com -addext subjectAltName=DNS:api.github.com \
      -keyout $out/key.pem -out $out/cert.pem
  '';

  fakeGithub = writeText "fake-github.mjs" ''
    import { createServer } from 'node:https';
    import { readFileSync } from 'node:fs';
    const fixture = (name) => JSON.parse(readFileSync(`${githubFixtures}/''${name}.json`, 'utf8'));
    const graphql = (body) => {
      const operation = /query (\w+)/.exec(body.query)?.[1];
      if (operation === 'Ticket') {
        const ticket = fixture('frontier-ticket');
        ticket.data.repository.issue.labels.nodes.push({ name: 'forge:ready' });
        return ticket;
      }
      if (operation === 'LabelledIssues') {
        const labelled = fixture('labelled-issues');
        labelled.data.repository.issues.nodes = [];
        return labelled;
      }
      if (operation === 'ClosingPullRequests') return fixture('no-pull-request');
      return { errors: [{ message: `no fake answer for ''${operation}` }] };
    };
    createServer(
      { key: readFileSync('${githubCertificate}/key.pem'), cert: readFileSync('${githubCertificate}/cert.pem') },
      (request, response) => {
        let body = ''';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(request.url === '/graphql' ? graphql(JSON.parse(body)) : []));
        });
      },
    ).listen(443, '127.0.0.1');
  '';

  flake = writeText "flake.nix" ''
    {
      outputs = { self }: {
        devShells.${system}.default = derivation {
          name = "devshell";
          system = "${system}";
          outputs = [ "out" ];
          builder = builtins.appendContext "${bash}/bin/bash" { "${bash}" = { path = true; }; };
          PATH = "''${self}/bin";
        };
      };
    }
  '';

  stubHarness = writeShellScriptBin "stub-harness" ''
    set -u
    echo "$PATH" > path.out
    devshell-stub > devshell.out 2>&1
    echo '{"type":"agent_start"}'
    echo '{"type":"agent_end","willRetry":false}'
  '';
in
testers.runNixOSTest {
  name = "workload-devshell";

  nodes.box = {
    imports = [
      sopsModule
      ../nixos/runtime.nix
    ];
    system.activationScripts.hostKey.text = ''
      install -D -m 0600 ${secretsHostKey} /etc/ssh/ssh_host_ed25519_key
    '';
    system.activationScripts.setupSecrets.deps = [ "hostKey" ];
    sops.age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];
    system.extraDependencies = [ bash ];
    networking.hosts."127.0.0.1" = [ "api.github.com" ];
    programs.git = {
      enable = true;
      config.url."file:///srv/origin".insteadOf = "https://github.com/rameezk/forge.git";
    };
    systemd.services.fake-github = {
      wantedBy = [ "multi-user.target" ];
      serviceConfig.ExecStart = "${lib.getExe nodejs} ${fakeGithub}";
    };
    systemd.services."forge-dispatch@".environment.NODE_EXTRA_CA_CERTS =
      "${githubCertificate}/cert.pem";
    forge.runtime.secretsFile = secretsFile;
    forge.runtime.package = forge-runner;
    forge.runtime.harnesses.pi.command = lib.getExe stubHarness;
    forge.runtime.workload.maxCost = null;
    forge.runtime.workers.builder = {
      harness = "pi";
      model = "stub/devshell";
      prompt = "build {url}";
    };
    forge.runtime.repositories.forge = {
      github = "rameezk/forge";
      worker = "builder";
    };
    forge.runtime.dispatch.gitIdentity = {
      name = "Forge Operator";
      email = "operator@example.com";
    };
  };

  testScript = ''
    git = "runuser -u forge-runtime -- ${lib.getExe git} -C /srv/origin -c user.name=Origin -c user.email=origin@example.com"

    box.wait_for_unit("multi-user.target")
    box.wait_for_open_port(443)

    box.succeed("install -d -o forge-runtime -g forge-runtime /srv/origin /srv/origin/bin")
    box.succeed("install -o forge-runtime -g forge-runtime -m 0644 ${flake} /srv/origin/flake.nix")
    box.succeed("printf '#!/bin/sh\\necho devshell stub ran\\n' > /srv/origin/bin/devshell-stub")
    box.succeed("chown forge-runtime:forge-runtime /srv/origin/bin/devshell-stub && chmod 0755 /srv/origin/bin/devshell-stub")
    box.succeed(f"{git} init --quiet --initial-branch main")
    box.succeed(f"{git} add .")
    box.succeed(f"{git} commit --quiet -m devshell")

    with subtest("a dispatched workload finds its repository's devShell tool on its path, ahead of the workload toolset"):
        box.succeed("systemctl start forge-dispatch@forge:113.service")
        assert box.succeed("cat /var/lib/forge/work/*/devshell.out").strip() == "devshell stub ran"
        first, rest = box.succeed("cat /var/lib/forge/work/*/path.out").strip().split(":", 1)
        assert first.startswith("/nix/store/") and first.endswith("-source/bin"), first
        assert "-git-" in rest, rest
  '';
}
