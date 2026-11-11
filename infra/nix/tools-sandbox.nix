{
  lib,
  stdenv,
  testers,
  writeShellScript,
  writeShellScriptBin,
  writeText,
  runCommand,
  bash,
  coreutils,
  curl,
  gcc,
  gnused,
  nodejs,
  openssl,
  claude-code,
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
  gitShim = "${commandBroker}/libexec/forge-git";
  anthropicPort = "8123";
  longPrompt = "scenario longprompt ${marker} ${lib.concatStrings (lib.genList (_: "wrangler dev ") 20000)}";

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

  claudeScenarioSet = {
    inherit (scenarioSet) signals background userns orphans loader;
    stop = [
      {
        command = "sleep 300 & sleep 301 & wait";
        timeout = 2000;
      }
      "sleep 1; ${procps}/bin/pgrep -f 'sleep 30[01]' > leftover.out; echo done > stopped.out; true"
    ];
    dead = [
      {
        command = "echo started > started.out; sleep 600";
        timeout = 600000;
      }
    ];
    filter = [ "echo finished > filter-finished.out" ];
    startup = [
      {
        tool = "Write";
        input = {
          file_path = "/var/empty/.bashrc";
          content = "cat /proc/1/comm >> startup-ran.out\n";
        };
      }
      {
        tool = "Write";
        input = {
          file_path = "/var/empty/.bash_profile";
          content = "cat /proc/1/comm >> startup-ran.out\n";
        };
      }
      {
        tool = "Write";
        input = {
          file_path = "/var/empty/.profile";
          content = "cat /proc/1/comm >> startup-ran.out\n";
        };
      }
      "echo one > bash-one.out"
      {
        tool = "Write";
        input = {
          file_path = "/var/empty/.bashrc";
          content = "cat /proc/1/comm >> startup-ran.out; echo again\n";
        };
      }
      "echo two > bash-two.out"
    ];
    planted = [
      "mkdir -p .claude && printf '%s' '{\"env\":{\"LD_PRELOAD\":\"/nonexistent.so\"},\"apiKeyHelper\":\"cat /proc/1/comm >> helper-ran.out\",\"hooks\":{\"PreToolUse\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"cat /proc/1/comm >> hook-ran.out\"}]}]}}' > .claude/settings.json"
      "printf '%s' '{\"mcpServers\":{\"planted\":{\"command\":\"sh\",\"args\":[\"-c\",\"cat /proc/1/comm >> mcp-ran.out\"]}}}' > .mcp.json"
      "echo after-planting > planted-after.out"
      "echo and-again > planted-again.out"
    ];
    longprompt = [
      "${procps}/bin/pkill -f 'wrangler dev'; echo $? > pkill.out"
      "echo alive > long-alive.out"
    ];
  };

  claudeScenarios = writeText "claude-scenarios.json" (builtins.toJSON claudeScenarioSet);

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

  fakeAnthropic = writeText "fake-anthropic.mjs" ''
    import { createServer } from 'node:http';
    import { readFileSync, writeFileSync } from 'node:fs';
    const scenarios = JSON.parse(readFileSync('${claudeScenarios}', 'utf8'));
    const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const reply = (id, blocks, stop) => [
      { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-opus-4-5', content: [], stop_reason: null, usage } },
      ...blocks.flatMap((block, index) => [
        { type: 'content_block_start', index, content_block: block.start },
        { type: 'content_block_delta', index, delta: block.delta },
        { type: 'content_block_stop', index },
      ]),
      { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ];
    const textBlock = (text) => ({ start: { type: 'text', text: ''' }, delta: { type: 'text_delta', text } });
    const toolBlock = (id, name, input) => ({ start: { type: 'tool_use', id, name, input: {} }, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
    const send = (response, id, events) => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': id.replace(/^msg_/, 'req_') });
      for (const event of events) response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
      response.end();
    };
    let served = 0;
    createServer((request, response) => {
      let body = ''';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        if (!request.url.startsWith('/v1/messages')) {
          response.setHeader('content-type', 'application/json');
          response.end('{}');
          return;
        }
        served += 1;
        const id = 'msg_scripted_' + served;
        const chat = JSON.parse(body);
        const first = chat.messages.find((message) => message.role === 'user');
        const parts = typeof first.content === 'string' ? [first.content] : first.content.map((part) => part.text ?? ''');
        const text = parts.find((part) => /scenario \w+/.test(part));
        if (text === undefined) {
          send(response, id, reply(id, [textBlock('ok')], 'end_turn'));
          return;
        }
        const name = /scenario (\w+)/.exec(text)[1];
        writeFileSync('/tmp/anthropic-prompt-' + name, String(text.length));
        const steps = scenarios[name];
        const answered = chat.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((part) => part.type === 'tool_result').length;
        if (answered >= steps.length) {
          send(response, id, reply(id, [textBlock('done')], 'end_turn'));
          return;
        }
        const step = steps[answered];
        const call = typeof step === 'string' ? { name: 'Bash', input: { command: step } } : step.tool !== undefined ? { name: step.tool, input: step.input } : { name: 'Bash', input: step };
        send(response, id, reply(id, [toolBlock('toolu_' + answered, call.name, call.input)], 'tool_use'));
      });
    }).listen(${anthropicPort}, '127.0.0.1');
  '';

  filterScript = writeShellScript "planted-filter" ''
    cat /proc/1/comm >> filter.out
    kill -TERM -1
    kill -KILL -1
    cat
  '';

  trustingClaude = writeShellScriptBin "claude" ''
    export ANTHROPIC_BASE_URL=http://127.0.0.1:${anthropicPort}
    export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
    if [ "''${1-}" = --version ]; then
      exec ${lib.getExe claude-code} "$@"
    fi
    prompt=$(cat)
    scenario=$(printf '%s' "$prompt" | ${gnused}/bin/sed -n 's/.*scenario \([a-z]*\).*/\1/p' | ${coreutils}/bin/head -n 1)
    ${util-linux}/bin/unshare -U true 2> harness-userns.err
    echo $? > harness-userns.status
    LD_PRELOAD=${loaderTraps}/trap.so BASH_ENV=${loaderTraps}/trap.sh ${client} -c 'echo "[$LD_PRELOAD][$BASH_ENV]" > client.out'
    echo $? > client.status
    LD_PRELOAD=${loaderTraps}/trap.so BASH_ENV=${loaderTraps}/trap.sh ${gitShim}/git --version > shim.out 2> shim.err
    echo $? > shim.status
    if [ ! -e /tmp/ld-preload-ran ] && [ ! -e /tmp/bash-env-ran ]; then echo clean > harness-traps.out; fi
    LD_PRELOAD=${loaderTraps}/trap.so ${coreutils}/bin/true
    if [ -e /tmp/ld-preload-ran ]; then rm /tmp/ld-preload-ran; echo preload-works > harness-traps-control.out; fi
    BASH_ENV=${loaderTraps}/trap.sh ${bash}/bin/bash -c true
    if [ -e /tmp/bash-env-ran ]; then rm /tmp/bash-env-ran; echo bash-env-works >> harness-traps-control.out; fi
    if [ "$scenario" = filter ]; then
      git init -q -b main . > /dev/null 2>&1
      echo one > tracked.txt
      git add tracked.txt > /dev/null 2>&1
      git -c user.name=planted -c user.email=planted@example.com commit -q -m one > /dev/null 2>&1
      git config filter.planted.clean ${filterScript}
      echo '* filter=planted' > .gitattributes
      ${coreutils}/bin/touch tracked.txt
    fi
    printf '%s' "$prompt" | ${lib.getExe claude-code} "$@"
  '';

  trustingPi = writeShellScriptBin "pi" ''
    export NODE_EXTRA_CA_CERTS=${openRouterCertificate}/cert.pem
    exec ${lib.getExe pi-coding-agent} "$@"
  '';

  scenarioNames = builtins.attrNames scenarioSet;
  claudeScenarioNames = builtins.attrNames claudeScenarioSet;
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
    systemd.services.fake-anthropic = {
      wantedBy = [ "multi-user.target" ];
      serviceConfig.ExecStart = "${lib.getExe nodejs} ${fakeAnthropic}";
    };
    systemd.services."forge-runner@".environment.NODE_EXTRA_CA_CERTS =
      "${openRouterCertificate}/cert.pem";
    forge.runtime.secretsFile = secretsFile;
    forge.runtime.package = forge-runner;
    forge.runtime.harnesses.pi.command = lib.getExe trustingPi;
    forge.runtime.harnesses.claude-code = {
      command = lib.getExe trustingClaude;
      args = [
        "--name"
        marker
      ];
    };
    forge.runtime.workload.maxCost = null;
    forge.runtime.workers =
      lib.genAttrs scenarioNames (name: {
        harness = "pi";
        model = "stub/tools";
        prompt = "scenario ${name} ${marker}";
      })
      // lib.listToAttrs (
        map (name: {
          name = "claude-${name}";
          value = {
            harness = "claude-code";
            model = "claude-opus-4-5";
            prompt = if name == "longprompt" then longPrompt else "scenario ${name} ${marker}";
          };
        }) claudeScenarioNames
      );
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
        box.wait_until_fails("pgrep -x forge-broker")
        box.wait_until_fails("pgrep -f '[f]orge-tools-'")

    box.wait_for_unit("multi-user.target")
    box.wait_for_open_port(443)
    box.wait_for_open_port(${anthropicPort})

    def signals_do_not_reach(prefix, label):
        worker = prefix + "signals"
        box.succeed(f"systemctl start --no-block forge-runner@{worker}")
        box.wait_until_succeeds("pgrep -f '${markerPattern}'", timeout=120)
        harness = box.succeed("pgrep -n -f '${markerPattern}'").strip()
        box.wait_until_succeeds(f"test -n \"$(sqlite3 /var/lib/forge/forge.db \"select id from runs where worker = '{worker}'\")\"")
        box.wait_until_succeeds(f"test -e {run_dir_of(worker)}/ready.out", timeout=120)
        box.succeed(f"echo {harness} > {run_dir_of(worker)}/harness-pid")
        wait_for_finish(worker)
        assert database(f"select status from runs where worker = '{worker}'") == "success", (label, database(f"select status, error from runs where worker = '{worker}'"))
        assert output_of(worker, "after-signals.out") == "alive"
        assert_nothing_left_running()

    def background_survives(prefix, label):
        run(prefix + "background")
        assert database(f"select status from runs where worker = '{prefix}background'") == "success", label
        assert output_of(prefix + "background", "served.out") == "hello"
        box.wait_until_fails("pgrep -f '[h]ttp.server 8124'")
        assert_nothing_left_running()

    def no_user_namespaces(prefix, label):
        run(prefix + "userns")
        assert output_of(prefix + "userns", "userns.status") != "0", label
        assert "No space left on device" in output_of(prefix + "userns", "userns.err")
        assert_nothing_left_running()

    def stopping_stops_the_group(prefix, label):
        run(prefix + "stop")
        assert database(f"select status from runs where worker = '{prefix}stop'") == "success", label
        assert output_of(prefix + "stop", "stopped.out") == "done"
        assert output_of(prefix + "stop", "leftover.out") == ""
        assert_nothing_left_running()

    def orphans_are_reaped(prefix, label):
        run(prefix + "orphans")
        assert database(f"select status from runs where worker = '{prefix}orphans'") == "success", label
        assert output_of(prefix + "orphans", "zombies.out") == "0"
        assert_nothing_left_running()

    def loader_variables_are_ignored(prefix, label):
        run(prefix + "loader")
        assert database(f"select status from runs where worker = '{prefix}loader'") == "success", label
        assert output_of(prefix + "loader", "control.out") == "preload-works\nbash-env-works"
        assert output_of(prefix + "loader", "client.status") == "0"
        assert output_of(prefix + "loader", "client.out") == "ran"
        assert output_of(prefix + "loader", "traps.out") == "clean"
        assert_nothing_left_running()

    def a_dead_broker_fails_the_run(prefix, label):
        worker = prefix + "dead"
        box.succeed(f"systemctl start --no-block forge-runner@{worker}")
        box.wait_until_succeeds("pgrep -x forge-broker", timeout=120)
        box.wait_until_succeeds(f"cat {run_dir_of(worker)}/started.out", timeout=120)
        box.succeed("pkill -KILL -x forge-broker")
        wait_for_finish(worker, timeout=90)
        assert database(f"select status from runs where worker = '{worker}'") == "error", label
        assert "tools sandbox" in database(f"select error from runs where worker = '{worker}'"), database(f"select error from runs where worker = '{worker}'")
        assert_nothing_left_running()

    with subtest("pi: a command's signals cannot reach the harness, the broker or later commands"):
        signals_do_not_reach("", "pi")

    with subtest("pi: a background server survives between commands and is gone when the run ends"):
        background_survives("", "pi")

    with subtest("pi: a command cannot create a user namespace"):
        no_user_namespaces("", "pi")

    with subtest("pi: stopping a command at pi's timeout stops its whole group"):
        stopping_stops_the_group("", "pi")

    with subtest("pi: orphans that exit are reaped"):
        orphans_are_reaped("", "pi")

    with subtest("pi: the client and the broker ignore loader and shell variables"):
        loader_variables_are_ignored("", "pi")

    with subtest("pi: a dead broker fails the run, naming the tools sandbox, long before its timeout"):
        a_dead_broker_fails_the_run("", "pi")

    with subtest("claude-code: a command's signals, including one on a word in claude's own command line, cannot reach the harness, the broker or later commands"):
        signals_do_not_reach("claude-", "claude-code")

    with subtest("claude-code: a background server survives between commands and is gone when the run ends"):
        background_survives("claude-", "claude-code")

    with subtest("claude-code: neither a command nor the harness can create a user namespace"):
        no_user_namespaces("claude-", "claude-code")
        assert output_of("claude-userns", "harness-userns.status") != "0"
        assert "No space left on device" in output_of("claude-userns", "harness-userns.err")

    with subtest("claude-code: stopping a command at claude's timeout stops its whole group"):
        stopping_stops_the_group("claude-", "claude-code")

    with subtest("claude-code: orphans that exit are reaped"):
        orphans_are_reaped("claude-", "claude-code")

    with subtest("claude-code: the commands ignore loader and shell variables, and so do the client and the git shim that claude hands them"):
        loader_variables_are_ignored("claude-", "claude-code")
        assert output_of("claude-loader", "harness-traps-control.out") == "preload-works\nbash-env-works"
        assert output_of("claude-loader", "harness-traps.out") == "clean"
        assert output_of("claude-loader", "client.status") == "0"
        assert output_of("claude-loader", "client.out") == "[][]"
        assert output_of("claude-loader", "shim.status") == "0"
        assert output_of("claude-loader", "shim.out").startswith("git version")

    with subtest("claude-code: a git filter driver in the checkout runs only inside the tools sandbox, and the harness survives a filter that signals every process it can"):
        run("claude-filter")
        assert database("select status from runs where worker = 'claude-filter'") == "success", database("select status, error from runs where worker = 'claude-filter'")
        ran = output_of("claude-filter", "filter.out").splitlines()
        assert len(ran) > 0 and set(ran) == {"forge-broker"}, ran
        assert output_of("claude-filter", "filter-finished.out") == "finished"
        assert_nothing_left_running()

    with subtest("claude-code: startup files the agent writes with the Write tool never run beside the harness, before or after its first command"):
        run("claude-startup")
        assert database("select status from runs where worker = 'claude-startup'") == "success", database("select status, error from runs where worker = 'claude-startup'")
        assert output_of("claude-startup", "bash-one.out") == "one"
        assert output_of("claude-startup", "bash-two.out") == "two"
        box.fail(f"test -e {run_dir_of('claude-startup')}/startup-ran.out")
        assert_nothing_left_running()

    with subtest("claude-code: settings, hooks, an API key helper and an MCP server the agent plants in the checkout never run"):
        run("claude-planted")
        assert database("select status from runs where worker = 'claude-planted'") == "success", database("select status, error from runs where worker = 'claude-planted'")
        assert output_of("claude-planted", "planted-after.out") == "after-planting"
        assert output_of("claude-planted", "planted-again.out") == "and-again"
        for marker_file in ["hook-ran.out", "helper-ran.out", "mcp-ran.out"]:
            box.fail(f"test -e {run_dir_of('claude-planted')}/{marker_file}")
        assert_nothing_left_running()

    with subtest("claude-code: a prompt larger than a command-line argument arrives whole, and a pkill on its words leaves the run going"):
        run("claude-longprompt")
        assert database("select status from runs where worker = 'claude-longprompt'") == "success", database("select status, error from runs where worker = 'claude-longprompt'")
        assert int(box.succeed("cat /tmp/anthropic-prompt-longprompt").strip()) >= ${toString (builtins.stringLength longPrompt)}
        assert output_of("claude-longprompt", "long-alive.out") == "alive"
        assert_nothing_left_running()

    with subtest("claude-code: a dead broker fails the run, naming the tools sandbox, long before its timeout"):
        a_dead_broker_fails_the_run("claude-", "claude-code")
  '';
}
