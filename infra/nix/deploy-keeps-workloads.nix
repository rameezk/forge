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
  runtimeOf =
    version:
    let
      hold = kind: ''
        echo "${version}" > "/var/lib/forge/started-${kind}-$1"
        until [ -e "/var/lib/forge/release-${kind}" ]; do sleep 1; done
      '';
    in
    symlinkJoin {
      name = "forge-runtime-${version}";
      paths = [
        (writeShellScriptBin "forge-run" (hold "run"))
        (writeShellScriptBin "forge-dispatch" (hold "dispatch"))
        (writeShellScriptBin "forge-frontier" "exit 0")
        (writeShellScriptBin "forge-dispatch-pass" "exit 0")
        (writeShellScriptBin "forge-billing" "exit 0")
        (writeShellScriptBin "forge-frontend" "exec sleep infinity")
      ];
    };
in
testers.runNixOSTest {
  name = "deploy-keeps-workloads";

  nodes.box =
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
      systemd.timers.forge-frontier-sync.enable = false;
      forge.runtime.secretsFile = secretsFile;
      forge.runtime.package = runtimeOf "old";
      forge.runtime.harnesses.pi.command = "/run/current-system/sw/bin/pi";
      forge.runtime.workers.builder = {
        harness = "pi";
        model = "stub/deploy";
        prompt = "/work-on {url}";
        timeout = "1h";
      };
      forge.runtime.repositories.forge = {
        github = "rameezk/forge";
        worker = "builder";
      };
      forge.runtime.dispatch.gitIdentity = {
        name = "Forge Operator";
        email = "operator@example.com";
      };
      specialisation.newpackage.configuration = {
        forge.runtime.package = lib.mkForce (runtimeOf "new");
      };
    };

  testScript = builtins.readFile ./oneshot.py + ''
    def show(unit, prop):
        return box.succeed(f"systemctl show --value -p {prop} {unit}").strip()

    def started_by(kind, name):
        return box.succeed(f"cat /var/lib/forge/started-{kind}-{name}").strip()

    def wait_inactive(unit):
        retry(lambda _: show(unit, "ActiveState") == "inactive", 60)

    box.wait_for_unit("multi-user.target")

    dispatch = "forge-dispatch@forge:7.service"
    runner = "forge-runner@builder.service"

    box.succeed(f"systemctl start --no-block {dispatch} {runner}")
    box.wait_for_file("/var/lib/forge/started-dispatch-forge")
    box.wait_for_file("/var/lib/forge/started-run-builder")
    pids = {unit: show(unit, "MainPID") for unit in [dispatch, runner]}
    assert all(pid != "0" for pid in pids.values()), pids

    box.succeed("/run/current-system/specialisation/newpackage/bin/switch-to-configuration test")

    with subtest("a dispatch survives a deploy that changes its unit"):
        assert show(dispatch, "ActiveState") == "active", show(dispatch, "ActiveState")
        assert show(dispatch, "MainPID") == pids[dispatch], (show(dispatch, "MainPID"), pids[dispatch])
        box.succeed("touch /var/lib/forge/release-dispatch")
        wait_inactive(dispatch)
        assert show(dispatch, "Result") == "success", show(dispatch, "Result")

    with subtest("a worker run survives a deploy that changes its unit"):
        assert show(runner, "ActiveState") == "active", show(runner, "ActiveState")
        assert show(runner, "MainPID") == pids[runner], (show(runner, "MainPID"), pids[runner])
        box.succeed("touch /var/lib/forge/release-run")
        wait_inactive(runner)
        assert show(runner, "Result") == "success", show(runner, "Result")

    with subtest("a dispatch started after a deploy runs the new package"):
        box.succeed("systemctl start forge-dispatch@forge:8.service")
        assert started_by("dispatch", "forge") == "new", started_by("dispatch", "forge")

    with subtest("a worker run started after a deploy runs the new package"):
        box.succeed("systemctl start forge-runner@builder.service")
        assert started_by("run", "builder") == "new", started_by("run", "builder")
  '';
}
