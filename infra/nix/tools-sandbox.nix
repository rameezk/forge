{
  lib,
  stdenv,
  testers,
  writeShellScriptBin,
  writeText,
  runCommand,
  bash,
  coreutils,
  curl,
  gcc,
  nodejs,
  openssl,
  pi-coding-agent,
  pkgsStatic,
  procps,
  python3,
  util-linux,
  forge-runner,
  sopsModule,
  secretsFile,
  secretsHostKey,
}:
let
  marker = "marker-0f3a9c";
  markerPattern = "[m]arker-0f3a9c";
  commandBroker = pkgsStatic.callPackage ./command-broker.nix { };
  client = "${commandBroker}/bin/forge-shell";

  openRouterCertificate = runCommand "fake-openrouter-certificate" { nativeBuildInputs = [ openssl ]; } ''
    mkdir $out
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
      -subj /CN=openrouter.ai -addext subjectAltName=DNS:openrouter.ai \
      -keyout $out/key.pem -out $out/cert.pem
  '';

  loaderTraps = runCommand "loader-traps" { nativeBuildInputs = [ gcc ]; } ''
    mkdir $out
    cat > trap.c <<'TRAP'
    #include <stdio.h>
    __attribute__((constructor)) static void ran(void) {
      FILE *marker = fopen("/tmp/ld-preload-ran", "w");
      if (marker) fclose(marker);
    }
    TRAP
    gcc -shared -fPIC -o $out/trap.so trap.c
    echo 'touch /tmp/bash-env-ran' > $out/trap.sh
  '';

  scenarioSet = {
    signals = [
      "echo ready > ready.out"
      "${procps}/bin/pkill -f '${markerPattern}'; echo $? > pkill.out"
      "kill -TERM -1; true"
      "kill -KILL -1; true"
      "until [ -s harness-pid ]; do sleep 0.2; done; kill -TERM $(cat harness-pid); true"
      "kill -KILL 1; kill -TERM 1; kill -INT 1; kill -HUP 1; true"
      "echo alive > after-signals.out"
    ];
    background = [
      "echo hello > /tmp/hello.txt; cd /tmp && nohup ${python3}/bin/python3 -m http.server 8124 --bind 127.0.0.1 > /tmp/server.log 2>&1 &"
      "for attempt in $(seq 50); do ${curl}/bin/curl -fs http://127.0.0.1:8124/hello.txt > served.out && break; sleep 0.2; done; true"
    ];
    userns = [
      "${util-linux}/bin/unshare -U true 2> userns.err; echo $? > userns.status; true"
    ];
    stop = [
      {
        command = "sleep 300 & sleep 301 & wait";
        timeout = 2;
      }
      "sleep 1; ${procps}/bin/pgrep -f 'sleep 30[01]' > leftover.out; echo done > stopped.out; true"
    ];
    orphans = [
      "for i in 1 2 3 4 5; do (sleep 0.1 &); done; true"
      "sleep 1; ${procps}/bin/ps -eo stat= | grep -c '^Z' > zombies.out; true"
    ];
    loader = [
      "LD_PRELOAD=${loaderTraps}/trap.so ${coreutils}/bin/true; test -e /tmp/ld-preload-ran && rm /tmp/ld-preload-ran && echo preload-works > control.out"
      "BASH_ENV=${loaderTraps}/trap.sh ${bash}/bin/bash -c true; test -e /tmp/bash-env-ran && rm /tmp/bash-env-ran && echo bash-env-works >> control.out"
      "LD_PRELOAD=${loaderTraps}/trap.so BASH_ENV=${loaderTraps}/trap.sh ${client} -c 'echo ran > client.out'; echo $? > client.status"
      "if [ ! -e /tmp/ld-preload-ran ] && [ ! -e /tmp/bash-env-ran ]; then echo clean > traps.out; fi"
    ];
    dead = [ "echo started > started.out; sleep 600" ];
  };

  scenarios = writeText "scenarios.json" (builtins.toJSON scenarioSet);

  fakeOpenRouter = writeText "fake-openrouter.mjs" ''
    import { createServer } from 'node:https';
    import { readFileSync } from 'node:fs';
    const scenarios = JSON.parse(readFileSync('${scenarios}', 'utf8'));
    const frame = (response, data) => response.write('data: ' + JSON.stringify(data) + '\n\n');
    createServer(
      { key: readFileSync('${openRouterCertificate}/key.pem'), cert: readFileSync('${openRouterCertificate}/cert.pem') },
      (request, response) => {
        let body = ''';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
          if (request.method === 'GET') {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ data: [] }));
            return;
          }
          const chat = JSON.parse(body);
          const first = chat.messages.find((message) => message.role === 'user');
          const text = typeof first.content === 'string' ? first.content : first.content.map((part) => part.text ?? ''').join(''');
          const name = /scenario (\w+)/.exec(text)[1];
          const steps = scenarios[name];
          const answered = chat.messages.filter((message) => message.role === 'tool').length;
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          const base = { id: 'gen-' + name + '-' + answered, object: 'chat.completion.chunk', created: 0, model: chat.model };
          if (answered < steps.length) {
            const step = steps[answered];
            const args = typeof step === 'string' ? { command: step } : step;
            frame(response, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: ''', tool_calls: [{ index: 0, id: 'call_' + answered, type: 'function', function: { name: 'bash', arguments: JSON.stringify(args) } }] }, finish_reason: null }] });
            frame(response, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
          } else {
            frame(response, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }] });
            frame(response, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          }
          frame(response, { ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
          response.end('data: [DONE]\n\n');
        });
      },
    ).listen(443, '127.0.0.1');
  '';

  trustingPi = writeShellScriptBin "pi" ''
    export NODE_EXTRA_CA_CERTS=${openRouterCertificate}/cert.pem
    exec ${lib.getExe pi-coding-agent} "$@"
  '';

  scenarioNames = builtins.attrNames scenarioSet;
