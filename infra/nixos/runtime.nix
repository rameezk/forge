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
        description = "Fixed arguments passed before the per-worker invocation arguments.";
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
        description = "Prompt the worker runs on.";
      };
      reasoningEffort = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Reasoning effort, or null to run at the provider default.";
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
  };

  runtimeConfigFile = pkgs.writeText "forge-runtime.json" (builtins.toJSON runtimeConfig);

  hasWorkers = cfg.workers != { };
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
      description = "Runner package providing the forge-run entry point.";
    };

    openRouterKeyFile = lib.mkOption {
      type = lib.types.str;
      default = "${cfg.stateDir}/openrouter.env";
      defaultText = lib.literalExpression ''"''${cfg.stateDir}/openrouter.env"'';
      description = "Path to a restricted systemd EnvironmentFile, outside the Nix store, that sets OPENROUTER_API_KEY for the runner.";
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

    settings = lib.mkOption {
      type = lib.types.attrs;
      readOnly = true;
      internal = true;
      default = runtimeConfig;
      description = "Structured runtime config (harnesses and workers) the runner resolves a worker from.";
    };

    configFile = lib.mkOption {
      type = lib.types.path;
      readOnly = true;
      default = runtimeConfigFile;
      defaultText = lib.literalExpression "generated from forge.runtime.harnesses and forge.runtime.workers";
      description = "Generated runtime config the runner reads to resolve a worker by name.";
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

          NoNewPrivileges = true;
          ProtectSystem = "strict";
          ProtectHome = true;
          PrivateTmp = true;
          ReadWritePaths = [ cfg.stateDir ];
          RestrictSUIDSGID = true;
          ProtectKernelTunables = true;
          ProtectControlGroups = true;
        };
      };
    })
  ];
}
