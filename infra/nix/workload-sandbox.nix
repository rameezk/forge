{
  lib,
  stdenv,
  testers,
  writeShellScriptBin,
  bash,
  coreutils,
  writeText,
  util-linux,
  curl,
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

  runawayBuild = writeText "runaway.nix" ''
    let
      bash = builtins.storePath "${bash}";
      coreutils = builtins.storePath "${coreutils}";
    in
    derivation {
      name = "runaway";
      system = "${system}";
      builder = "''${bash}/bin/bash";
      args = [ "-c" "''${coreutils}/bin/tail /dev/zero" ];
    }
  '';

  fineBuild = writeText "fine.nix" ''
    derivation {
      name = "fine";
      system = "${system}";
      builder = builtins.storePath "${bash}" + "/bin/bash";
      args = [ "-c" "echo fine > $out" ];
    }
  '';

  stubHarness = writeShellScriptBin "stub-harness" ''
    set -u
    attempt() {
      if bash -c "$2" > /dev/null 2>&1; then echo "$1 allowed"; else echo "$1 denied"; fi
    }
    environment='for name in PATH LOCALE_ARCHIVE TZDIR LANG; do printf "%s=%s\n" "$name" "''${!name-}"; done'
    tools='for tool in gh git cat; do if command -v "$tool" > /dev/null; then echo "$tool resolved"; else echo "$tool missing"; fi; done'
    case "''${@: -1}" in
      plant)
        echo '[credential]' > "$HOME/.gitconfig" && echo planted > planted.out
        echo planted > /tmp/planted
        ;;
      linger)
        sleep 600
        ;;
      hog)
        bash -c 'tail /dev/zero'
        echo "$?" > hog.out
        ;;
      build)
        nix build --offline --impure --no-link -f ${runawayBuild} > build.log 2>&1
        echo "$?" > build.out
        nix build --offline --impure --no-link -f ${fineBuild} > build-after.log 2>&1
        echo "$?" > build-after.out
        ;;
      pair*)
        bash -c 'x=$(head -c 160000000 /dev/zero | tr "\\0" a); sleep 600'
        echo "$?" > pair.out
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
          attempt "read app id" "cat /run/secrets/rendered/forge-github-app.env"
          attempt "read app private key" "cat /run/secrets/github_app_private_key"
          attempt "read credentials" "ls /run/credentials"
          attempt "write root" "touch /planted"
          attempt "write etc" "touch /etc/planted"
          attempt "write store" "touch /nix/store/planted"
          attempt "write state dir" "touch /var/lib/forge/planted"
          attempt "read agent dir" "test -d \"\$PI_CODING_AGENT_DIR\""
          attempt "write agent dir" "touch \"\$PI_CODING_AGENT_DIR/planted\""
          attempt "find planted gitconfig" "test -e $HOME/.gitconfig"
          attempt "find planted tmp" "test -e /tmp/planted"
          attempt "write home" "touch $HOME/scratch"
          attempt "write tmp" "touch /tmp/scratch"
          attempt "write run directory" "echo inside > inside.out"
          attempt "see dashboard socket" "test -e /run/forge-frontend/dashboard.sock"
          attempt "reach tailnet address" "{ : <> /dev/tcp/100.100.100.100/443; }"
          attempt "create user namespace" "${lib.getExe' util-linux "unshare"} --user true 2> userns.err"
        } > sandbox.out
        for port in $(seq 1 65535); do
          if { : <> "/dev/tcp/127.0.0.1/$port"; } 2> /dev/null; then echo "$port"; fi
        done > loopback-open.out
        env | cut -d= -f1 | sort > env.out
        bash -c "$environment" > harness-environment.out
        bash -l -c "$environment; $tools" > login-shell.out
        bash -c "$environment; $tools" > non-login-shell.out
        test -n "''${OPENROUTER_API_KEY-}" && echo present > openrouter.out
        for process in /proc/[0-9]*; do cat "$process/comm"; done > processes.out 2>/dev/null
        mkdir flake
        cp ${flake} flake/flake.nix
        printf '#!${bash}/bin/bash\necho ran through the nix daemon\n' > flake/hello
        chmod +x flake/hello
        nix --offline run "path:$PWD/flake" > nix.out 2>&1
        nix store info >> nix.out 2>&1
        echo '{"type":"request","body":{"probe":"crossed the sandbox"},"cacheMarkers":[]}' >&"$FORGE_PI_REQUEST_RECORD_FD"
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
    environment.systemPackages = [ curl ];
    forge.runtime.secretsFile = secretsFile;
    forge.runtime.package = forge-runner;
    forge.runtime.harnesses.pi.command = lib.getExe stubHarness;
    forge.runtime.workload.maxCost = null;
    forge.runtime.workers =
      lib.genAttrs [ "plant" "linger" "hog" "build" "pair1" "pair2" ] (name: {
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
      on.ticket = "probe";
    };
  };
