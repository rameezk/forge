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

  testScript = ''
    def show(unit, prop):
        return box.succeed(f"systemctl show --value -p {prop} {unit}").strip()

    def started_by(kind, name):
        return box.succeed(f"cat /var/lib/forge/started-{kind}-{name}").strip()

    def wait_inactive(unit):
        retry(lambda _: show(unit, "ActiveState") == "inactive", 60)

    def survives_deploy(unit, kind, pid):
        state = (show(unit, "ActiveState"), show(unit, "SubState"))
        assert state == ("activating", "start"), (unit, state)
        assert show(unit, "MainPID") == pid, (unit, show(unit, "MainPID"), pid)
        box.succeed(f"touch /var/lib/forge/release-{kind}")
        wait_inactive(unit)
        assert show(unit, "Result") == "success", (unit, show(unit, "Result"))

    def runs_version(kind, name, version):
        assert started_by(kind, name) == version, (kind, name, started_by(kind, name))

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
        survives_deploy(dispatch, "dispatch", pids[dispatch])

    with subtest("a worker run survives a deploy that changes its unit"):
        survives_deploy(runner, "run", pids[runner])

    with subtest("a dispatch started after a deploy runs the new package"):
        box.succeed("systemctl start forge-dispatch@forge:8.service")
        runs_version("dispatch", "forge", "new")

    with subtest("a worker run started after a deploy runs the new package"):
        box.succeed("systemctl start forge-runner@builder.service")
        runs_version("run", "builder", "new")
  '';
}
