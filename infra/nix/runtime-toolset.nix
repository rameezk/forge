{
  lib,
  testers,
  writeShellScript,
  forge-runner,
}:
let
  stubHarness =
    probe:
    writeShellScript "stub-harness" ''
      set -eu
      sh -c ${lib.escapeShellArg probe} > toolset.out
      echo '{"type":"agent_start"}'
      echo '{"type":"agent_end","willRetry":false}'
    '';

  box = probe: extra: {
    imports = [
      ../nixos/runtime.nix
      extra
    ];
    forge.runtime.package = forge-runner;
    forge.runtime.harnesses.pi.command = "${stubHarness probe}";
    forge.runtime.workers.probe = {
      harness = "pi";
      model = "stub/toolset";
      prompt = "probe the workload toolset";
    };
  };
in
testers.runNixOSTest {
  name = "runtime-toolset";

  nodes.base = box "git --version && rg --version" { };

  nodes.extended = box "git --version && hello" (
    { options, pkgs, ... }:
    {
      forge.runtime.toolset = options.forge.runtime.toolset.default ++ [ pkgs.hello ];
    }
  );

  testScript = ''
    start_all()

    def run_probe(machine):
        machine.wait_for_unit("multi-user.target")
        machine.succeed("install -m 0600 -o forge-runtime -g forge-runtime /dev/null /var/lib/forge/openrouter.env")
        machine.succeed("systemctl start forge-runner@probe")
        return machine.succeed("cat /var/lib/forge/work/*/toolset.out")

    with subtest("a workload can run shell commands with the default toolset"):
        out = run_probe(base)
        assert "git version" in out, out
        assert "ripgrep" in out, out

    with subtest("operators can extend the toolset"):
        out = run_probe(extended)
        assert "git version" in out, out
        assert "Hello, world!" in out, out
  '';
}
