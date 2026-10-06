{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.forge.runtime;

  forgeGitShaVariable = lib.optional (cfg.gitSha != null) "FORGE_GIT_SHA=${cfg.gitSha}";

  timeSpanUnits = {
    s = 1;
    sec = 1;
    second = 1;
    seconds = 1;
    m = 60;
    min = 60;
    minute = 60;
    minutes = 60;
    h = 3600;
    hr = 3600;
    hour = 3600;
    hours = 3600;
    d = 86400;
    day = 86400;
    days = 86400;
    w = 604800;
    week = 604800;
    weeks = 604800;
  };
  maxTimeSpanSeconds = 2147483;
  timeSpanPart = "([0-9]+)[[:space:]]*([a-z]+)";
  timeSpanParts =
    value:
    if builtins.match "[[:space:]]*([0-9]+)[[:space:]]*" value != null then
      [
        [
          (lib.head (builtins.match "[[:space:]]*([0-9]+)[[:space:]]*" value))
          "s"
        ]
      ]
    else if builtins.match "[[:space:]]*(${timeSpanPart}[[:space:]]*)+" value != null then
      lib.filter builtins.isList (builtins.split timeSpanPart value)
    else
      [ ];
  timeSpanSeconds =
    value:
    lib.foldl' (total: part: total + lib.toInt (lib.elemAt part 0) * timeSpanUnits.${lib.elemAt part 1}) 0 (
      timeSpanParts value
    );
  isTimeSpan =
    value:
    let
      parts = timeSpanParts value;
    in
    parts != [ ] && lib.all (part: timeSpanUnits ? ${lib.elemAt part 1}) parts && timeSpanSeconds value > 0
    && timeSpanSeconds value <= maxTimeSpanSeconds;
  timeSpan = lib.types.addCheck lib.types.str isTimeSpan // {
    description = "systemd time span of whole seconds, minutes, hours, days or weeks, at most 2147483 seconds, just under 25 days, such as \"2h\" or \"1h 30min\"";
  };

  positiveNumber = lib.types.addCheck lib.types.number (value: value > 0) // {
    description = "positive number";
  };

  harnessModule = lib.types.submodule {
    options = {
      command = lib.mkOption {
        type = lib.types.strMatching "/.+";
        description = "Executable that runs this harness headlessly and emits its event stream. It must be an absolute path, and it is resolved to its real path before the workload sandbox starts, so it must resolve into the Nix store.";
      };
      args = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = "Operator extra arguments for the harness, passed after the invocation the runner builds and before the prompt. The runner owns the harness's own CLI contract. The harness runs in the workload sandbox, so any path an argument names must be in the Nix store.";
      };
    };
  };

  workerModule = lib.types.submodule {
    options = {
      harness = lib.mkOption {
        type = lib.types.str;
        description = "Name of the harness this worker binds to.";
      };
      model = lib.mkOption {
        type = lib.types.str;
        description = "Model the harness runs, as the provider addresses it.";
      };
      prompt = lib.mkOption {
        type = lib.types.lines;
        description = "Prompt the worker runs on. It must not start with `-` or `@`, which the harness would parse as an option or a file; the runner rejects such a worker.";
      };
      reasoningEffort = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.enum (lib.importJSON ../../runtime/packages/runner/src/reasoning-efforts.json)
        );
        default = null;
        description = "Reasoning effort, or null to run at the provider default.";
      };
      maxCost = lib.mkOption {
        type = lib.types.nullOr positiveNumber;
        default = cfg.workload.maxCost;
        defaultText = lib.literalExpression "config.forge.runtime.workload.maxCost";
        example = 2.5;
        description = "Most this worker's workload may spend, subagents included, as a positive number of USD, or null for unlimited. Spend is each generation's billed cost where known and its estimated cost otherwise, checked after every generation, so a workload can overshoot it by the generations in flight. A workload that passes it is hard-stopped and ends as exceeded, and one whose model's list price cannot be fetched at start is refused before it spends anything. Defaults to `forge.runtime.workload.maxCost`.";
      };
      timeout = lib.mkOption {
        type = lib.types.nullOr timeSpan;
        default = cfg.workload.timeout;
        defaultText = lib.literalExpression "config.forge.runtime.workload.timeout";
        example = "30min";
        description = "Longest this worker's workload may run, as a systemd time span of whole seconds, minutes, hours, days or weeks such as `\"2h\"`, or null for unlimited. It counts from the harness's start, so checkout and devShell setup do not use it, and a workload that passes it is hard-stopped, its subagents included, and ends as exceeded. A scheduled run's systemd unit also stops 30 minutes past it, as a backstop for a runner that hangs, and the run then ends interrupted; dispatched workloads share one backstop from the longest timeout of any dispatching worker, and none when any of them is unlimited. Defaults to `forge.runtime.workload.timeout`.";
      };
    };
  };

  repositoryModule = lib.types.submodule {
    options = {
      github = lib.mkOption {
        type = lib.types.strMatching "[A-Za-z0-9-]+/[A-Za-z0-9._-]+";
        example = "rameezk/forge";
        description = "The repository on GitHub as `owner/name`, whose issues track its tickets.";
      };
      worker = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "builder";
        description = "Worker that `forge-dispatch` runs against this repository's tickets, in a fresh clone of its default branch, or null to only poll its frontier. Its prompt is a template filled in for each ticket: `{repo}` becomes the repository's `owner/name`, `{issue}` the ticket's number and `{url}` its URL, and it must hold `{issue}` or `{url}`. A leading `/<name>` runs the checkout's skill of that name, and the dispatch fails if the checkout has none. If the checkout has a `flake.nix`, the workload runs in its flake's default devShell for the box's system: its variables apply over the box's locale and under forge's deliberate ones (the GitHub and OpenRouter credentials, the git environment and pi's own), its path comes ahead of the workload toolset, and the dispatch fails if nix cannot print it, including when the flake has no `devShells.<system>.default`.";
      };
    };
  };

  gitIdentityModule = lib.types.submodule {
    options = {
      name = lib.mkOption {
        type = lib.types.str;
        example = "Forge";
        description = "Name a dispatched workload's commits carry as their git author and committer.";
      };
      email = lib.mkOption {
        type = lib.types.str;
        example = "forge@example.com";
        description = "Email a dispatched workload's commits carry as their git author and committer.";
      };
    };
  };

  runtimeConfig = {
    harnesses = lib.mapAttrs (_: h: { inherit (h) command args; }) cfg.harnesses;
    workers = lib.mapAttrs (
      _: w:
      {
        inherit (w) harness model prompt;
        timeoutSeconds = if w.timeout == null then null else timeSpanSeconds w.timeout;
        maxCostUsd = w.maxCost;
      }
      // lib.optionalAttrs (w.reasoningEffort != null) { inherit (w) reasoningEffort; }
    ) cfg.workers;
    repositories = lib.mapAttrs (
      _: r: { inherit (r) github; } // lib.optionalAttrs (r.worker != null) { inherit (r) worker; }
    ) cfg.repositories;
  }
  // lib.optionalAttrs (hasDispatch || cfg.dispatch.gitIdentity != null) {
    dispatch = {
      inherit (cfg.dispatch) maxConcurrent;
    }
    // lib.optionalAttrs (cfg.dispatch.gitIdentity != null) { inherit (cfg.dispatch) gitIdentity; };
  };

  runtimeConfigFile = pkgs.writeText "forge-runtime.json" (builtins.toJSON runtimeConfig);

  hasWorkers = cfg.workers != { };
  hasRepositories = cfg.repositories != { };
  hasDashboard = hasWorkers || hasRepositories;
  dispatchedRepositories = lib.filterAttrs (_: r: r.worker != null) cfg.repositories;
  hasDispatch = dispatchedRepositories != { };

  backstopMarginSeconds = 30 * 60;
  backstopSeconds = w: if w.timeout == null then null else timeSpanSeconds w.timeout + backstopMarginSeconds;
  startTimeout = seconds: lib.optionalAttrs (seconds != null) { TimeoutStartSec = seconds; };
  scheduledBackstops = lib.mapAttrs' (
    name: w:
    lib.nameValuePair "forge-runner@${name}" {
      overrideStrategy = "asDropin";
      path = lib.mkForce cfg.toolset;
      serviceConfig.TimeoutStartSec = backstopSeconds w;
    }
  ) (lib.filterAttrs (_: w: w.timeout != null) cfg.workers);
  dispatchingBackstops = map (r: backstopSeconds cfg.workers.${r.worker}) (
    lib.attrValues dispatchedRepositories
  );
  dispatchBackstop =
    if lib.elem null dispatchingBackstops || dispatchingBackstops == [ ] then
      null
    else
      lib.foldl' lib.max 0 dispatchingBackstops;

  hasTicketPlaceholder = prompt: lib.hasInfix "{issue}" prompt || lib.hasInfix "{url}" prompt;

  gitIdentityAssertion = {
    assertion = !hasDispatch || cfg.dispatch.gitIdentity != null;
    message = "forge.runtime.dispatch.gitIdentity must be set when a repository declares a worker: dispatched workloads commit as that identity";
  };

  workerNameAssertions = lib.mapAttrsToList (name: _: {
    assertion = builtins.match "[A-Za-z0-9_-]+" name != null;
    message = "forge.runtime.workers.${name} must have a name of only letters, digits, `_` and `-`: it names the unit instance forge-runner@${name} and its backstop drop-in";
  }) cfg.workers;

  dispatchAssertions = lib.concatLists (
    lib.mapAttrsToList (
      name: r:
      let
        option = "forge.runtime.repositories.${name}.worker";
        declared = cfg.workers ? ${r.worker};
      in
      [
        {
          assertion = builtins.match "[A-Za-z0-9_-]+" name != null;
          message = "forge.runtime.repositories.${name} declares a worker, so its name must use only letters, digits, `_` and `-`: it names the repository in forge-dispatch and its unit";
        }
        {
          assertion = declared;
          message = "${option} names undeclared worker '${r.worker}'";
        }
        {
          assertion = !declared || hasTicketPlaceholder cfg.workers.${r.worker}.prompt;
          message = "worker '${r.worker}', named by ${option}, has no ticket placeholder: its prompt must hold {issue} or {url}";
        }
      ]
    ) dispatchedRepositories
  );

  runtimeUser = config.users.users.${cfg.user};
  runtimeGroups = lib.unique (
    [ runtimeUser.group ]
    ++ lib.attrNames (lib.filterAttrs (_: group: lib.elem cfg.user group.members) config.users.groups)
  );
  runtimeTrustNames = [
    cfg.user
    "*"
  ]
  ++ map (group: "@${group}") runtimeGroups;

  trustedUsers =
    lib.concatMap
      (entry: lib.filter (name: lib.isString name && name != "") (builtins.split "[[:space:]]+" entry))
      (config.nix.settings.trusted-users ++ lib.toList (config.nix.settings.extra-trusted-users or [ ]));
  extraOptionsSetTrust = lib.any (
    line: builtins.match "[[:space:]]*(extra-)?trusted-users[[:space:]]*=.*" line != null
  ) (lib.splitString "\n" config.nix.extraOptions);

  untrustedAssertion = {
    assertion =
      !(lib.any (name: lib.elem name runtimeTrustNames) trustedUsers) && !extraOptionsSetTrust;
    message = "${cfg.user} must never be a trusted nix user, by name, by group or through a wildcard in nix.settings.trusted-users or nix.settings.extra-trusted-users, and nix.extraOptions must not set either, since evaluation cannot check it there: a trusted user can add unsigned paths and change substituters, so one workload could plant a tool for a later one through the store";
  };

  dispatchUnitPattern = "^forge-dispatch@(?:${lib.concatStringsSep "|" (lib.attrNames dispatchedRepositories)}):[1-9][0-9]*\\.service$";

  dispatchInstance = pkgs.writeShellScript "forge-dispatch-instance" ''
    exec ${cfg.package}/bin/forge-dispatch "''${1%:*}" "''${1##*:}"
  '';

  openRouterEnvFiles = [
    "forge-runner.env"
    "forge-billing.env"
  ];
  envFile = name: config.sops.templates.${name}.path;
  envTemplate = variable: secret: {
    content = "${variable}=${config.sops.placeholder.${secret}}\n";
    owner = cfg.user;
    mode = "0400";
  };

  writeTokenCredentialId = "github-write-token";
  writeTokenCredential = {
    LoadCredential = [ "${writeTokenCredentialId}:${envFile "forge-github-write.env"}" ];
  };
  writeTokenFileVariable = "FORGE_GITHUB_WRITE_TOKEN_FILE=%d/${writeTokenCredentialId}";

  hardening = {
    NoNewPrivileges = true;
    ProtectSystem = "strict";
    ProtectHome = true;
    PrivateTmp = true;
    ReadWritePaths = [ cfg.stateDir ];
    RestrictSUIDSGID = true;
    ProtectKernelTunables = true;
    ProtectControlGroups = true;
    InaccessiblePaths = [
      "/run/secrets"
      "/run/secrets.d"
    ];
  };

  tailnetAddresses = [
    "100.64.0.0/10"
    "fd7a:115c:a1e0::/48"
  ];

  workloadHardening = hardening // {
    ProtectKernelTunables = false;
    IPAddressDeny = tailnetAddresses;
  };

  workloadMemory = {
    MemoryMax = cfg.workload.memoryMax;
    OOMPolicy = "continue";
  };

  baseToolset = [
    "bash"
    "coreutils"
    "findutils"
    "gnugrep"
    "gnused"
    "gawk"
    "diffutils"
    "gnutar"
    "gzip"
    "which"
    "git"
    "ripgrep"
    "jq"
    "curl"
    "gh"
  ];
