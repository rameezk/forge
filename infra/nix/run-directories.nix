{ testers }:
testers.runNixOSTest {
  name = "run-directories";

  nodes.box = {
    imports = [ ../nixos/runtime.nix ];
  };

  testScript = ''
    box.wait_for_unit("multi-user.target")

    with subtest("old run directories age out and recent ones remain"):
        for run in ["run-old", "run-today"]:
            box.succeed(f"install -d -o forge-runtime -g forge-runtime /var/lib/forge/work/{run}")
            box.succeed(f"runuser -u forge-runtime -- sh -c 'echo report > /var/lib/forge/work/{run}/report.md'")
        box.succeed("touch -d '15 days ago' /var/lib/forge/work/run-old/report.md /var/lib/forge/work/run-old")

        box.succeed("systemctl start systemd-tmpfiles-clean.service")

        box.fail("test -e /var/lib/forge/work/run-old")
        box.succeed("test -f /var/lib/forge/work/run-today/report.md")
  '';
}