in
testers.runNixOSTest {
  name = "workload-sandbox";

  nodes.box = box {
    boot.kernel.sysctl."vm.panic_on_oom" = 0;
    forge.runtime.workload.sharedMemoryMax = "256M";
  };

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

    with subtest("a command that exhausts the workload's memory is killed alone, and the workload carries on"):
        box.succeed("systemctl start forge-runner@hog")
        assert box.succeed("cat /var/lib/forge/work/*/hog.out").strip() == "137"
        status = box.succeed("sqlite3 /var/lib/forge/forge.db \"select status from runs where worker = 'hog'\"").strip()
        assert status == "success", status
        kill = box.succeed("dmesg | grep oom-kill:")
        assert "constraint=CONSTRAINT_MEMCG" in kill and "forge-runner@hog.service" in kill, kill

    with subtest("a runaway nix daemon build is killed inside the shared budget, and the daemon and the box carry on"):
        box.succeed("dmesg --clear")
        box.succeed("systemctl start forge-runner@build")
        assert box.succeed("cat /var/lib/forge/work/*/build.out").strip() != "0"
        assert box.succeed("cat /var/lib/forge/work/*/build-after.out").strip() == "0"
        status = box.succeed("sqlite3 /var/lib/forge/forge.db \"select status from runs where worker = 'build'\"").strip()
        assert status == "success", status
        kill = box.succeed("dmesg | grep oom-kill:")
        assert "constraint=CONSTRAINT_MEMCG" in kill and "oom_memcg=/forge.slice/forge-workloads.slice" in kill and "nix-daemon.service" in kill, kill
        box.succeed("systemctl is-active nix-daemon.service forge-frontend.service sshd.service")

    with subtest("workloads running at once are killed together inside the shared budget, and the box carries on"):
        box.succeed("dmesg --clear")
        box.succeed("systemctl start --no-block forge-runner@pair1 forge-runner@pair2")
        box.wait_until_succeeds("cat /var/lib/forge/work/*/pair.out | grep -qx 137", timeout=120)
        box.succeed("systemctl stop forge-runner@pair1 forge-runner@pair2")
        kill = box.succeed("dmesg | grep oom-kill:")
        assert "oom_memcg=/forge.slice/forge-workloads.slice" in kill and "CONSTRAINT_NONE" not in kill, kill
        box.succeed("systemctl is-active forge-frontend.service sshd.service")

    box.succeed("install -d -o forge-runtime -g forge-runtime /var/lib/forge/work/other-run")
    box.succeed("runuser -u forge-runtime -- sh -c 'echo report > /var/lib/forge/work/other-run/report.md'")
    box.succeed("systemctl start --no-block forge-runner@linger")
    box.wait_until_succeeds("pgrep -u forge-runtime -x sleep")
    box.succeed("systemctl start forge-runner@probe")

    def linger_run(columns):
        return box.succeed(f"sqlite3 -separator '|' /var/lib/forge/forge.db \"select {columns} from runs where worker = 'linger'\"").strip()

    with subtest("a running workload's runner keeps its heartbeat fresh"):
        box.wait_until_succeeds("test -n \"$(sqlite3 /var/lib/forge/forge.db \"select alive_at from runs where worker = 'linger'\")\"", timeout=60)

    box.succeed("systemctl stop forge-runner@linger")

    with subtest("a run whose runner stopped without finishing ends as interrupted when billing next runs"):
        assert linger_run("status") == "running", linger_run("status")
        box.succeed("runuser -u forge-runtime -- sqlite3 /var/lib/forge/forge.db \"update runs set alive_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 minutes') where worker = 'linger'\"")
        last_seen = linger_run("alive_at")
        box.succeed("systemctl start forge-billing.service")
        ended = linger_run("status, end_time, error, cost_status")
        assert ended == f"interrupted|{last_seen}|runner stopped without finishing, last seen at {last_seen}|unconfirmed", ended

    run_dir = run_dir_of(box, "sandbox.out")
    seen = attempts(box, run_dir)

    with subtest("the harness cannot reach forge state"):
        for name in ["read forge.db", "list transcripts", "read another run", "write forge.db", "write transcripts", "write another run"]:
            assert seen[name] == "denied", (name, seen)
        box.fail("grep -q tampered /var/lib/forge/forge.db")
        box.fail("test -e /var/lib/forge/transcripts/planted.jsonl")
        box.fail("test -e /var/lib/forge/work/other-run/planted")
        assert box.succeed("cat /var/lib/forge/work/other-run/report.md").strip() == "report"

    with subtest("the dashboard is up on its socket, and the harness can neither see it nor reach it over loopback or the tailnet"):
        dashboard_socket = "/run/forge-frontend/dashboard.sock"
        page = box.succeed(f"runuser -u forge-runtime -- curl -fsS --unix-socket {dashboard_socket} http://dashboard/workloads")
        assert "Workloads" in page, page
        assert seen["see dashboard socket"] == "denied", seen
        assert seen["reach tailnet address"] == "denied", seen
        listening = box.succeed("ss -Htlnp")
        assert "forge" not in listening and "node" not in listening, listening
        answered = set(box.succeed(f"cat {run_dir}/loopback-open.out").split())
        listening_ports = {line.split()[3].rsplit(":", 1)[1] for line in listening.splitlines()}
        ephemeral_from = int(box.succeed("cut -f1 /proc/sys/net/ipv4/ip_local_port_range"))
        unexplained = {port for port in answered if int(port) < ephemeral_from and port not in listening_ports}
        assert not unexplained, (unexplained, listening)
        assert "7787" not in answered, answered

    with subtest("the harness cannot read secret files, and still holds the OpenRouter key"):
        for name in ["read secrets", "read runner key", "read app id", "read app private key", "read credentials"]:
            assert seen[name] == "denied", (name, seen)
        assert box.succeed(f"cat {run_dir}/openrouter.out").strip() == "present"

    with subtest("the harness can only write its own run directory"):
        assert seen["write run directory"] == "allowed", seen
        assert box.succeed(f"cat {run_dir}/inside.out").strip() == "inside"
        for name in ["write root", "write etc", "write store", "write state dir"]:
            assert seen[name] == "denied", (name, seen)
        box.fail("test -e /var/lib/forge/planted")
        box.fail("test -e /etc/planted")

    with subtest("the harness sees its own per-run agent dir and cannot write to it"):
        assert seen["read agent dir"] == "allowed", seen
        assert seen["write agent dir"] == "denied", seen
        box.fail("ls /var/lib/forge/agent/*/planted")

    with subtest("nothing planted in HOME or /tmp survives into a later workload"):
        assert seen["find planted gitconfig"] == "denied", seen
        assert seen["find planted tmp"] == "denied", seen
        assert seen["write home"] == "allowed", seen
        assert seen["write tmp"] == "allowed", seen
        box.fail("test -e /var/empty/.gitconfig")
        box.fail("test -e /var/empty/scratch")

    with subtest("the harness cannot create nested user namespaces"):
        assert seen["create user namespace"] == "denied", seen
        refusal = box.succeed(f"cat {run_dir}/userns.err")
        assert "No space left on device" in refusal, refusal

    with subtest("the harness sees neither the runner nor any other workload"):
        processes = box.succeed(f"cat {run_dir}/processes.out").split()
        assert "stub-harness" in processes, processes
        assert "node" not in processes, processes
        assert "sleep" not in processes, processes
        assert "systemd" not in processes, processes

    resolved = "gh resolved\ngit resolved\ncat resolved\n"
    given = box.succeed(f"cat {run_dir}/harness-environment.out")
    login = box.succeed(f"cat {run_dir}/login-shell.out")
    non_login = box.succeed(f"cat {run_dir}/non-login-shell.out")

    with subtest("a login shell keeps the environment the runner gave the workload, and finds its tools"):
        values = dict(line.split("=", 1) for line in given.splitlines())
        assert all(values.get(name) for name in ["PATH", "LOCALE_ARCHIVE", "TZDIR", "LANG"]), given
        assert login == given + resolved, login

    with subtest("a non-login shell sees the same environment as a login shell"):
        assert non_login == login, (non_login, login)

    with subtest("the harness receives only deliberate credentials"):
        names = set(box.succeed(f"cat {run_dir}/env.out").split())
        deliberate = {
            "__NIXOS_SET_ENVIRONMENT_DONE",
            "FORGE_PI_REQUEST_RECORD_FD",
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

    with subtest("the harness's request record leaves the sandbox into the state directory, not its run directory"):
        run_id = run_dir.rsplit("/", 1)[1]
        record = box.succeed(f"cat /var/lib/forge/transcripts/{run_id}.requests.jsonl")
        assert "crossed the sandbox" in record, record
        box.fail(f"ls {run_dir} | grep -q requests")

    with subtest("the agent can nix run a flake from its path, through the daemon socket"):
        out = box.succeed(f"cat {run_dir}/nix.out")
        assert "ran through the nix daemon" in out, out
        store_info = out.split("ran through the nix daemon", 1)[1]
        assert "Store URL: daemon" in store_info, out
        assert "Trusted: 0" in store_info, out

    box.shutdown()

    unconfinable.wait_for_unit("multi-user.target")

    with subtest("a sandbox that cannot start fails the workload, and the harness never runs, the tools sandbox being the first to start"):
        unconfinable.fail("systemctl start forge-runner@probe")
        unconfinable.fail("ls /var/lib/forge/work/*/sandbox.out")
        error = unconfinable.succeed("sqlite3 /var/lib/forge/forge.db 'select error from runs'").strip()
        assert error.startswith("the tools sandbox could not start: bwrap:"), error
  '';
}
