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
      echo "$rev" >> ${record}/built
      ${lib.optionalString broken ''
        echo "operator build failed for $rev" >&2
        exit 1
      ''}
      ${coreutils}/bin/mkdir -p $out/bin
      echo operator > $out/nixos-version
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
    { config, pkgs, ... }:
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
      nix.settings.substituters = lib.mkForce [ ];
      environment.systemPackages = [ git ];
      systemd.tmpfiles.rules = [
        "d ${record} 1777 root root - -"
        "f ${record}/built 0666 root root - -"
      ];

      forge.runtime.secretsFile = secretsFile;
      forge.runtime.package = pkgs.emptyDirectory;
      forge.runtime.pullDeploy = {
        enable = true;
        repository = "operator-org/operator";
        remote = "file:///srv/operator.git";
        apiBase = "http://127.0.0.1:8080";
        intervalSeconds = 2;
      };

      systemd.services = {
        fake-github = {
          wantedBy = [ "multi-user.target" ];
          serviceConfig = {
            ExecStart = "${python3}/bin/python3 ${fakeGithub}";
            StateDirectory = "fake-github";
          };
        };
      }
      // lib.optionalAttrs config.forge.runtime.pullDeploy.enable {
        forge-pull-deploy.serviceConfig.RestartSec = lib.mkForce "1s";
      };

      specialisation.off.configuration.forge.runtime.pullDeploy.enable = lib.mkForce false;
    };

  testScript = ''
    import json

    status_file = "/var/lib/forge-pull-deploy/status.json"
    requests_file = "/var/lib/fake-github/requests.jsonl"
    upstream_file = "/var/lib/fake-github/upstream.json"
    forge_state_file = "/var/lib/forge-pull-deploy/forge.json"
    commit_options = "-c user.name=operator -c user.email=operator@example.com"

    forge_a = "a" * 40
    forge_b = "b" * 40
    forge_c = "c" * 40
    upstream_head = "d" * 40
    fork_head = "e" * 40

    def lock(owner, repo, rev, ref=None):
        original = {"type": "github", "owner": owner, "repo": repo}
        if ref is not None:
            original["ref"] = ref
        locked = {"type": "github", "owner": owner, "repo": repo, "rev": rev}
        return json.dumps({"version": 7, "root": "root", "nodes": {"root": {"inputs": {"forge": "forge"}}, "forge": {"original": original, "locked": locked}}})

    def upstream(repos, fail=False):
        box.succeed(f"cat > {upstream_file} <<'EOF'\n" + json.dumps({"fail": fail, "repos": repos}) + "\nEOF")

    def push(flake, message, forge_lock=None):
        if forge_lock is not None:
            box.succeed(f"cat > /srv/work/flake.lock <<'EOF'\n{forge_lock}\nEOF")
        return box.succeed(
            f"install -m 0644 {flake} /srv/work/flake.nix && cd /srv/work && git add -A && "
            f"git {commit_options} commit -q --allow-empty -m '{message}' && git push -q origin HEAD:main && git rev-parse HEAD"
        ).strip()

    def lines(path):
        return box.succeed(f"cat {path} 2>/dev/null || true").split()

    def requests():
        return [json.loads(line) for line in box.succeed(f"cat {requests_file} 2>/dev/null || true").splitlines()]

    def assert_log(name, expected):
        actual = lines(f"${record}/{name}")
        assert actual == expected, (name, actual, expected)

    def polls():
        return len([r for r in requests() if r["method"] == "GET" and r["path"].endswith("/installation")])

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

    upstream({"rameezk/forge": {"head": upstream_head, "ahead": {forge_a: 3}}})

    with subtest("the box switches to the head of main and records it as both running and head, with the forge commit its lock names and how far upstream is ahead"):
        a = push("${operatorFlake false}", "operator commit A", lock("rameezk", "forge", forge_a))
        wait_for_status(running=a, head=a, error=None, forge=forge_a, upstream="rameezk/forge", upstreamHead=upstream_head, behind=3)
        assert_log("switched", [a])

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
        assert_log("built", [a])
        assert_log("switched", [a])
        wait_for_status(running=a, head=a, error=None, forge=forge_a, upstream="rameezk/forge", upstreamHead=upstream_head, behind=3)

    with subtest("the box keeps the forge commit while main is unchanged and refreshes upstream on every poll"):
        upstream({"rameezk/forge": {"head": forge_b, "ahead": {forge_a: 4}}})
        wait_for_status(running=a, head=a, error=None, forge=forge_a, upstream="rameezk/forge", upstreamHead=forge_b, behind=4)
        assert_log("built", [a])

    with subtest("a box that predates the forge state file learns its forge commit again without switching"):
        box.succeed(f"rm {forge_state_file}")
        box.succeed("systemctl restart forge-pull-deploy.service")
        wait_for_status(running=a, head=a, error=None, forge=forge_a, behind=4)
        box.succeed(f"test -f {forge_state_file}")
        assert_log("switched", [a])

    with subtest("a failed upstream lookup leaves the upstream fields empty and records no deploy error"):
        upstream({"rameezk/forge": {"head": forge_b, "ahead": {forge_a: 4}}}, fail=True)
        wait_for_status(running=a, head=a, error=None, forge=forge_a, upstream=None, upstreamHead=None, behind=None)
        upstream({"rameezk/forge": {"head": forge_b, "ahead": {forge_a: 4}}})
        wait_for_status(running=a, head=a, error=None, forge=forge_a, upstream="rameezk/forge", upstreamHead=forge_b, behind=4)

    with subtest("the box looks upstream up on the source the locked forge input follows, a fork included"):
        upstream({"rameezk/forge": {"head": forge_b, "ahead": {}}, "fork-org/forge": {"head": fork_head, "ahead": {forge_b: 1}}})
        b = push("${operatorFlake false}", "operator commit B", lock("fork-org", "forge", forge_b, "main"))
        wait_for_status(running=b, head=b, error=None, forge=forge_b, upstream="fork-org/forge", upstreamHead=fork_head, behind=1)
        assert_log("switched", [a, b])
        seen = len(requests())
        wait_for_polls(2)
        paths = [r["path"] for r in requests()[seen:] if r["path"].startswith("/repos/") and not r["path"].endswith("/installation")]
        assert "/repos/fork-org/forge/commits/main" in paths, paths
        assert not [p for p in paths if p.startswith("/repos/rameezk/forge")], paths

    with subtest("a commit that fails to build is remembered and not tried again"):
        box.wait_for_unit("forge-pull-deploy.service")
        c = push("${operatorFlake true}", "operator commit C", lock("fork-org", "forge", forge_c, "main"))
        wait_for_status(running=b, head=c)
        failed = status()
        assert failed["error"] is not None and "operator build failed for " + c in failed["error"], failed
        assert failed["forge"] == forge_b and failed["upstream"] == "fork-org/forge", failed
        wait_for_polls(3)
        assert lines("${record}/built").count(c) == 1, lines("${record}/built")
        assert_log("switched", [a, b])
        assert status() == failed, status()

    with subtest("restarting the unit by hand tries the remembered commit again"):
        box.succeed("systemctl restart forge-pull-deploy.service")
        retry(lambda _: lines("${record}/built").count(c) == 2, 120)

    with subtest("the box recovers when main moves past the failed commit"):
        upstream({"fork-org/forge": {"head": fork_head, "ahead": {forge_c: 0}}})
        d = push("${operatorFlake false}", "operator commit D")
        wait_for_status(running=d, head=d, error=None, forge=forge_c, upstream="fork-org/forge", upstreamHead=fork_head, behind=0)
        assert_log("switched", [a, b, d])

    with subtest("a hand deploy is reverted at the next pull"):
        box.succeed("mkdir -p /run/hand-deployed && ln -sfn $(readlink -f /run/booted-system/sw) /run/hand-deployed/sw && ln -sfn /run/hand-deployed /run/current-system")
        retry(lambda _: lines("${record}/switched") == [a, b, d, d], 120)
        retry(lambda _: lines("/var/lib/forge-pull-deploy/system") == ["/run/hand-deployed"], 120)
        box.succeed("ln -sfn $(readlink -f /run/booted-system) /run/current-system")
        retry(lambda _: lines("${record}/switched") == [a, b, d, d, d], 120)

    with subtest("the box does nothing when the pull deploy is off"):
        box.succeed("/run/booted-system/specialisation/off/bin/switch-to-configuration test")
        box.fail("systemctl cat forge-pull-deploy.service")
        before = len(requests())
        push("${operatorFlake false}", "operator commit E")
        box.sleep(10)
        assert len(requests()) == before, requests()[before:]
        assert_log("switched", [a, b, d, d, d])
        assert status()["head"] == d, status()
  '';
}
