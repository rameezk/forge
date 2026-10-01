{
  lib,
  testers,
  symlinkJoin,
  writeShellScriptBin,
  sopsModule,
  secretsFile,
  secretsHostKey,
}:
let
  frontierToken = "/run/secrets/rendered/forge-github.env";
  writeToken = "/run/secrets/rendered/forge-github-write.env";

  probe =
    name:
    writeShellScriptBin name ''
      {
        echo "env=''${GITHUB_TOKEN-unset}"
        for file in ${frontierToken} ${writeToken}; do
          if contents="$(cat "$file" 2>/dev/null)"; then
            echo "read $(basename "$file") $contents"
          else
            echo "denied $(basename "$file")"
          fi
        done
      } > "/var/lib/forge/${name}''${1:+-$1}.out"
      ${lib.optionalString (name == "forge-frontend") "exec sleep infinity"}
    '';

  probeRuntime = symlinkJoin {
    name = "forge-runtime-probe";
    paths = map probe [
      "forge-run"
      "forge-dispatch"
      "forge-billing"
      "forge-frontier"
      "forge-frontend"
    ];
  };
in
testers.runNixOSTest {
  name = "github-tokens";

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
    forge.runtime.secretsFile = secretsFile;
    forge.runtime.package = probeRuntime;
    forge.runtime.harnesses.pi.command = "/run/current-system/sw/bin/pi";
    forge.runtime.workers.builder = {
      harness = "pi";
      model = "stub/tokens";
      prompt = "/work-on {url}";
    };
    forge.runtime.repositories.forge = {
      github = "rameezk/forge";
      worker = "builder";
    };
  };

  testScript = ''
    frontier = "env=github_pat_fixture_frontier_not_a_real_token"
    read_frontier = "read forge-github.env GITHUB_TOKEN=github_pat_fixture_frontier_not_a_real_token"
    read_write = "read forge-github-write.env GITHUB_TOKEN=github_pat_fixture_write_not_a_real_token"

    def probe(name):
        return box.succeed(f"cat /var/lib/forge/{name}.out").splitlines()

    box.wait_for_unit("multi-user.target")

    with subtest("both rendered token files are owned by forge-runtime and readable only by it"):
        for path in ["${frontierToken}", "${writeToken}"]:
            assert box.succeed(f"stat -L -c '%U %a' {path}").strip() == "forge-runtime 400", path

    with subtest("frontier sync loads the frontier token and reads the write token as data"):
        box.succeed("systemctl start forge-frontier-sync.service")
        assert probe("forge-frontier-sync") == [frontier, read_frontier, read_write], probe("forge-frontier-sync")

    with subtest("forge-frontier list reads the frontier token from its rendered file"):
        box.succeed("sudo -u forge-runtime forge-frontier list")
        assert probe("forge-frontier-list")[0] == frontier, probe("forge-frontier-list")

    with subtest("dispatch reads the write token only as data and never sees the frontier token"):
        box.succeed("forge-dispatch forge 148")
        assert probe("forge-dispatch-forge") == ["env=unset", "denied forge-github.env", read_write], probe("forge-dispatch-forge")

    with subtest("each token is masked from the units that do not use it"):
        box.succeed("systemctl start forge-runner@builder.service forge-billing.service")
        denied = ["env=unset", "denied forge-github.env", "denied forge-github-write.env"]
        for name in ["forge-run-builder", "forge-billing", "forge-frontend"]:
            assert probe(name) == denied, (name, probe(name))

    with subtest("no hand-placed plain-text token stays behind after activation"):
        box.succeed("runuser -u forge-runtime -- sh -c 'echo GITHUB_TOKEN=leftover > /var/lib/forge/github.env'")
        box.succeed("install -d -o forge-runtime -g forge-runtime -m 0700 /var/lib/forge-credentials")
        box.succeed("runuser -u forge-runtime -- sh -c 'echo GITHUB_TOKEN=leftover > /var/lib/forge-credentials/github-write.env'")
        box.succeed("/run/current-system/bin/switch-to-configuration test")
        box.fail("test -e /var/lib/forge/github.env")
        box.fail("test -e /var/lib/forge-credentials")
  '';
}