in
testers.runNixOSTest {
  name = "tools-sandbox";

  nodes.box = {
    imports = [
      sopsModule
      ../nixos/runtime.nix
    ];
    system.activationScripts.hostKey.text = ''
      install -D -m 0600 ${secretsHostKey} /etc/ssh/ssh_host_ed25519_key
    '';
    system.activationScripts.setupSecrets.deps = [ "hostKey" ];
    sops.age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];
    networking.hosts."127.0.0.1" = [ "openrouter.ai" ];
    systemd.services.fake-openrouter = {
      wantedBy = [ "multi-user.target" ];
      serviceConfig.ExecStart = "${lib.getExe nodejs} ${fakeOpenRouter}";
    };
    systemd.services."forge-runner@".environment.NODE_EXTRA_CA_CERTS =
      "${openRouterCertificate}/cert.pem";
    forge.runtime.secretsFile = secretsFile;
    forge.runtime.package = forge-runner;
    forge.runtime.harnesses.pi.command = lib.getExe trustingPi;
    forge.runtime.workload.maxCost = null;
    forge.runtime.workers = lib.genAttrs scenarioNames (name: {
      harness = "pi";
      model = "stub/tools";
      prompt = "scenario ${name} ${marker}";
    });
  };

  testScript = ''
    def database(query):
        return box.succeed(f"sqlite3 -separator '|' /var/lib/forge/forge.db \"{query}\"").strip()

    def run_dir_of(worker):
        return "/var/lib/forge/work/" + database(f"select id from runs where worker = '{worker}'")

    def output_of(worker, name):
        return box.succeed(f"cat {run_dir_of(worker)}/{name}").strip()

    def wait_for_finish(worker, timeout=180):
        box.wait_until_succeeds(f"[ \"$(systemctl show -p ActiveState --value forge-runner@{worker})\" != activating ]", timeout=timeout)

    def run(worker):
        box.succeed(f"systemctl start forge-runner@{worker}")

    def assert_nothing_left_running():
        box.fail("pgrep -x forge-broker")
        box.fail("pgrep -f '[f]orge-tools-'")

    box.wait_for_unit("multi-user.target")
    box.wait_for_open_port(443)

    with subtest("a command's signals cannot reach the harness, the broker or later commands"):
        box.succeed("systemctl start --no-block forge-runner@signals")
        box.wait_until_succeeds("pgrep -f '${markerPattern}'", timeout=120)
        harness = box.succeed("pgrep -n -f '${markerPattern}'").strip()
        box.wait_until_succeeds("test -n \"$(sqlite3 /var/lib/forge/forge.db \"select id from runs where worker = 'signals'\")\"")
        box.succeed(f"echo {harness} > {run_dir_of('signals')}/harness-pid")
        wait_for_finish("signals")
        assert database("select status from runs where worker = 'signals'") == "success", database("select status, error from runs where worker = 'signals'")
        assert output_of("signals", "after-signals.out") == "alive"
        assert_nothing_left_running()

    with subtest("a background server survives between commands and is gone when the run ends"):
        run("background")
        assert database("select status from runs where worker = 'background'") == "success"
        assert output_of("background", "served.out") == "hello"
        box.fail("pgrep -f '[h]ttp.server 8124'")
        assert_nothing_left_running()

    with subtest("a command cannot create a user namespace"):
        run("userns")
        assert output_of("userns", "userns.status") != "0"
        assert "No space left on device" in output_of("userns", "userns.err")
        assert_nothing_left_running()

    with subtest("stopping a command at pi's timeout stops its whole group"):
        run("stop")
        assert database("select status from runs where worker = 'stop'") == "success"
        assert output_of("stop", "stopped.out") == "done"
        assert output_of("stop", "leftover.out") == ""
        assert_nothing_left_running()

    with subtest("orphans that exit are reaped"):
        run("orphans")
        assert database("select status from runs where worker = 'orphans'") == "success"
        assert output_of("orphans", "zombies.out") == "0"
        assert_nothing_left_running()

    with subtest("the client and the broker ignore loader and shell variables"):
        run("loader")
        assert database("select status from runs where worker = 'loader'") == "success"
        assert output_of("loader", "control.out") == "preload-works\nbash-env-works"
        assert output_of("loader", "client.status") == "0"
        assert output_of("loader", "client.out") == "ran"
        assert output_of("loader", "traps.out") == "clean"
        box.fail("test -e /tmp/ld-preload-ran")
        box.fail("test -e /tmp/bash-env-ran")
        assert_nothing_left_running()

    with subtest("a dead broker fails the run, naming the tools sandbox, long before its timeout"):
        box.succeed("systemctl start --no-block forge-runner@dead")
        box.wait_until_succeeds("pgrep -x forge-broker", timeout=120)
        box.wait_until_succeeds("cat /var/lib/forge/work/*/started.out", timeout=120)
        box.succeed("pkill -KILL -x forge-broker")
        wait_for_finish("dead", timeout=90)
        assert database("select status from runs where worker = 'dead'") == "error"
        assert "tools sandbox" in database("select error from runs where worker = 'dead'"), database("select error from runs where worker = 'dead'")
        assert_nothing_left_running()
  '';
}
