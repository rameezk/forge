{
  testers,
  runCommand,
  symlinkJoin,
  writeShellScriptBin,
  writeText,
  nodejs,
  forge-runner,
  sopsModule,
  secretsFile,
  secretsHostKey,
}:
let
  ticket = number: forgeReady: blocked: {
    inherit number forgeReady blocked;
    title = "Ticket ${toString number}";
    url = "https://github.com/rameezk/forge/issues/${toString number}";
    parent = null;
    createdAt = "2026-09-28T10:00:${toString number}Z";
  };

  snapshot = writeText "snapshot.mjs" ''
    import { Store } from '${forge-runner}/lib/forge-runtime/packages/shared/src/index.ts';
    const store = Store.open('/var/lib/forge/forge.db');
    store.replaceFrontier(${
      builtins.toJSON {
        repository = "forge";
        github = "rameezk/forge";
        polledAt = "2026-09-29T08:00:00.000Z";
        tickets = [
          (ticket 13 true false)
          (ticket 14 true true)
          (ticket 15 false false)
        ];
      }
    });
    store.close();
  '';

  runtime = symlinkJoin {
    name = "forge-runtime-automatic-dispatch";
    paths = [
      (writeShellScriptBin "forge-frontier" ''
        exec ${nodejs}/bin/node ${snapshot}
      '')
      (writeShellScriptBin "forge-dispatch" ''
        echo "$@" > "/var/lib/forge/dispatched-$1-$2"
      '')
      (writeShellScriptBin "forge-frontend" ''
        exec sleep infinity
      '')
      (runCommand "forge-dispatch-pass" { } ''
        mkdir -p $out/bin
        ln -s ${forge-runner}/bin/forge-dispatch-pass $out/bin/forge-dispatch-pass
      '')
    ];
  };
in
testers.runNixOSTest {
  name = "automatic-dispatch";

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
    systemd.timers.forge-frontier-sync.enable = false;
    forge.runtime.secretsFile = secretsFile;
    forge.runtime.package = runtime;
    forge.runtime.harnesses.pi.command = "/run/current-system/sw/bin/pi";
    forge.runtime.workers.builder = {
      harness = "pi";
      model = "stub/dispatch";
      prompt = "/work-on {url}";
    };
    forge.runtime.repositories.forge = {
      github = "rameezk/forge";
      worker = "builder";
    };
    forge.runtime.repositories.notes.github = "rameezk/notes";
    forge.runtime.dispatch.gitIdentity = {
      name = "Forge Operator";
      email = "operator@example.com";
    };
  };

  testScript = ''
    as_runtime = "runuser -u forge-runtime -- systemctl --no-ask-password"

    box.wait_for_unit("multi-user.target")

    with subtest("a frontier sync is followed by a pass that dispatches only the forge:ready frontier ticket, through its forge-dispatch unit"):
        box.succeed("systemctl start forge-frontier-sync.service")
        box.wait_until_succeeds("test \"$(systemctl show -P Result forge-dispatch@forge:13.service)\" = success")
        assert box.succeed("cat /var/lib/forge/dispatched-forge-13").strip() == "forge 13"
        assert box.succeed("systemctl show -P Result forge-dispatch-pass.service").strip() == "success"
        box.fail("test -e /var/lib/forge/dispatched-forge-14")
        box.fail("test -e /var/lib/forge/dispatched-forge-15")

    with subtest("forge-runtime may start a forge-dispatch unit of a repository that declares a worker, and nothing else"):
        box.succeed(f"{as_runtime} start forge-dispatch@forge:7.service")
        assert box.succeed("cat /var/lib/forge/dispatched-forge-7").strip() == "forge 7"
        box.fail(f"{as_runtime} start forge-dispatch@notes:7.service")
        box.fail(f"{as_runtime} start forge-dispatch@forge:07.service")
        box.fail(f"{as_runtime} start forge-runner@builder.service")
        box.fail(f"{as_runtime} stop forge-frontend.service")
        box.fail(f"{as_runtime} restart forge-dispatch@forge:7.service")
        box.fail("runuser -u nobody -- systemctl --no-ask-password start forge-dispatch@forge:8.service")
  '';
}
