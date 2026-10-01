{
  lib,
  stdenv,
  testers,
  writeShellScript,
  bash,
  nix,
  forge-runner,
  sopsModule,
  secretsFile,
  secretsHostKey,
}:
let
  system = stdenv.hostPlatform.system;

  flake = builtins.toFile "flake.nix" ''
    {
      outputs = { self }: {
        apps.${system}.default = {
          type = "app";
          program = "''${self}/hello";
        };
      };
    }
  '';

  stubHarness = writeShellScript "stub-harness" ''
    set -u
    attempt() {
      if bash -c "$2" > /dev/null 2>&1; then echo "$1 allowed"; else echo "$1 denied"; fi
    }
    case "''${@: -1}" in
      plant)
        echo '[credential]' > "$HOME/.gitconfig" && echo planted > planted.out
        echo planted > /tmp/planted
        ;;
      linger)
        sleep 600
        ;;
      probe*)
        {
          attempt "read forge.db" "cat /var/lib/forge/forge.db"
          attempt "list transcripts" "ls /var/lib/forge/transcripts"
          attempt "read another run" "cat /var/lib/forge/work/other-run/report.md"
          attempt "write forge.db" "echo tampered >> /var/lib/forge/forge.db"
          attempt "write transcripts" "touch /var/lib/forge/transcripts/planted.jsonl"
          attempt "write another run" "touch /var/lib/forge/work/other-run/planted"
          attempt "read secrets" "ls /run/secrets"
          attempt "read runner key" "cat /run/secrets/rendered/forge-runner.env"
          attempt "read frontier token" "cat /run/secrets/rendered/forge-github.env"
          attempt "read write token" "cat /run/secrets/rendered/forge-github-write.env"
          attempt "read credentials" "ls /run/credentials"
          attempt "write root" "touch /planted"
          attempt "write etc" "touch /etc/planted"
          attempt "write store" "touch /nix/store/planted"
          attempt "write state dir" "touch /var/lib/forge/planted"
          attempt "find planted gitconfig" "test -e $HOME/.gitconfig"
          attempt "find planted tmp" "test -e /tmp/planted"
          attempt "write home" "touch $HOME/scratch"
          attempt "write tmp" "touch /tmp/scratch"
          attempt "write run directory" "echo inside > inside.out"
        } > sandbox.out
        env | cut -d= -f1 | sort > env.out
        test -n "''${OPENROUTER_API_KEY-}" && echo present > openrouter.out
        for process in /proc/[0-9]*; do cat "$process/comm"; done > processes.out 2>/dev/null
        mkdir flake
        cp ${flake} flake/flake.nix
        printf '#!${bash}/bin/bash\necho ran through the nix daemon\n' > flake/hello
        chmod +x flake/hello
        ${lib.getExe nix} --extra-experimental-features 'nix-command flakes' --offline run "path:$PWD/flake" > nix.out 2>&1
        ${lib.getExe nix} --extra-experimental-features nix-command store info >> nix.out 2>&1
        ;;
    esac
    echo '{"type":"agent_start"}'
    echo '{"type":"agent_end","willRetry":false}'
  '';

  box = extra: {
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
    forge.runtime.harnesses.pi.command = "${stubHarness}";
    forge.runtime.workers =
      lib.genAttrs [ "plant" "linger" ] (name: {
        harness = "pi";
        model = "stub/sandbox";
        prompt = name;
      })
      // {
        probe = {
          harness = "pi";
          model = "stub/sandbox";
          prompt = "probe {issue}";
        };
      };
    forge.runtime.repositories.forge = {
      github = "rameezk/forge";
      worker = "probe";
    };
    forge.runtime.dispatch.gitIdentity = {
      name = "Forge Operator";
      email = "operator@example.com";
    };
  };
