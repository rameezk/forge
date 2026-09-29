{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.forge.runtime;

  harnessModule = lib.types.submodule {
    options = {
      command = lib.mkOption {
        type = lib.types.str;
        description = "Executable that runs this harness headlessly and emits its event stream.";
      };
      args = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = "Operator extra arguments for the harness, passed after the invocation the runner builds and before the prompt. The runner owns the harness's own CLI contract.";
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
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Reasoning effort, or null to run at the provider default.";
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
    };
  };

  runtimeConfig = {
    harnesses = lib.mapAttrs (_: h: { inherit (h) command args; }) cfg.harnesses;
    workers = lib.mapAttrs (
      _: w:
      {
        inherit (w) harness model prompt;
      }
      // lib.optionalAttrs (w.reasoningEffort != null) { inherit (w) reasoningEffort; }
    ) cfg.workers;
    repositories = lib.mapAttrs (_: r: { inherit (r) github; }) cfg.repositories;
  };

  runtimeConfigFile = pkgs.writeText "forge-runtime.json" (builtins.toJSON runtimeConfig);

  hasWorkers = cfg.workers != { };
  hasRepositories = cfg.repositories != { };

  hardening = {
    NoNewPrivileges = true;
    ProtectSystem = "strict";
    ProtectHome = true;
    PrivateTmp = true;
    ReadWritePaths = [ cfg.stateDir ];
    RestrictSUIDSGID = true;
    ProtectKernelTunables = true;
    ProtectControlGroups = true;
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

    stateDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/forge";
      readOnly = true;
      description = "State directory owned by the runtime service user, holding the SQLite store and per-run transcripts.";
    };

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.forge-runner;
      defaultText = lib.literalExpression "pkgs.forge-runner";
      description = "Runtime package providing the forge-run, forge-frontier and forge-frontend entry points.";
    };

    dashboardPort = lib.mkOption {
      type = lib.types.port;
      default = 7787;
      description = "Localhost TCP port the read-only dashboard binds to; reached over an SSH tunnel, never exposed publicly.";
    };

    openRouterKeyFile = lib.mkOption {
      type = lib.types.str;
      default = "${cfg.stateDir}/openrouter.env";
      defaultText = lib.literalExpression ''"''${cfg.stateDir}/openrouter.env"'';
      description = "Path to a restricted systemd EnvironmentFile, outside the Nix store, that sets OPENROUTER_API_KEY for the runner.";
    };

    githubTokenFile = lib.mkOption {
      type = lib.types.str;
      default = "${cfg.stateDir}/github.env";
      defaultText = lib.literalExpression ''"''${cfg.stateDir}/github.env"'';
      description = "Path to a restricted systemd EnvironmentFile, outside the Nix store, that sets GITHUB_TOKEN for the frontier poller. The poller loads it as optional, so a missing file does not stop the unit from starting.";
    };

    frontier.pollInterval = lib.mkOption {
      type = lib.types.str;
      default = "5min";
      example = "15min";
      description = "How often the frontier poller syncs the managed repositories' frontier from GitHub, as a systemd time span.";
    };

    toolset = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = map (name: pkgs.${name}) baseToolset;
      defaultText = lib.literalExpression "with pkgs; [ ${lib.concatStringsSep " " baseToolset} ]";
      example = lib.literalExpression "options.forge.runtime.toolset.default ++ [ pkgs.python3 ]";
      description = "Workload toolset: the packages that make up the runner unit's whole path, so a workload's harness and its subagents can invoke them and nothing else. Extend the base set with `options.forge.runtime.toolset.default ++ [ ... ]`, or set a list to replace it.";
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
      description = "Managed repositories, keyed by a short name; declaring one makes forge poll its frontier and show it on the dashboard.";
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
      users.users.${cfg.user} = {
        isSystemUser = true;
        group = cfg.user;
        home = cfg.stateDir;
        description = "Forge runtime service user";
      };
      users.groups.${cfg.user} = { };

      systemd.tmpfiles.rules = [
        "d ${cfg.stateDir} 0750 ${cfg.user} ${cfg.user} - -"
        "d ${cfg.stateDir}/transcripts 0750 ${cfg.user} ${cfg.user} - -"
      ];
    }

    (lib.mkIf hasWorkers {
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
          EnvironmentFile = cfg.openRouterKeyFile;
          Environment = [
            "FORGE_RUNTIME_CONFIG=${cfg.configFile}"
            "FORGE_STATE_DIR=${cfg.stateDir}"
          ];
          ExecStart = "${cfg.package}/bin/forge-run %i";
        }
        // hardening;
      };
    })

    (lib.mkIf hasRepositories {
      systemd.services.forge-frontier-sync = {
        description = "Forge frontier sync from GitHub";
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        serviceConfig = {
          Type = "oneshot";
          User = cfg.user;
          Group = cfg.user;
          WorkingDirectory = cfg.stateDir;
          EnvironmentFile = "-${cfg.githubTokenFile}";
          Environment = [
            "FORGE_RUNTIME_CONFIG=${cfg.configFile}"
            "FORGE_STATE_DIR=${cfg.stateDir}"
          ];
          ExecStart = "${cfg.package}/bin/forge-frontier sync";
        }
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

    (lib.mkIf (hasWorkers || hasRepositories) {
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
  ];
}
