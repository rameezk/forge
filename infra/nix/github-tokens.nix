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
      probe() {
        echo "env=''${GITHUB_TOKEN-unset}"
        for file in ${frontierToken} ${writeToken}; do
          if contents="$(cat "$file" 2>/dev/null)"; then
            echo "read $(basename "$file") $contents"
          else
            echo "denied $(basename "$file")"
          fi
        done
        if [ -n "''${FORGE_GITHUB_WRITE_TOKEN_FILE-}" ]; then
          echo "credential $(cat "$FORGE_GITHUB_WRITE_TOKEN_FILE")"
        fi
      }
      out="/var/lib/forge/${name}''${1:+-$1}"
      probe > "$out.out"
      if [ "''${1-}" = lingering ]; then
        until [ -e /var/lib/forge/redeployed ]; do sleep 1; done
        probe > "$out-after.out"
      fi
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
    system.switch.enable = true;
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
    write_credential = "credential GITHUB_TOKEN=github_pat_fixture_write_not_a_real_token"
    denied = ["env=unset", "denied forge-github.env", "denied forge-github-write.env"]

    def probe(name):
        return box.succeed(f"cat /var/lib/forge/{name}.out").splitlines()

    box.wait_for_unit("multi-user.target")

    with subtest("both rendered token files are owned by forge-runtime and readable only by it"):
        for path in ["${frontierToken}", "${writeToken}"]:
            assert box.succeed(f"stat -L -c '%U %a' {path}").strip() == "forge-runtime 400", path

    with subtest("frontier sync loads the frontier token and reads the write token as data from its credential"):
        box.succeed("systemctl start forge-frontier-sync.service")
        assert probe("forge-frontier-sync") == [frontier, "denied forge-github.env", "denied forge-github-write.env", write_credential], probe("forge-frontier-sync")

    with subtest("forge-frontier list reads the frontier token from its rendered file"):
        box.succeed("sudo -u forge-runtime forge-frontier list")
        assert probe("forge-frontier-list")[0] == frontier, probe("forge-frontier-list")

    with subtest("dispatch reads the write token only as data from its credential and never sees the frontier token"):
        box.succeed("forge-dispatch forge 148")
        assert probe("forge-dispatch-forge") == denied + [write_credential], probe("forge-dispatch-forge")

    with subtest("the units that do not use a token cannot read either"):
        box.succeed("systemctl start forge-runner@builder.service forge-billing.service")
        for name in ["forge-run-builder", "forge-billing", "forge-frontend"]:
            assert probe(name) == denied, (name, probe(name))

    with subtest("a scheduled workload running across a redeploy cannot read the new secrets generation"):
        box.succeed("systemctl start --no-block forge-runner@lingering.service")
        box.wait_for_file("/var/lib/forge/forge-run-lingering.out")
        generation = box.succeed("readlink /run/secrets").strip()
        box.succeed("/run/current-system/bin/switch-to-configuration test")
        assert box.succeed("readlink /run/secrets").strip() != generation, "the redeploy did not render a new secrets generation"
        box.succeed("touch /var/lib/forge/redeployed")
        box.wait_until_succeeds("test \"$(systemctl show -P ActiveState forge-runner@lingering.service)\" = inactive")
        assert box.succeed("systemctl show -P Result forge-runner@lingering.service").strip() == "success"
        assert probe("forge-run-lingering-after") == denied, probe("forge-run-lingering-after")

    with subtest("no hand-placed plain-text token stays behind after activation"):
        box.succeed("runuser -u forge-runtime -- sh -c 'echo GITHUB_TOKEN=leftover > /var/lib/forge/github.env'")
        box.succeed("install -d -o forge-runtime -g forge-runtime -m 0700 /var/lib/forge-credentials")
        box.succeed("runuser -u forge-runtime -- sh -c 'echo GITHUB_TOKEN=leftover > /var/lib/forge-credentials/github-write.env'")
        box.succeed("/run/current-system/bin/switch-to-configuration test")
        box.fail("test -e /var/lib/forge/github.env")
        box.fail("test -e /var/lib/forge-credentials")
  '';
}
