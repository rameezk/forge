{
  lib,
  testers,
  writeText,
  nodejs,
  curl,
  forge-runner,
  sopsModule,
  secretsFile,
  secretsHostKey,
}:
let
  writeToStore = writeText "write-to-store.mjs" ''
    import { Store } from '${forge-runner}/lib/forge-runtime/packages/shared/src/index.ts';
    const store = Store.openReadOnly('/var/lib/forge/forge.db');
    try {
      store.replaceFrontier({
        repository: 'forge',
        github: 'rameezk/forge',
        polledAt: '2026-09-29T08:00:00.000Z',
        closed: [],
        requests: [],
        tickets: [],
      });
      console.log('insert-succeeded');
    } catch (error) {
      console.log(`insert-refused: ''${error.message}`);
    }
    store.close();
  '';
in
testers.runNixOSTest {
  name = "dashboard-reach";

  nodes.box =
    { pkgs, ... }:
    {
      imports = [
        sopsModule
        ../nixos/runtime.nix
      ];
      system.activationScripts.hostKey.text = ''
        install -D -m 0600 ${secretsHostKey} /etc/ssh/ssh_host_ed25519_key
      '';
      system.activationScripts.setupSecrets.deps = [ "hostKey" ];
      sops.age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];
      environment.systemPackages = [
        curl
        nodejs
        pkgs.util-linux
      ];
      forge.runtime.secretsFile = secretsFile;
      forge.runtime.package = forge-runner;
      forge.runtime.harnesses.pi.command = "/run/current-system/sw/bin/pi";
      forge.runtime.workers.builder = {
        harness = "pi";
        model = "stub/reach";
        prompt = "/work-on {url}";
      };
    };

  testScript = ''
    state = "/var/lib/forge"

    def in_dashboard(command):
        pid = box.succeed("systemctl show -P MainPID forge-frontend.service").strip()
        uid = box.succeed("id -u forge-runtime").strip()
        gid = box.succeed("id -g forge-runtime").strip()
        return f"nsenter -t {pid} -m -S {uid} -G {gid} -- sh -c {command!r}"

    socket = "/run/forge-frontend/dashboard.sock"

    def fetch(path):
        return f"runuser -u forge-runtime -- curl -fsS --unix-socket {socket} http://dashboard{path}"

    box.wait_for_unit("forge-frontend.service")

    with subtest("forge-migrate creates forge.db before the dashboard starts, and the dashboard serves its home page"):
        box.succeed(f"test -f {state}/forge.db")
        migrated = int(box.succeed("systemctl show -P ActiveEnterTimestampMonotonic forge-migrate.service"))
        served = int(box.succeed("systemctl show -P ActiveEnterTimestampMonotonic forge-frontend.service"))
        assert migrated <= served, f"forge-migrate became active at {migrated}, after the dashboard at {served}"
        box.wait_until_succeeds(fetch("/workloads"))

    with subtest("the dashboard serves the Runs page through its socket from outside its sandbox, and listens on no TCP port"):
        assert "Runs" in box.succeed(fetch("/workloads")), "the Runs page was not served"
        box.succeed(f"test -S {socket}")
        assert box.succeed(f"stat -c '%a %U' {socket.rsplit('/', 1)[0]}").strip() == "700 forge-runtime"
        box.fail("ss -Htln | grep -q 7787")
        box.fail(f"curl -sS --max-time 5 http://127.0.0.1:7787/")

    box.succeed(f"runuser -u forge-runtime -- sh -c 'echo transcript > {state}/transcripts/run-01.jsonl'")
    box.succeed(f"runuser -u forge-runtime -- sh -c 'mkdir -p {state}/work/run-01 {state}/agent/run-01 && echo report > {state}/work/run-01/report.md && echo auth > {state}/agent/run-01/auth.json'")

    with subtest("the dashboard reads transcripts but cannot modify or create files there"):
        assert "transcript" in box.succeed(in_dashboard(f"cat {state}/transcripts/run-01.jsonl"))
        box.fail(in_dashboard(f"echo changed >> {state}/transcripts/run-01.jsonl"))
        box.fail(in_dashboard(f"touch {state}/transcripts/created.jsonl"))
        box.succeed(f"test ! -e {state}/transcripts/created.jsonl")
        assert box.succeed(f"cat {state}/transcripts/run-01.jsonl").strip() == "transcript"

    with subtest("the dashboard cannot list or read run or agent directories"):
        box.fail(in_dashboard(f"ls {state}/work"))
        box.fail(in_dashboard(f"cat {state}/work/run-01/report.md"))
        box.fail(in_dashboard(f"ls {state}/agent"))
        box.fail(in_dashboard(f"cat {state}/agent/run-01/auth.json"))

    with subtest("the dashboard's store connection refuses writes and leaves forge.db unchanged"):
        dump = f"sqlite3 {state}/forge.db .dump | sha256sum"
        before = box.succeed(dump)
        out = box.succeed(in_dashboard("node ${writeToStore}"))
        assert "insert-refused" in out, f"the dashboard's store accepted a write: {out}"
        assert box.succeed(dump) == before
  '';
}
