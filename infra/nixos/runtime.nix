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
      worker = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "builder";
        description = "Worker that `forge-dispatch` runs against this repository's tickets, in a fresh clone of its default branch, or null to only poll its frontier. Its prompt is a template filled in for each ticket: `{repo}` becomes the repository's `owner/name`, `{issue}` the ticket's number and `{url}` its URL, and it must hold `{issue}` or `{url}`. A leading `/<name>` runs the checkout's skill of that name, and the dispatch fails if the checkout has none.";
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
    repositories = lib.mapAttrs (
      _: r: { inherit (r) github; } // lib.optionalAttrs (r.worker != null) { inherit (r) worker; }
    ) cfg.repositories;
  };

  runtimeConfigFile = pkgs.writeText "forge-runtime.json" (builtins.toJSON runtimeConfig);

  hasWorkers = cfg.workers != { };
  hasRepositories = cfg.repositories != { };
  dispatchedRepositories = lib.filterAttrs (_: r: r.worker != null) cfg.repositories;
  hasDispatch = dispatchedRepositories != { };

  hasTicketPlaceholder = prompt: lib.hasInfix "{issue}" prompt || lib.hasInfix "{url}" prompt;

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

  dispatchInstance = pkgs.writeShellScript "forge-dispatch-instance" ''
    exec ${cfg.package}/bin/forge-dispatch "''${1%:*}" "''${1##*:}"
  '';

  openRouterEnvFiles = [
    "forge-runner.env"
    "forge-billing.env"
  ];
  envFile = name: config.sops.templates.${name}.path;
  hideEnvFile = name: "-${envFile name}";
  hideOpenRouterEnvFiles = lib.optionalAttrs hasWorkers {
    InaccessiblePaths = map hideEnvFile openRouterEnvFiles;
  };

  hideGithubTokens =
    lib.optional hasRepositories (hideEnvFile "forge-github.env")
    ++ lib.optional hasDispatch (hideEnvFile "forge-github-write.env");

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
      description = "State directory owned by the runtime service user, holding the SQLite store, per-run transcripts, and run directories, which age out after 14 days.";
    };

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.forge-runner;
      defaultText = lib.literalExpression "pkgs.forge-runner";
      description = "Runtime package providing the forge-run, forge-dispatch, forge-billing, forge-frontier and forge-frontend entry points.";
    };

    dashboardPort = lib.mkOption {
      type = lib.types.port;
      default = 7787;
      description = "Localhost TCP port the read-only dashboard binds to; reached over an SSH tunnel, never exposed publicly.";
    };

    secretsFile = lib.mkOption {
      type = lib.types.path;
      description = "The operator's sops-encrypted runtime secrets file, decrypted on the box with its host key. It must hold `openrouter_api_key` when any worker is declared, `github_token` (the frontier's read-only token) when any repository is declared, and `github_write_token` (the write token on Contents, Pull requests and Issues of every managed repository) when a repository declares a worker. forge-dispatch and the frontier sync read only GITHUB_TOKEN from the write token's rendered file, as data, and no unit loads it as an EnvironmentFile.";
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
      assertions = dispatchAssertions;

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
        "d ${cfg.stateDir}/work 0750 ${cfg.user} ${cfg.user} 14d -"
        "r ${cfg.stateDir}/github.env - - - - -"
        "R /var/lib/forge-credentials - - - - -"
      ];
    }

    (lib.mkIf hasWorkers {
      sops.secrets.openrouter_api_key.sopsFile = cfg.secretsFile;
      sops.templates = lib.genAttrs openRouterEnvFiles (_: {
        content = "OPENROUTER_API_KEY=${config.sops.placeholder.openrouter_api_key}\n";
        owner = cfg.user;
        mode = "0400";
      });

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
          ];
          ExecStart = "${cfg.package}/bin/forge-run %i";
          InaccessiblePaths = hideGithubTokens;
        }
        // hardening;
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
          InaccessiblePaths = hideGithubTokens;
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
      sops.templates."forge-github.env" = {
        content = "GITHUB_TOKEN=${config.sops.placeholder.github_token}\n";
        owner = cfg.user;
        mode = "0400";
      };

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
          ++ lib.optional hasDispatch "FORGE_GITHUB_WRITE_TOKEN_FILE=${envFile "forge-github-write.env"}";
          ExecStart = "${cfg.package}/bin/forge-frontier sync";
        }
        // hardening
        // hideOpenRouterEnvFiles;
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
      sops.templates."forge-github-write.env" = {
        content = "GITHUB_TOKEN=${config.sops.placeholder.github_write_token}\n";
        owner = cfg.user;
        mode = "0400";
      };
    })

    (lib.mkIf (hasWorkers && hasDispatch) {
      environment.systemPackages = [
        (pkgs.callPackage ../nix/dispatch-command.nix { })
      ];

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
            "FORGE_GITHUB_WRITE_TOKEN_FILE=${envFile "forge-github-write.env"}"
          ];
          ExecStart = "${dispatchInstance} %i";
          InaccessiblePaths = [ (hideEnvFile "forge-github.env") ];
        }
        // hardening;
      };
    })

    (lib.mkIf (hasWorkers || hasRepositories) {
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
          InaccessiblePaths = [
            "-/run/secrets"
            "-/run/secrets.d"
          ];
        }
        // hardening;
      };
    })
  ];
}
