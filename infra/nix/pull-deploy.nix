{
  lib,
  testers,
  runCommand,
  writeText,
  writeShellScript,
  python3,
  bash,
  coreutils,
  git,
  jq,
  openssh,
  openssl,
  sops,
  ssh-to-age,
  stdenv,
  sopsModule,
  secretsHostKey,
}:
let
  secretsFile =
    runCommand "pull-deploy-secrets.yaml"
      {
        nativeBuildInputs = [
          jq
          openssh
          openssl
          sops
          ssh-to-age
        ];
      }
      ''
        recipient="$(ssh-keygen -y -f ${secretsHostKey} | ssh-to-age)"
        key="$(openssl genrsa 2048)"
        jq -n --arg key "$key" '{tailscale_auth_key: "tailscale_auth_key_fixture_not_a_real_key", github_app_id: "123456", github_app_private_key: $key}' |
          sops encrypt --age "$recipient" --input-type json --output-type yaml --filename-override secrets.yaml /dev/stdin > $out
      '';

  record = "/var/lib/pull-deploy-test";

  builder =
    broken:
    writeShellScript "operator-builder-${if broken then "broken" else "ok"}" ''
      ${coreutils}/bin/mkdir -p ${record}
      echo "$rev" >> ${record}/built
      ${lib.optionalString broken ''
        echo "operator build failed for $rev" >&2
        exit 1
      ''}
      ${coreutils}/bin/mkdir -p $out/bin
      {
        echo '#!${bash}/bin/bash'
        echo "echo $rev >> ${record}/switched"
      } > $out/bin/switch-to-configuration
      ${coreutils}/bin/chmod +x $out/bin/switch-to-configuration
    '';

  operatorFlake =
    broken:
    writeText "flake.nix" ''
      {
        outputs =
          { self }:
          {
            nixosConfigurations.box.config.system.build.toplevel = derivation {
              name = "operator-''${self.rev}";
              system = "${stdenv.hostPlatform.system}";
              builder = "${builder broken}";
              rev = self.rev;
            };
          };
      }
    '';

  fakeGithub = writeText "fake-github.py" (builtins.readFile ./pull-deploy-fake-github.py);