in
testers.runNixOSTest {
  name = "workload-sandbox";

  nodes.box = box { };

  nodes.unconfinable = box {
    boot.kernel.sysctl."user.max_user_namespaces" = 0;
  };

  testScript = ''
    def run_dir_of(machine, report):
        return machine.succeed(f"dirname /var/lib/forge/work/*/{report}").strip()

    def attempts(machine, run_dir):
        return dict(
            line.rsplit(" ", 1)
            for line in machine.succeed(f"cat {run_dir}/sandbox.out").splitlines()
        )

    box.wait_for_unit("multi-user.target")

    with subtest("a workload can write its HOME and /tmp"):
        box.succeed("systemctl start forge-runner@plant")
        assert box.succeed("cat /var/lib/forge/work/*/planted.out").strip() == "planted"

    box.succeed("install -d -o forge-runtime -g forge-runtime /var/lib/forge/work/other-run")
    box.succeed("runuser -u forge-runtime -- sh -c 'echo report > /var/lib/forge/work/other-run/report.md'")
    box.succeed("systemctl start --no-block forge-runner@linger")
    box.wait_until_succeeds("pgrep -u forge-runtime -x sleep")
    box.succeed("systemctl start forge-runner@probe")
    box.succeed("systemctl stop forge-runner@linger")

    run_dir = run_dir_of(box, "sandbox.out")
    seen = attempts(box, run_dir)

    with subtest("the harness cannot reach forge state"):
        for name in ["read forge.db", "list transcripts", "read another run", "write forge.db", "write transcripts", "write another run"]:
            assert seen[name] == "denied", (name, seen)
        box.fail("grep -q tampered /var/lib/forge/forge.db")
        box.fail("test -e /var/lib/forge/transcripts/planted.jsonl")
        box.fail("test -e /var/lib/forge/work/other-run/planted")
        assert box.succeed("cat /var/lib/forge/work/other-run/report.md").strip() == "report"

    with subtest("the harness cannot read secret files, and still holds the OpenRouter key"):
        for name in ["read secrets", "read runner key", "read frontier token", "read write token", "read credentials"]:
            assert seen[name] == "denied", (name, seen)
        assert box.succeed(f"cat {run_dir}/openrouter.out").strip() == "present"

    with subtest("the harness can only write its own run directory"):
        assert seen["write run directory"] == "allowed", seen
        assert box.succeed(f"cat {run_dir}/inside.out").strip() == "inside"
        for name in ["write root", "write etc", "write store", "write state dir"]:
            assert seen[name] == "denied", (name, seen)
        box.fail("test -e /var/lib/forge/planted")
        box.fail("test -e /etc/planted")

    with subtest("nothing planted in HOME or /tmp survives into a later workload"):
        assert seen["find planted gitconfig"] == "denied", seen
        assert seen["find planted tmp"] == "denied", seen
        assert seen["write home"] == "allowed", seen
        assert seen["write tmp"] == "allowed", seen
        box.fail("test -e /var/empty/.gitconfig")
        box.fail("test -e /var/empty/scratch")

    with subtest("the harness sees neither the runner nor any other workload"):
        processes = box.succeed(f"cat {run_dir}/processes.out").split()
        assert "stub-harness" in processes, processes
        assert "node" not in processes, processes
        assert "sleep" not in processes, processes
        assert "systemd" not in processes, processes

    with subtest("the harness receives only deliberate credentials"):
        names = set(box.succeed(f"cat {run_dir}/env.out").split())
        deliberate = {
            "FORGE_PI_SUBAGENT_INVOCATION",
            "HOME",
            "LANG",
            "LOCALE_ARCHIVE",
            "OPENROUTER_API_KEY",
            "PATH",
            "PI_CODING_AGENT_DIR",
            "TZDIR",
        }
        shell = {"OLDPWD", "PWD", "SHLVL", "_"}
        assert names <= deliberate | shell, names - deliberate - shell

    with subtest("the agent can use nix through the daemon socket"):
        out = box.succeed(f"cat {run_dir}/nix.out")
        assert "ran through the nix daemon" in out, out
        assert "daemon" in out.split("ran through the nix daemon", 1)[1], out

    box.shutdown()

    unconfinable.wait_for_unit("multi-user.target")

    with subtest("a sandbox that cannot start fails the workload, and the harness never runs"):
        unconfinable.fail("systemctl start forge-runner@probe")
        unconfinable.fail("ls /var/lib/forge/work/*/sandbox.out")
        error = unconfinable.succeed("sqlite3 /var/lib/forge/forge.db 'select error from runs'").strip()
        assert error.startswith("the workload sandbox could not start: bwrap:"), error
  '';
}