in
{
  options.forge.runtime = {
    user = lib.mkOption {
      type = lib.types.str;
      default = "forge-runtime";
      readOnly = true;
      description = "Dedicated service user that owns the runtime state and runs the runner.";
    };

    gitSha = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "The git revision of forge this host was built from, set for the runner and dispatch units as FORGE_GIT_SHA so each workload records it beside its config fingerprint. Null leaves the variable unset and workloads record no revision.";
    };

    stateDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/forge";
      readOnly = true;
      description = "State directory owned by the runtime service user, holding the SQLite store, per-run transcripts and the records beside them, run directories, and the agent directories pi reads each run's model from. Run directories age out after 14 days, as do the agent directories; the SQLite store, transcripts and the records beside them are kept.";
    };

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.forge-runner;
      defaultText = lib.literalExpression "pkgs.forge-runner";
      description = "Runtime package providing the forge-run, forge-dispatch, forge-dispatch-pass, forge-billing, forge-frontier and forge-frontend entry points.";
    };

    dashboardPort = lib.mkOption {
      type = lib.types.port;
      default = 7787;
      description = "Localhost TCP port the read-only dashboard binds to; reached over the tailnet through tailscale serve, never exposed publicly.";
    };

    secretsFile = lib.mkOption {
      type = lib.types.path;
      description = "The operator's sops-encrypted runtime secrets file, decrypted on the box with its host key. It must hold `tailscale_auth_key` (the OAuth client secret the box joins the tailnet with as tag:forge) on every box, `openrouter_api_key` when any worker is declared, `github_token` (the frontier's read-only token) when any repository is declared, and `github_write_token` (the write token on Contents, Pull requests, Issues and Workflows of every managed repository) when a repository declares a worker. Only tailscaled-autoconnect reads `tailscale_auth_key`, from the decrypted file. No forge unit can see the decrypted secrets: each gets only what systemd reads for it, an EnvironmentFile or, for the write token, a credential from which forge-dispatch and the frontier sync read only GITHUB_TOKEN, as data.";
    };

    dispatch.gitIdentity = lib.mkOption {
      type = lib.types.nullOr gitIdentityModule;
      default = null;
      example = lib.literalExpression ''{ name = "Forge"; email = "forge@example.com"; }'';
      description = "Git author and committer identity of every dispatched workload, set through its environment and never written to a file. Required when any repository declares a worker. Scheduled workloads get no identity.";
    };

    dispatch.maxConcurrent = lib.mkOption {
      type = lib.types.ints.positive;
      default = 1;
      example = 2;
      description = "How many dispatched workloads may run at once, across every managed repository, whether dispatched by hand with `forge-dispatch` or by the dispatch pass that follows each frontier sync. Tickets from the same repository may run in parallel. A ticket over the limit stays `forge:ready` until a later pass finds a free slot, and a manual dispatch over it is refused.";
    };

    frontier.pollInterval = lib.mkOption {
      type = lib.types.str;
      default = "5min";
      example = "15min";
      description = "How often the frontier poller syncs the managed repositories' frontier from GitHub, as a systemd time span.";
    };

    workload.memoryMax = lib.mkOption {
      type =
        lib.types.addCheck
          (lib.types.strMatching "[0-9]+|[0-9]+(\\.[0-9]+)?[KMGTPE]|[0-9]{1,2}(\\.[0-9]{1,2})?%|100(\\.0{1,2})?%|infinity")
          (value: builtins.match "[0.]+[KMGTPE%]?" value == null);
      default = "80%";
      example = "6G";
      description = "Memory a single workload may use, harness, subagents and every command they run included, as a systemd `MemoryMax=` value: a size such as `6G`, or a percentage of the box's physical memory. A workload that goes over it has its largest process, in practice the runaway command, killed by the kernel, and carries on: the agent sees that command exit with 137. The limit is per workload, so workloads running at once can together use more, and builds the nix daemon runs for a workload fall outside it.";
    };

    workload.maxCost = lib.mkOption {
      type = lib.types.nullOr positiveNumber;
      default = 5;
      example = 10;
      description = "Most a workload may spend unless its worker overrides it, subagents included, as a positive number of USD, or null for unlimited. Spend is each generation's billed cost where known and its estimated cost otherwise, checked after every generation, so a workload can overshoot it by the generations in flight. A workload that passes it is hard-stopped and ends as exceeded, and one whose model's list price cannot be fetched at start is refused before it spends anything; a dispatched one fails its dispatch and its ticket becomes `forge:failed`, with nothing posted to it.";
    };

    workload.timeout = lib.mkOption {
      type = lib.types.nullOr timeSpan;
      default = "2h";
      example = "30min";
      description = "Longest a workload may run unless its worker overrides it, as a systemd time span of whole seconds, minutes, hours, days or weeks, or null for unlimited. It counts from the harness's start. A workload that passes it is hard-stopped, its subagents included, and ends as exceeded; a dispatched one fails its dispatch and its ticket becomes `forge:failed`, with nothing posted to it.";
    };

    toolset = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = map (name: pkgs.${name}) baseToolset ++ [ config.nix.package ];
      defaultText = lib.literalExpression "with pkgs; [ ${lib.concatStringsSep " " baseToolset} ] ++ [ config.nix.package ]";
      example = lib.literalExpression "options.forge.runtime.toolset.default ++ [ pkgs.python3 ]";
      description = "Workload toolset: the packages that make up a workload's `PATH`. It is not a limit on what a workload can run, since the Nix store and the nix daemon are reachable from the sandbox (ADR-0024, ADR-0027). A dispatched workload whose checkout has a flake gets its devShell's path ahead of these. Extend the base set with `options.forge.runtime.toolset.default ++ [ ... ]`, or set a list to replace it.";
    };

    harnesses = lib.mkOption {
      type = lib.types.attrsOf harnessModule;
      default = { };
      description = "Available harnesses, keyed by the name workers reference.";
    };

    workers = lib.mkOption {
      type = lib.types.attrsOf workerModule;
      default = { };
      description = "Declared workers, keyed by name; declaring one makes it runnable on demand.";
    };

    repositories = lib.mkOption {
      type = lib.types.attrsOf repositoryModule;
      default = { };
      example = lib.literalExpression ''{ forge.github = "rameezk/forge"; }'';
      description = "Managed repositories, keyed by a short name; declaring one makes forge poll its frontier, show it on the dashboard, and put the forge-frontier command on the path to list it on demand.";
    };

    settings = lib.mkOption {
      type = lib.types.attrs;
      readOnly = true;
      internal = true;
      default = runtimeConfig;
      description = "Structured runtime config (harnesses, workers and repositories) the runtime reads.";
    };

    configFile = lib.mkOption {
      type = lib.types.path;
      readOnly = true;
      default = runtimeConfigFile;
      defaultText = lib.literalExpression "generated from forge.runtime.harnesses, forge.runtime.workers and forge.runtime.repositories";
      description = "Generated runtime config the runner reads to resolve a worker by name and the frontier poller reads to find the managed repositories.";
    };
  };

  config = lib.mkMerge [
    {
      assertions = [
        gitIdentityAssertion
        untrustedAssertion
      ]
      ++ workerNameAssertions
      ++ dispatchAssertions;

      security.allowUserNamespaces = true;

      nix.settings.experimental-features = [
        "nix-command"
        "flakes"
      ];

      systemd.services.nix-daemon.serviceConfig.IPAddressDeny = tailnetAddresses;

      nix.gc = {
        automatic = true;
        dates = [ "weekly" ];
        options = "--delete-older-than 14d";
      };

      users.users.${cfg.user} = {
        isSystemUser = true;
        group = cfg.user;
        home = "/var/empty";
        description = "Forge runtime service user";
      };
      users.groups.${cfg.user} = { };

      systemd.tmpfiles.rules = [
        "d ${cfg.stateDir} 0750 ${cfg.user} ${cfg.user} - -"
        "d ${cfg.stateDir}/transcripts 0750 ${cfg.user} ${cfg.user} - -"
        "d ${cfg.stateDir}/work 0750 ${cfg.user} ${cfg.user} 14d -"
        "d ${cfg.stateDir}/agent 0750 ${cfg.user} ${cfg.user} 14d -"
      ];
    }

    { systemd.services = scheduledBackstops; }

    (lib.mkIf hasWorkers {
      sops.secrets.openrouter_api_key.sopsFile = cfg.secretsFile;
      sops.templates = lib.genAttrs openRouterEnvFiles (
        _: envTemplate "OPENROUTER_API_KEY" "openrouter_api_key"
      );

      systemd.services."forge-runner@" = {
        description = "Forge workload runner for worker %i";
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        path = lib.mkForce cfg.toolset;
        serviceConfig = {
          Type = "oneshot";
          User = cfg.user;
          Group = cfg.user;
          WorkingDirectory = cfg.stateDir;
          EnvironmentFile = envFile "forge-runner.env";
          Environment = [
            "FORGE_RUNTIME_CONFIG=${cfg.configFile}"
            "FORGE_STATE_DIR=${cfg.stateDir}"
          ]
          ++ forgeGitShaVariable;
          ExecStart = "${cfg.package}/bin/forge-run %i";
        }
        // workloadMemory
        // workloadHardening;
      };

      systemd.services.forge-billing = {
        description = "Forge billing: settle runs' billed cost from OpenRouter";
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        serviceConfig = {
          Type = "oneshot";
          User = cfg.user;
          Group = cfg.user;
          WorkingDirectory = cfg.stateDir;
          EnvironmentFile = envFile "forge-billing.env";
          Environment = [ "FORGE_STATE_DIR=${cfg.stateDir}" ];
          ExecStart = "${cfg.package}/bin/forge-billing";
        }
        // hardening;
      };

      systemd.timers.forge-billing = {
        description = "Settle runs' billed cost";
        wantedBy = [ "timers.target" ];
        timerConfig = {
          OnBootSec = "1min";
          OnUnitActiveSec = "1min";
        };
      };
    })

    (lib.mkIf hasRepositories {
      sops.secrets.github_token.sopsFile = cfg.secretsFile;
      sops.templates."forge-github.env" = envTemplate "GITHUB_TOKEN" "github_token";

      environment.systemPackages = [
        (pkgs.callPackage ../nix/frontier-command.nix {
          forge-runner = cfg.package;
          inherit (cfg) configFile user;
          githubTokenFile = envFile "forge-github.env";
        })
      ];

      systemd.services.forge-frontier-sync = {
        description = "Forge frontier sync from GitHub";
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        serviceConfig = {
          Type = "oneshot";
          User = cfg.user;
          Group = cfg.user;
          WorkingDirectory = cfg.stateDir;
          EnvironmentFile = envFile "forge-github.env";
          Environment = [
            "FORGE_RUNTIME_CONFIG=${cfg.configFile}"
            "FORGE_STATE_DIR=${cfg.stateDir}"
          ]
          ++ lib.optional hasDispatch writeTokenFileVariable;
          ExecStart = "${cfg.package}/bin/forge-frontier sync";
        }
        // lib.optionalAttrs hasDispatch writeTokenCredential
        // hardening;
      };

      systemd.timers.forge-frontier-sync = {
        description = "Poll the managed repositories' frontier";
        wantedBy = [ "timers.target" ];
        timerConfig = {
          OnBootSec = "1min";
          OnUnitActiveSec = cfg.frontier.pollInterval;
        };
      };
    })

    (lib.mkIf hasDispatch {
      sops.secrets.github_write_token.sopsFile = cfg.secretsFile;
      sops.templates."forge-github-write.env" = envTemplate "GITHUB_TOKEN" "github_write_token";
    })

    (lib.mkIf (hasWorkers && hasDispatch) {
      environment.systemPackages = [
        (pkgs.callPackage ../nix/dispatch-command.nix { })
      ];

      security.polkit.enable = true;
      security.polkit.extraConfig = ''
        polkit.addRule(function (action, subject) {
          if (
            action.id == "org.freedesktop.systemd1.manage-units" &&
            subject.user == "${cfg.user}" &&
            action.lookup("verb") == "start" &&
            /${dispatchUnitPattern}/.test(action.lookup("unit"))
          ) {
            return polkit.Result.YES;
          }
        });
      '';

      systemd.services.forge-frontier-sync = {
        wants = [ "forge-dispatch-pass.service" ];
        before = [ "forge-dispatch-pass.service" ];
      };

      systemd.services.forge-dispatch-pass = {
        description = "Forge dispatch pass: start a forge-dispatch@ unit for each forge:ready frontier ticket, up to dispatch.maxConcurrent";
        serviceConfig = {
          Type = "oneshot";
          User = cfg.user;
          Group = cfg.user;
          WorkingDirectory = cfg.stateDir;
          Environment = [
            "FORGE_RUNTIME_CONFIG=${cfg.configFile}"
            "FORGE_STATE_DIR=${cfg.stateDir}"
            "FORGE_SYSTEMCTL=${config.systemd.package}/bin/systemctl"
          ];
          ExecStart = "${cfg.package}/bin/forge-dispatch-pass";
          RestrictAddressFamilies = [ "AF_UNIX" ];
          IPAddressDeny = "any";
          PrivateNetwork = true;
          PrivateDevices = true;
          ProtectKernelModules = true;
          ProtectKernelLogs = true;
          ProtectClock = true;
          ProtectHostname = true;
          RestrictNamespaces = true;
          LockPersonality = true;
          CapabilityBoundingSet = "";
          SystemCallArchitectures = "native";
          SystemCallFilter = [ "@system-service" ];
        }
        // hardening;
      };

      systemd.services."forge-dispatch@" = {
        description = "Forge dispatch of ticket %i";
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        path = lib.mkForce cfg.toolset;
        serviceConfig = {
          Type = "oneshot";
          User = cfg.user;
          Group = cfg.user;
          WorkingDirectory = cfg.stateDir;
          EnvironmentFile = envFile "forge-runner.env";
          Environment = [
            "FORGE_RUNTIME_CONFIG=${cfg.configFile}"
            "FORGE_STATE_DIR=${cfg.stateDir}"
            writeTokenFileVariable
          ]
          ++ forgeGitShaVariable;
          ExecStart = "${dispatchInstance} %i";
        }
        // startTimeout dispatchBackstop
        // workloadMemory
        // writeTokenCredential
        // workloadHardening;
      };
    })

    (lib.mkIf hasDashboard {
      environment.systemPackages = [ pkgs.sqlite ];

      systemd.services.forge-frontend = {
        description = "Forge read-only workload dashboard (localhost only)";
        wantedBy = [ "multi-user.target" ];
        after = [ "network.target" ];
        serviceConfig = {
          Type = "exec";
          User = cfg.user;
          Group = cfg.user;
          WorkingDirectory = cfg.stateDir;
          Environment = [
            "FORGE_STATE_DIR=${cfg.stateDir}"
            "FORGE_FRONTEND_HOST=127.0.0.1"
            "FORGE_FRONTEND_PORT=${toString cfg.dashboardPort}"
          ];
          ExecStart = "${cfg.package}/bin/forge-frontend";
          Restart = "on-failure";

          RestrictAddressFamilies = [
            "AF_INET"
            "AF_INET6"
            "AF_UNIX"
          ];
          IPAddressAllow = "localhost";
          IPAddressDeny = "any";
        }
        // hardening;
      };
    })

    (lib.mkIf (hasDashboard && config.services.tailscale.enable) {
      systemd.services.forge-frontend-tailnet = {
        description = "Serve the Forge dashboard over HTTPS on the tailnet";
        wantedBy = [ "multi-user.target" ];
        after = [
          "tailscaled-autoconnect.service"
          "forge-frontend.service"
        ];
        wants = [
          "tailscaled-autoconnect.service"
          "forge-frontend.service"
        ];
        serviceConfig = {
          Type = "exec";
          ExecStart = "${lib.getExe config.services.tailscale.package} serve --https=443 http://127.0.0.1:${toString cfg.dashboardPort}";
          Restart = "always";
          RestartSec = "5s";
          CapabilityBoundingSet = "";
          RestrictAddressFamilies = [ "AF_UNIX" ];
          IPAddressDeny = "any";
        }
        // removeAttrs hardening [ "ReadWritePaths" ];
      };
    })
  ];
}