in
testers.runNixOSTest {
  name = "pull-deploy";

  nodes.box =
    { pkgs, ... }:
    {
      imports = [
        sopsModule
        ../nixos/runtime.nix
      ];
      system.activationScripts.hostKey.text = ''
        install -D -m 0600 ${secretsHostKey} /etc/ssh/ssh_host_ed25519_key
      '';
      system.activationScripts.setupSecrets.deps = [ "hostKey" ];
      system.switch.enable = true;
      sops.age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];
      sops.validateSopsFiles = false;
      sops.secrets.tailscale_auth_key.sopsFile = secretsFile;
      virtualisation.memorySize = 2048;
      nix.settings.sandbox = false;
      environment.systemPackages = [ git ];

      forge.runtime.secretsFile = secretsFile;
      forge.runtime.package = pkgs.emptyDirectory;
      forge.runtime.pullDeploy = {
        enable = true;
        repository = "operator-org/operator";
        remote = "file:///srv/operator.git";
        apiBase = "http://127.0.0.1:8080";
        intervalSeconds = 2;
      };
      systemd.services.forge-pull-deploy.serviceConfig.RestartSec = lib.mkForce "1s";

      systemd.services.fake-github = {
        wantedBy = [ "multi-user.target" ];
        serviceConfig = {
          ExecStart = "${python3}/bin/python3 ${fakeGithub}";
          StateDirectory = "fake-github";
        };
      };

      specialisation.off.configuration.forge.runtime.pullDeploy.enable = lib.mkForce false;
    };

  testScript = ''
    import json

    status_file = "/var/lib/forge/deploy-status.json"
    requests_file = "/var/lib/fake-github/requests.jsonl"
    commit_options = "-c user.name=operator -c user.email=operator@example.com"

    def push(flake, message):
        return box.succeed(
            f"install -m 0644 {flake} /srv/work/flake.nix && cd /srv/work && git add -A && "
            f"git {commit_options} commit -q --allow-empty -m '{message}' && git push -q origin HEAD:main && git rev-parse HEAD"
        ).strip()

    def lines(path):
        return box.succeed(f"cat {path} 2>/dev/null || true").split()

    def requests():
        return [json.loads(line) for line in box.succeed(f"cat {requests_file} 2>/dev/null || true").splitlines()]

    def polls():
        return len([r for r in requests() if r["method"] == "GET"])

    def status():
        return json.loads(box.succeed(f"cat {status_file}"))

    def wait_for_status(**expected):
        def matches(_):
            try:
                current = status()
            except Exception:
                return False
            return all(current[key] == value for key, value in expected.items())
        retry(matches, 120)

    def wait_for_polls(count):
        start = polls()
        retry(lambda _: polls() >= start + count, 120)

    box.wait_for_unit("multi-user.target")
    box.wait_for_unit("fake-github.service")
    box.succeed("git init -q --bare -b main /srv/operator.git && git clone -q /srv/operator.git /srv/work")

    with subtest("the box switches to the head of main and records it as both running and head"):
        a = push("${operatorFlake false}", "operator commit A")
        wait_for_status(running=a, head=a, error=None)
        assert lines("${record}/switched") == [a], lines("${record}/switched")

    with subtest("the box asks for an installation token narrowed to the operator repository with read access to contents"):
        posts = [r for r in requests() if r["method"] == "POST"]
        assert posts, requests()
        for post in posts:
            assert post["path"] == "/app/installations/42/access_tokens", post
            assert post["body"] == {"repositories": ["operator"], "permissions": {"contents": "read"}}, post
        assert all(r["signed"] for r in requests()), requests()

    with subtest("the box does not rebuild or switch while main is unchanged"):
        box.wait_for_unit("forge-pull-deploy.service")
        wait_for_polls(3)
        assert lines("${record}/built") == [a], lines("${record}/built")
        assert lines("${record}/switched") == [a], lines("${record}/switched")
        wait_for_status(running=a, head=a, error=None)

    with subtest("the box switches when main moves to a commit that builds"):
        b = push("${operatorFlake false}", "operator commit B")
        wait_for_status(running=b, head=b, error=None)
        assert lines("${record}/switched") == [a, b], lines("${record}/switched")

    with subtest("a commit that fails to build is remembered and not tried again"):
        box.wait_for_unit("forge-pull-deploy.service")
        c = push("${operatorFlake true}", "operator commit C")
        wait_for_status(running=b, head=c)
        failed = status()
        assert failed["error"] is not None and "operator build failed for " + c in failed["error"], failed
        wait_for_polls(3)
        assert lines("${record}/built").count(c) == 1, lines("${record}/built")
        assert lines("${record}/switched") == [a, b], lines("${record}/switched")
        assert status() == failed, status()

    with subtest("restarting the unit by hand tries the remembered commit again"):
        box.succeed("systemctl restart forge-pull-deploy.service")
        retry(lambda _: lines("${record}/built").count(c) == 2, 120)
        wait_for_status(running=b, head=c)

    with subtest("the box recovers when main moves past the failed commit"):
        d = push("${operatorFlake false}", "operator commit D")
        wait_for_status(running=d, head=d, error=None)
        assert lines("${record}/switched") == [a, b, d], lines("${record}/switched")

    with subtest("the box does nothing when the pull deploy is off"):
        box.succeed("/run/current-system/specialisation/off/bin/switch-to-configuration test")
        box.fail("systemctl cat forge-pull-deploy.service")
        before = len(requests())
        e = push("${operatorFlake false}", "operator commit E")
        box.sleep(10)
        assert len(requests()) == before, requests()[before:]
        assert lines("${record}/switched") == [a, b, d], lines("${record}/switched")
        assert status()["head"] == d, status()
  '';
}
