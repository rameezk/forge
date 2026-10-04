{ testers, sopsModule }:
testers.runNixOSTest {
  name = "run-directories";

  nodes.box = {
    imports = [
      sopsModule
      ../nixos/runtime.nix
    ];
    services.timesyncd.enable = false;
  };

  testScript = ''
    def write_run(run, name):
        box.succeed(f"install -d -o forge-runtime -g forge-runtime /var/lib/forge/work/{run}")
        box.succeed(f"runuser -u forge-runtime -- sh -c 'echo report > /var/lib/forge/work/{run}/{name}'")

    box.wait_for_unit("multi-user.target")

    with subtest("old run directories age out and recent ones remain whole"):
        write_run("run-old", "report.md")
        box.succeed("date -s '+15 days'")
        write_run("run-today", "report.md")
        write_run("run-today", "vendored.txt")
        box.succeed("touch -d '15 days ago' /var/lib/forge/work/run-today/vendored.txt")

        box.succeed("systemctl start systemd-tmpfiles-clean.service")

        box.fail("test -e /var/lib/forge/work/run-old")
        box.succeed("test -f /var/lib/forge/work/run-today/report.md")
        box.succeed("test -f /var/lib/forge/work/run-today/vendored.txt")
  '';
}
