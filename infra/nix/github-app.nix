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
  boxIdFile = "/run/secrets/rendered/forge-pull-deploy.env";
  boxKeyFile = "/run/secrets/github_box_app_private_key";

  probe =
    name:
    writeShellScriptBin name ''
      probe() {
        echo "env=''${FORGE_GITHUB_APP_ID-unset}"
        if [ -n "''${OPENROUTER_API_KEY-}" ]; then echo "openrouter=set"; else echo "openrouter=unset"; fi
        ${lib.optionalString (name != "forge-pull-deploy") ''
          for file in ${appIdFile} ${appKeyFile} ${boxIdFile} ${boxKeyFile}; do
            if contents="$(cat "$file" 2>/dev/null)"; then
              echo "read $(basename "$file") $contents"
            else
              echo "denied $(basename "$file")"
            fi
          done
        ''}
        if [ -n "''${FORGE_GITHUB_APP_PRIVATE_KEY_FILE-}" ]; then
          echo "credential $(cat "$FORGE_GITHUB_APP_PRIVATE_KEY_FILE")"
        fi
        echo "box-env=''${FORGE_GITHUB_BOX_APP_ID-unset}"
        if [ -n "''${FORGE_GITHUB_BOX_APP_PRIVATE_KEY_FILE-}" ]; then
          echo "box-credential $(cat "$FORGE_GITHUB_BOX_APP_PRIVATE_KEY_FILE")"
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

  probePullDeploy = probe "forge-pull-deploy";

  probeRuntime = symlinkJoin {
    name = "forge-runtime-probe";
    paths = map probe [
      "forge-run"
      "forge-dispatch"
      "forge-dispatch-pass"
      "forge-billing"
      "forge-grading"
      "forge-migrate"
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
    forge.runtime.pullDeploy = {
      enable = true;
      repository = "operator-org/operator";
    };
    systemd.services.forge-pull-deploy.serviceConfig = {
      Type = lib.mkForce "oneshot";
      Restart = lib.mkForce "no";
      ExecStart = lib.mkForce "${probePullDeploy}/bin/forge-pull-deploy";
    };
    forge.runtime.grading.model = "typesafe/jev-1.13";
    forge.runtime.repositories.forge = {
      github = "rameezk/forge";
      on.ticket = "builder";
      grading = true;
    };
  };

  testScript = builtins.readFile ./oneshot.py + ''
    app = "env=123456"
    key_credential = "credential github_app_private_key_fixture_not_a_real_key"
    no_key = "openrouter=unset"
    with_key = "openrouter=set"
    box_unset = "box-env=unset"
    box_id = "box-env=654321"
    box_key_credential = "box-credential github_box_app_private_key_fixture_not_a_real_key"
    files_denied = ["denied forge-github-app.env", "denied github_app_private_key", "denied forge-pull-deploy.env", "denied github_box_app_private_key"]
    denied = ["env=unset", no_key] + files_denied + [box_unset]
    denied_with_key = ["env=unset", with_key] + files_denied + [box_unset]

    def probe(name):
        return box.succeed(f"cat /var/lib/forge/{name}.out").splitlines()

    box.wait_for_unit("multi-user.target")

    with subtest("the rendered App id and the App private key are owned by forge-runtime and readable only by it"):
        for path in ["${appIdFile}", "${appKeyFile}"]:
            assert box.succeed(f"stat -L -c '%U %a' {path}").strip() == "forge-runtime 400", path

    with subtest("the box App's id and private key are owned by root and readable only by it"):
        for path in ["${boxIdFile}", "${boxKeyFile}"]:
            assert box.succeed(f"stat -L -c '%U %a' {path}").strip() == "root 400", path

    with subtest("frontier sync loads the App id and reads the private key as data from its credential"):
        box.succeed("systemctl start forge-frontier-sync.service")
        assert probe("forge-frontier-sync") == [app, no_key] + files_denied + [key_credential, box_unset], probe("forge-frontier-sync")

    with subtest("forge-frontier list reads the App id from its rendered file and the private key from its secret"):
        box.succeed("sudo -u forge-runtime forge-frontier list")
        listed = probe("forge-frontier-list")
        assert listed[0] == app, listed
        assert listed[-2] == key_credential, listed
        assert listed[-1] == box_unset, listed

    with subtest("dispatch loads the App id and reads the private key only as data from its credential"):
        box.succeed("forge-dispatch forge 148")
        assert probe("forge-dispatch-forge") == [app, with_key] + files_denied + [key_credential, box_unset], probe("forge-dispatch-forge")

    with subtest("grading loads the App id and the OpenRouter key and reads the private key only as data from its credential, and no other secret"):
        box.succeed("systemctl start forge-grading.service")
        assert probe("forge-grading") == [app, with_key] + files_denied + [key_credential, box_unset], probe("forge-grading")

    with subtest("the pull deploy loads the box App's id and reads its private key only as data from its credential, and is given nothing of the forge App"):
        box.succeed("systemctl start forge-pull-deploy.service")
        assert probe("forge-pull-deploy") == ["env=unset", no_key, box_id, box_key_credential], probe("forge-pull-deploy")

    with subtest("the units that do not use the App cannot read either"):
        box.succeed("systemctl start forge-runner@builder.service forge-billing.service")
        box.wait_for_file("/var/lib/forge/forge-dispatch-pass.out")
        for name, expected in [("forge-run-builder", denied_with_key), ("forge-billing", denied_with_key), ("forge-frontend", denied), ("forge-dispatch-pass", denied)]:
            assert probe(name) == expected, (name, probe(name))

    with subtest("a scheduled workload running across a redeploy cannot read the new secrets generation"):
        before_lingering = cursor(box)
        box.succeed("systemctl start --no-block forge-runner@lingering.service")
        box.wait_for_file("/var/lib/forge/forge-run-lingering.out")
        generation = box.succeed("readlink /run/secrets").strip()
        box.succeed("/run/current-system/bin/switch-to-configuration test")
        assert box.succeed("readlink /run/secrets").strip() != generation, "the redeploy did not render a new secrets generation"
        box.succeed("touch /var/lib/forge/redeployed")
        wait_until_oneshot_succeeded(box, "forge-runner@lingering.service", before_lingering)
        assert probe("forge-run-lingering-after") == denied_with_key, probe("forge-run-lingering-after")
  '';
}
