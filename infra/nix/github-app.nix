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
  appIdFile = "/run/secrets/rendered/forge-github-app.env";
  appKeyFile = "/run/secrets/github_app_private_key";

  probe =
    name:
    writeShellScriptBin name ''
      probe() {
        echo "env=''${FORGE_GITHUB_APP_ID-unset}"
        for file in ${appIdFile} ${appKeyFile}; do
          if contents="$(cat "$file" 2>/dev/null)"; then
            echo "read $(basename "$file") $contents"
          else
            echo "denied $(basename "$file")"
          fi
        done
        if [ -n "''${FORGE_GITHUB_APP_PRIVATE_KEY_FILE-}" ]; then
          echo "credential $(cat "$FORGE_GITHUB_APP_PRIVATE_KEY_FILE")"
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
      "forge-dispatch-pass"
      "forge-billing"
      "forge-frontier"
      "forge-frontend"
    ];
  };
in
testers.runNixOSTest {
  name = "github-app";

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
      on.ticket = "builder";
    };
  };

  testScript = builtins.readFile ./oneshot.py + ''
    app = "env=123456"
    key_credential = "credential github_app_private_key_fixture_not_a_real_key"
    denied = ["env=unset", "denied forge-github-app.env", "denied github_app_private_key"]

    def probe(name):
        return box.succeed(f"cat /var/lib/forge/{name}.out").splitlines()

    box.wait_for_unit("multi-user.target")

    with subtest("the rendered App id and the App private key are owned by forge-runtime and readable only by it"):
        for path in ["${appIdFile}", "${appKeyFile}"]:
            assert box.succeed(f"stat -L -c '%U %a' {path}").strip() == "forge-runtime 400", path

    with subtest("frontier sync loads the App id and reads the private key as data from its credential"):
        box.succeed("systemctl start forge-frontier-sync.service")
        assert probe("forge-frontier-sync") == [app, "denied forge-github-app.env", "denied github_app_private_key", key_credential], probe("forge-frontier-sync")

    with subtest("forge-frontier list reads the App id from its rendered file and the private key from its secret"):
        box.succeed("sudo -u forge-runtime forge-frontier list")
        listed = probe("forge-frontier-list")
        assert listed[0] == app, listed
        assert listed[-1] == key_credential, listed

    with subtest("dispatch loads the App id and reads the private key only as data from its credential"):
        box.succeed("forge-dispatch forge 148")
        assert probe("forge-dispatch-forge") == [app, "denied forge-github-app.env", "denied github_app_private_key", key_credential], probe("forge-dispatch-forge")

    with subtest("the units that do not use the App cannot read either"):
        box.succeed("systemctl start forge-runner@builder.service forge-billing.service")
        box.wait_for_file("/var/lib/forge/forge-dispatch-pass.out")
        for name in ["forge-run-builder", "forge-billing", "forge-frontend", "forge-dispatch-pass"]:
            assert probe(name) == denied, (name, probe(name))

    with subtest("a scheduled workload running across a redeploy cannot read the new secrets generation"):
        before_lingering = cursor(box)
        box.succeed("systemctl start --no-block forge-runner@lingering.service")
        box.wait_for_file("/var/lib/forge/forge-run-lingering.out")
        generation = box.succeed("readlink /run/secrets").strip()
        box.succeed("/run/current-system/bin/switch-to-configuration test")
        assert box.succeed("readlink /run/secrets").strip() != generation, "the redeploy did not render a new secrets generation"
        box.succeed("touch /var/lib/forge/redeployed")
        wait_until_oneshot_succeeded(box, "forge-runner@lingering.service", before_lingering)
        assert probe("forge-run-lingering-after") == denied, probe("forge-run-lingering-after")
  '';
}
