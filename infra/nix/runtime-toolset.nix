{
  lib,
  testers,
  writeShellScript,
  forge-runner,
  sopsModule,
  secretsFile,
  secretsHostKey,
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
      sopsModule
      ../nixos/runtime.nix
      extra
    ];
    system.activationScripts.hostKey.text = ''
      install -D -m 0600 ${secretsHostKey} /etc/ssh/ssh_host_ed25519_key
    '';
    system.activationScripts.setupSecrets.deps = [ "hostKey" ];
    sops.age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];
    forge.runtime.secretsFile = secretsFile;
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

  nodes.replaced = box "hello && ! command -v git && ! command -v find" (
    { pkgs, ... }:
    {
      forge.runtime.toolset = [
        pkgs.bash
        pkgs.hello
      ];
    }
  );

  testScript = ''
    def run_probe(machine):
        machine.wait_for_unit("multi-user.target")
        status, _ = machine.execute("systemctl start forge-runner@probe")
        _, out = machine.execute("cat /var/lib/forge/work/*/toolset.out")
        machine.shutdown()
        assert status == 0, f"the probe failed with output: {out}"
        return out

    with subtest("a workload can run shell commands with the default toolset"):
        out = run_probe(base)
        assert "git version" in out, out
        assert "ripgrep" in out, out

    with subtest("operators can extend the toolset"):
        out = run_probe(extended)
        assert "git version" in out, out
        assert "Hello, world!" in out, out

    with subtest("operators can replace the toolset"):
        out = run_probe(replaced)
        assert "Hello, world!" in out, out
  '';
}
