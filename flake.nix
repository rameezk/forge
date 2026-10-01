{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

    disko.url = "github:nix-community/disko";
    disko.inputs.nixpkgs.follows = "nixpkgs";

    nixos-anywhere.url = "github:nix-community/nixos-anywhere";
    nixos-anywhere.inputs.nixpkgs.follows = "nixpkgs";

    sops-nix.url = "github:Mic92/sops-nix";
    sops-nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      self,
      nixpkgs,
      disko,
      nixos-anywhere,
      sops-nix,
    }:
    let
      lib = nixpkgs.lib;

      devSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: lib.genAttrs devSystems (system: f system);

      loadConfig = import ./infra/lib/load-config.nix;

      runnerOverlay = final: _prev: {
        forge-runner = final.callPackage ./infra/nix/runner.nix { };
      };

      mkHost =
        {
          configFile,
          secretsFile,
          modules ? [ ],
        }:
        let
          cfg = loadConfig configFile;
        in
        lib.nixosSystem {
          system = cfg.arch;
          modules = [
            disko.nixosModules.disko
            sops-nix.nixosModules.sops
            ./infra/nixos/configuration.nix
            ./infra/nixos/disko.nix
            ./infra/nixos/runtime.nix
            { nixpkgs.overlays = [ runnerOverlay ]; }
            { _module.args.forgeConfig = cfg; }
            { forge.runtime.secretsFile = secretsFile; }
          ]
          ++ modules;
        };
      operatorToolchain =
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        [
          pkgs.opentofu
          pkgs.jq
          pkgs.just
          nixos-anywhere.packages.${system}.default
          pkgs.nixos-rebuild-ng
          pkgs.sops
          pkgs.age
          pkgs.ssh-to-age
        ];
    in
    {
      lib = {
        inherit mkHost loadConfig operatorToolchain;
      };

      templates = {
        default = self.templates.operator;
        operator = {
          path = ./templates/operator;
          description = "Scaffold a forge operator repository: real host, committed config, and the divergence guard.";
        };
      };

      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          forge-shared = pkgs.callPackage ./infra/nix/shared.nix { };
          forge-runner = pkgs.callPackage ./infra/nix/runner.nix { };
        }
      );

      apps = forAllSystems (system: {
        run = {
          type = "app";
          program = "${self.packages.${system}.forge-runner}/bin/forge-run";
          meta = {
            description = "Run one declared worker headlessly and record the run: forge#run -- <worker>.";
          };
        };
      });

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = operatorToolchain system ++ [ pkgs.nodejs ];
            FORGE_PI_PACKAGE = self.packages.${system}.forge-runner.piPackage;
          };
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          exampleConfigFile = ./infra/config.example.json;
          exampleSecretsFile = ./tests/fixtures/runtime-secrets.yaml;
          exampleCfg = loadConfig exampleConfigFile;
          nixos = mkHost {
            configFile = exampleConfigFile;
            secretsFile = exampleSecretsFile;
          };
          actualHostName = nixos.config.networking.hostName;
          actualKeys = nixos.config.users.users.${exampleCfg.adminUser}.openssh.authorizedKeys.keys;
          hostNameMatches = lib.asserts.assertMsg (
            actualHostName == exampleCfg.hostname
          ) "NixOS hostName '${actualHostName}' does not match example hostname '${exampleCfg.hostname}'";
          keysMatch = lib.asserts.assertMsg (
            actualKeys == exampleCfg.sshPublicKeys
          ) "NixOS authorized keys for '${exampleCfg.adminUser}' do not match the example sshPublicKeys";
          rootLoginDisabled = lib.asserts.assertMsg (
            nixos.config.services.openssh.settings.PermitRootLogin == "no"
          ) "root SSH login must be disabled (PermitRootLogin = no)";
          rootHasNoKeys = lib.asserts.assertMsg (
            nixos.config.users.users.root.openssh.authorizedKeys.keys == [ ]
          ) "root must have no authorized SSH keys";
          instantiates = builtins.seq nixos.config.system.build.toplevel.drvPath true;
          boxIdentityIsHostKey = lib.asserts.assertMsg (
            nixos.config.services.openssh.hostKeys == [
              {
                path = "/etc/ssh/ssh_host_ed25519_key";
                type = "ed25519";
              }
            ]
            && nixos.config.sops.age.sshKeyPaths == [ "/etc/ssh/ssh_host_ed25519_key" ]
            && nixos.config.sops.gnupg.sshKeyPaths == [ ]
          ) "the box's only host key must be ed25519, and sops must derive its age identity from it";

          runtimeModuleComposed = lib.asserts.assertMsg (
            nixos.config.forge.runtime.stateDir == "/var/lib/forge"
            && nixos.config.forge.runtime.user == "forge-runtime"
          ) "the forge.runtime module must be composed into every host with its state dir and service user";
          runtimeUserDefined = lib.asserts.assertMsg (
            (nixos.config.users.users ? forge-runtime) && nixos.config.users.users.forge-runtime.isSystemUser
          ) "a dedicated forge-runtime system user must be defined";
          stateDirProvisioned = lib.asserts.assertMsg (lib.any
            (rule: lib.hasInfix "/var/lib/forge" rule && lib.hasInfix "forge-runtime" rule)
            nixos.config.systemd.tmpfiles.rules
          ) "/var/lib/forge must be provisioned as a forge-runtime-owned state directory";
          runtimeInert = lib.asserts.assertMsg (
            !(lib.any (name: lib.hasInfix "forge" name) (lib.attrNames nixos.config.systemd.services))
          ) "forge.runtime must stay inert when no workers are declared: no runner unit appears";

          workerHost = mkHost {
            configFile = exampleConfigFile;
            secretsFile = exampleSecretsFile;
            modules = [
              {
                forge.runtime.harnesses.pi.command = "/run/current-system/sw/bin/pi";
                forge.runtime.workers.refiner = {
                  harness = "pi";
                  model = "anthropic/claude-opus-4";
                  prompt = "refine the spec";
                  reasoningEffort = "high";
                };
                forge.runtime.workers.builder = {
                  harness = "pi";
                  model = "anthropic/claude-sonnet-4";
                  prompt = "build the thing";
                };
              }
            ];
          };
          runnerUnit = workerHost.config.systemd.services."forge-runner@";
          runnerSettings = workerHost.config.forge.runtime.settings;

          runnerUnitDeclared = lib.asserts.assertMsg (
            workerHost.config.systemd.services ? "forge-runner@"
          ) "declaring a worker must define the forge-runner@ oneshot template";
          runnerInvokesWorker = lib.asserts.assertMsg (
            runnerUnit.serviceConfig.Type == "oneshot"
            && lib.hasInfix "forge-run" runnerUnit.serviceConfig.ExecStart
            && lib.hasInfix "%i" runnerUnit.serviceConfig.ExecStart
            && runnerUnit.serviceConfig.User == "forge-runtime"
          ) "the runner unit must be a per-worker oneshot invoking forge-run as the forge-runtime user";
          isHardened =
            unit:
            unit.serviceConfig.NoNewPrivileges == true
            && unit.serviceConfig.ProtectSystem == "strict"
            && unit.serviceConfig.ProtectHome == true
            && unit.serviceConfig.PrivateTmp == true
            && unit.serviceConfig.ReadWritePaths == [ "/var/lib/forge" ]
            && unit.serviceConfig.RestrictSUIDSGID == true
            && unit.serviceConfig.ProtectKernelTunables == true
            && unit.serviceConfig.ProtectControlGroups == true;
          runnerSandboxed = lib.asserts.assertMsg (isHardened runnerUnit) "the runner unit must be sandboxed: no new privileges, protected system and home, private tmp, and writable only under the state directory";
          runnerEnvTemplate = workerHost.config.sops.templates."forge-runner.env";
          runnerKeyFromSops =
            lib.asserts.assertMsg
              (
                runnerUnit.serviceConfig.EnvironmentFile == runnerEnvTemplate.path
                && lib.hasPrefix "/run/secrets/" runnerEnvTemplate.path
                && runnerEnvTemplate.owner == "forge-runtime"
                && runnerEnvTemplate.mode == "0400"
              )
              "the runner's EnvironmentFile must be a sops template under /run/secrets, readable only by forge-runtime";
          hides = path: unit: lib.elem "-${path}" (unit.serviceConfig.InaccessiblePaths or [ ]);
          runnerKeyHiddenFromOtherUnits =
            lib.asserts.assertMsg
              (
                hides "/run/secrets" frontendUnit
                && hides "/run/secrets.d" frontendUnit
                &&
                  lib.all
                    (
                      template:
                      hides workerAndRepositoryHost.config.sops.templates.${template}.path
                        workerAndRepositoryHost.config.systemd.services.forge-frontier-sync
                    )
                    [
                      "forge-runner.env"
                      "forge-billing.env"
                    ]
              )
              "every secrets generation must be inaccessible to the long-running dashboard, and every OpenRouter key file to the frontier poller";
          workerHostInstantiates = builtins.seq workerHost.config.system.build.toplevel.drvPath true;
          runnerKeyOnly = lib.asserts.assertMsg (
            runnerEnvTemplate.content
            == "OPENROUTER_API_KEY=${workerHost.config.sops.placeholder.openrouter_api_key}\n"
            && workerHost.config.sops.secrets.openrouter_api_key.sopsFile == exampleSecretsFile
          ) "the runner's EnvironmentFile must carry only OPENROUTER_API_KEY, from the runtime secrets file";
          noOpenRouterKeyFileOption = lib.asserts.assertMsg (
            !(workerHost.options.forge.runtime ? openRouterKeyFile)
          ) "the openRouterKeyFile option must be gone: the OpenRouter key comes only from sops";
          runnerEnvWired = lib.asserts.assertMsg (
            lib.any (e: lib.hasInfix "FORGE_RUNTIME_CONFIG=" e) runnerUnit.serviceConfig.Environment
            && lib.any (e: e == "FORGE_STATE_DIR=/var/lib/forge") runnerUnit.serviceConfig.Environment
          ) "the runner unit must point at the generated config and the state directory";
          runnerConfigReflectsWorker = lib.asserts.assertMsg (
            runnerSettings.workers.refiner.harness == "pi"
            && runnerSettings.workers.refiner.model == "anthropic/claude-opus-4"
            && runnerSettings.workers.refiner.reasoningEffort == "high"
            && runnerSettings.harnesses.pi.command == "/run/current-system/sw/bin/pi"
          ) "the generated runtime config must reflect the declared harness and worker";
          ghInToolset = lib.asserts.assertMsg (
            lib.elem workerHost.pkgs.gh workerHost.config.forge.runtime.toolset
          ) "the base workload toolset must carry gh, so a dispatched agent can open pull requests with its GITHUB_TOKEN";
          runnerDefaultEffortOmitted =
            lib.asserts.assertMsg (!(runnerSettings.workers.builder ? reasoningEffort))
              "a worker with no reasoning effort must omit it from the config so the harness runs at the provider default";
          transcriptsProvisioned = lib.asserts.assertMsg (lib.any
            (rule: lib.hasInfix "/var/lib/forge/transcripts" rule && lib.hasInfix "forge-runtime" rule)
            nixos.config.systemd.tmpfiles.rules
          ) "/var/lib/forge/transcripts must be provisioned for per-run transcripts";

          frontendUnit = workerHost.config.systemd.services.forge-frontend;
          dashboardPort = workerHost.config.forge.runtime.dashboardPort;

          frontendDeclared = lib.asserts.assertMsg (
            (workerHost.config.systemd.services ? forge-frontend)
            && frontendUnit.wantedBy == [ "multi-user.target" ]
          ) "declaring a worker must define an always-on forge-frontend dashboard service";
          frontendRunsAsUser = lib.asserts.assertMsg (
            frontendUnit.serviceConfig.Type == "exec"
            && frontendUnit.serviceConfig.User == "forge-runtime"
            && frontendUnit.serviceConfig.Group == "forge-runtime"
            && lib.hasInfix "forge-frontend" frontendUnit.serviceConfig.ExecStart
          ) "the dashboard must run forge-frontend as the forge-runtime user";
          frontendLocalhostOnly = lib.asserts.assertMsg (
            lib.any (e: e == "FORGE_FRONTEND_HOST=127.0.0.1") frontendUnit.serviceConfig.Environment
            && frontendUnit.serviceConfig.IPAddressAllow == "localhost"
            && frontendUnit.serviceConfig.IPAddressDeny == "any"
          ) "the dashboard must bind localhost and refuse non-loopback addresses";
          frontendNoPublicPort = lib.asserts.assertMsg (
            !(lib.elem dashboardPort workerHost.config.networking.firewall.allowedTCPPorts)
          ) "the dashboard port must never be opened in the firewall: it is reached only over an SSH tunnel";
          frontendIsLockedDown =
            unit:
            isHardened unit
            &&
              unit.serviceConfig.RestrictAddressFamilies == [
                "AF_INET"
                "AF_INET6"
                "AF_UNIX"
              ]
            && unit.serviceConfig.IPAddressAllow == "localhost"
            && unit.serviceConfig.IPAddressDeny == "any";
          frontendSandboxed = lib.asserts.assertMsg (frontendIsLockedDown frontendUnit) "the dashboard unit must be sandboxed like the runner";

          workerAndRepositoryHost = mkHost {
            configFile = exampleConfigFile;
            secretsFile = exampleSecretsFile;
            modules = [
              {
                forge.runtime.harnesses.pi.command = "/run/current-system/sw/bin/pi";
                forge.runtime.workers.builder = {
                  harness = "pi";
                  model = "anthropic/claude-sonnet-4";
                  prompt = "build the thing";
                };
                forge.runtime.repositories.forge.github = "rameezk/forge";
              }
            ];
          };

          repositoryHost = mkHost {
            configFile = exampleConfigFile;
            secretsFile = exampleSecretsFile;
            modules = [
              {
                forge.runtime.repositories.forge.github = "rameezk/forge";
                forge.runtime.frontier.pollInterval = "15min";
              }
            ];
          };
          frontierService = repositoryHost.config.systemd.services.forge-frontier-sync;
          frontierTimer = repositoryHost.config.systemd.timers.forge-frontier-sync;

          frontierDeclared = lib.asserts.assertMsg (
            (repositoryHost.config.systemd.services ? forge-frontier-sync)
            && (repositoryHost.config.systemd.timers ? forge-frontier-sync)
            && frontierTimer.wantedBy == [ "timers.target" ]
          ) "declaring a repository must define the forge-frontier-sync timer and service";
          frontierSyncs = lib.asserts.assertMsg (
            frontierService.serviceConfig.Type == "oneshot"
            &&
              frontierService.serviceConfig.ExecStart
              == "${repositoryHost.config.forge.runtime.package}/bin/forge-frontier sync"
            && frontierService.serviceConfig.User == "forge-runtime"
            && frontierService.serviceConfig.Group == "forge-runtime"
            && lib.elem "network-online.target" frontierService.after
            && lib.elem "network-online.target" frontierService.wants
            && !(frontierService.serviceConfig ? IPAddressDeny)
          ) "the sync service must run forge-frontier sync as the forge-runtime user with outbound network";
          frontierSandboxed = lib.asserts.assertMsg (isHardened frontierService) "the sync service must be sandboxed like the runner";
          frontierTokenOptional =
            lib.asserts.assertMsg
              (frontierService.serviceConfig.EnvironmentFile == "-/var/lib/forge/github.env")
              "the sync service must load the GitHub token file as an optional EnvironmentFile outside the Nix store";
          frontierEnvWired = lib.asserts.assertMsg (
            lib.any (e: lib.hasInfix "FORGE_RUNTIME_CONFIG=" e) frontierService.serviceConfig.Environment
            && lib.any (e: e == "FORGE_STATE_DIR=/var/lib/forge") frontierService.serviceConfig.Environment
          ) "the sync service must point at the generated config and the state directory";
          frontierPollsAtInterval = lib.asserts.assertMsg (
            frontierTimer.timerConfig.OnUnitActiveSec == "15min"
          ) "the frontier timer must poll at the configured interval";
          frontierDefaultInterval = lib.asserts.assertMsg (
            nixos.config.forge.runtime.frontier.pollInterval == "5min"
          ) "the frontier poll interval must default to 5min";
          frontierConfigReflectsRepositories = lib.asserts.assertMsg (
            repositoryHost.config.forge.runtime.settings.repositories == {
              forge.github = "rameezk/forge";
            }
          ) "the generated runtime config must include the declared repositories";
          noRepositoriesNoPoller = lib.asserts.assertMsg (
            !(workerHost.config.systemd.services ? forge-frontier-sync)
            && !(workerHost.config.systemd.timers ? forge-frontier-sync)
          ) "a host with no repositories must have neither the frontier timer nor the sync service";
          hasFrontierCommand =
            host:
            lib.any (package: lib.getName package == "forge-frontier") host.config.environment.systemPackages;
          frontierCommandInstalled =
            lib.asserts.assertMsg (hasFrontierCommand repositoryHost && !(hasFrontierCommand workerHost))
              "declaring a repository must put the forge-frontier command on the box's path, and a host without repositories must not";
          dashboardWithoutWorkers =
            lib.asserts.assertMsg
              (
                (repositoryHost.config.systemd.services ? forge-frontend)
                && frontendIsLockedDown repositoryHost.config.systemd.services.forge-frontend
                && !(repositoryHost.config.systemd.services ? "forge-runner@")
              )
              "declaring repositories without workers must run the dashboard, locked down as before, and no runner";

          gitIdentity = {
            name = "Forge Operator";
            email = "operator@example.com";
          };
          dispatchHostWith =
            {
              prompt ? "/work-on {url}",
              dispatch ? { inherit gitIdentity; },
            }:
            mkHost {
              configFile = exampleConfigFile;
              secretsFile = exampleSecretsFile;
              modules = [
                {
                  forge.runtime.harnesses.pi.command = "/run/current-system/sw/bin/pi";
                  forge.runtime.workers.builder = {
                    harness = "pi";
                    model = "anthropic/claude-sonnet-4";
                    inherit prompt;
                  };
                  forge.runtime.repositories.forge = {
                    github = "rameezk/forge";
                    worker = "builder";
                  };
                  forge.runtime.dispatch = dispatch;
                }
              ];
            };
          dispatchHost = dispatchHostWith { };
          dispatchUnit = dispatchHost.config.systemd.services."forge-dispatch@";
          hasDispatchCommand =
            host:
            lib.any (package: lib.getName package == "forge-dispatch") host.config.environment.systemPackages;
          failedAssertions = host: map (a: a.message) (lib.filter (a: !a.assertion) host.config.assertions);
          evaluates = host: (builtins.tryEval host.config.system.build.toplevel.drvPath).success;

          dispatchConfigReflectsWorker = lib.asserts.assertMsg (
            dispatchHost.config.forge.runtime.settings.repositories == {
              forge = {
                github = "rameezk/forge";
                worker = "builder";
              };
            }
            &&
              workerAndRepositoryHost.config.forge.runtime.settings.repositories == {
                forge.github = "rameezk/forge";
              }
          ) "the generated runtime config must carry a repository's worker only when it declares one";
          dispatchConfigReflectsGitIdentity = lib.asserts.assertMsg (
            dispatchHost.config.forge.runtime.settings.dispatch == { inherit gitIdentity; }
            && !(workerAndRepositoryHost.config.forge.runtime.settings ? dispatch)
          ) "the generated runtime config must carry the dispatch git identity only when it is set";
          missingGitIdentityFails =
            let
              host = dispatchHostWith { dispatch = { }; };
            in
            lib.asserts.assertMsg (
              !(evaluates host)
              && lib.any (lib.hasInfix "forge.runtime.dispatch.gitIdentity") (failedAssertions host)
            ) "a repository that declares a worker on a host with no dispatch git identity must fail evaluation";
          dispatchHostEvaluates = lib.asserts.assertMsg (
            evaluates dispatchHost && evaluates (dispatchHostWith { prompt = "Build {repo}#{issue}"; })
          ) "a repository whose worker prompt holds {url} or {issue} must evaluate";
          placeholderlessWorkerFails =
            let
              host = dispatchHostWith { prompt = "build the thing"; };
            in
            lib.asserts.assertMsg (
              !(evaluates host) && lib.any (lib.hasInfix "has no ticket placeholder") (failedAssertions host)
            ) "a worker named by a repository whose prompt has no ticket placeholder must fail evaluation";
          undeclaredWorkerFails =
            let
              host = mkHost {
                configFile = exampleConfigFile;
                secretsFile = exampleSecretsFile;
                modules = [
                  {
                    forge.runtime.repositories.forge = {
                      github = "rameezk/forge";
                      worker = "missing";
                    };
                  }
                ];
              };
            in
            lib.asserts.assertMsg (
              !(evaluates host) && lib.any (lib.hasInfix "undeclared worker 'missing'") (failedAssertions host)
            ) "a repository naming an undeclared worker must fail evaluation";
          dispatchUnitDeclared =
            lib.asserts.assertMsg
              (
                (dispatchHost.config.systemd.services ? "forge-dispatch@")
                && !(workerAndRepositoryHost.config.systemd.services ? "forge-dispatch@")
              )
              "declaring a repository with a worker must define the forge-dispatch@ template, and a host without one must not";
          dispatchUnitRunsDispatch =
            lib.asserts.assertMsg
              (
                dispatchUnit.serviceConfig.Type == "oneshot"
                && lib.hasInfix "%i" dispatchUnit.serviceConfig.ExecStart
                && dispatchUnit.serviceConfig.User == "forge-runtime"
                && dispatchUnit.serviceConfig.Group == "forge-runtime"
                && lib.elem "network-online.target" dispatchUnit.after
                && dispatchUnit.path == dispatchHost.config.forge.runtime.toolset
                && lib.any (e: lib.hasInfix "FORGE_RUNTIME_CONFIG=" e) dispatchUnit.serviceConfig.Environment
                && lib.any (e: e == "FORGE_STATE_DIR=/var/lib/forge") dispatchUnit.serviceConfig.Environment
              )
              "the dispatch unit must be a oneshot running forge-dispatch for its instance as the forge-runtime user on the workload toolset";
          dispatchUnitSandboxed = lib.asserts.assertMsg (isHardened dispatchUnit) "the dispatch unit must be sandboxed like the runner";
          dispatchUnitEnvironmentFiles =
            lib.asserts.assertMsg
              (
                dispatchUnit.serviceConfig.EnvironmentFile
                == dispatchHost.config.sops.templates."forge-runner.env".path
                && lib.elem "FORGE_GITHUB_WRITE_TOKEN_FILE=/var/lib/forge-credentials/github-write.env" dispatchUnit.serviceConfig.Environment
                && !(lib.any (lib.hasInfix "/var/lib/forge/github.env") dispatchUnit.serviceConfig.Environment)
              )
              "the dispatch unit must load only the runner's OpenRouter key as an EnvironmentFile, read the GitHub write-token file as data, and never see the frontier's read-only token";
          dispatchHostSync = dispatchHost.config.systemd.services.forge-frontier-sync;
          frontierSyncEnsuresLabels =
            lib.asserts.assertMsg
              (
                lib.elem "FORGE_GITHUB_WRITE_TOKEN_FILE=/var/lib/forge-credentials/github-write.env" dispatchHostSync.serviceConfig.Environment
                && dispatchHostSync.serviceConfig.EnvironmentFile == "-/var/lib/forge/github.env"
                && !(lib.any (lib.hasInfix "FORGE_GITHUB_WRITE_TOKEN_FILE") frontierService.serviceConfig.Environment)
              )
              "on a host that dispatches, the sync service must read the GitHub write-token file as data to ensure the forge labels, while polling with the frontier's read-only token; a host that does not dispatch must not give it the write token";
          writeTokenHidden =
            let
              services = dispatchHost.config.systemd.services;
              hides = unit: lib.elem "/var/lib/forge-credentials" (unit.serviceConfig.InaccessiblePaths or [ ]);
            in
            lib.asserts.assertMsg
              (
                hides services."forge-runner@"
                && hides services.forge-billing
                && hides services.forge-frontend
                && lib.elem "-/run/secrets" services.forge-frontend.serviceConfig.InaccessiblePaths
                && lib.elem "d /var/lib/forge-credentials 0700 forge-runtime forge-runtime - -" dispatchHost.config.systemd.tmpfiles.rules
                && !(lib.hasPrefix "/var/lib/forge/" dispatchHost.config.forge.runtime.githubWriteTokenFile)
              )
              "the GitHub write-token file must live in its own always-present directory outside the run-writable state directory, masked without a missing-path exception from the scheduled runner, billing and the dashboard";
          writeTokenSeparate =
            lib.asserts.assertMsg
              (
                dispatchHost.config.forge.runtime.githubWriteTokenFile
                == "/var/lib/forge-credentials/github-write.env"
                && dispatchHost.config.forge.runtime.githubTokenFile == "/var/lib/forge/github.env"
              )
              "the GitHub write-token file must be its own file, apart from the frontier's read-only token file";
          dispatchCommandInstalled =
            lib.asserts.assertMsg
              (hasDispatchCommand dispatchHost && !(hasDispatchCommand workerAndRepositoryHost))
              "declaring a repository with a worker must put the forge-dispatch command on the box's path, and a host without one must not";

          billingService = workerHost.config.systemd.services.forge-billing;
          billingTimer = workerHost.config.systemd.timers.forge-billing;
          billingDeclared = lib.asserts.assertMsg (
            (workerHost.config.systemd.services ? forge-billing)
            && (workerHost.config.systemd.timers ? forge-billing)
            && billingTimer.wantedBy == [ "timers.target" ]
          ) "declaring a worker must define the forge-billing timer and service";
          billingSettles =
            lib.asserts.assertMsg
              (
                billingService.serviceConfig.Type == "oneshot"
                &&
                  billingService.serviceConfig.ExecStart
                  == "${workerHost.config.forge.runtime.package}/bin/forge-billing"
                && billingService.serviceConfig.User == "forge-runtime"
                && billingService.serviceConfig.Group == "forge-runtime"
                && lib.elem "network-online.target" billingService.after
                && lib.elem "network-online.target" billingService.wants
                && lib.any (e: e == "FORGE_STATE_DIR=/var/lib/forge") billingService.serviceConfig.Environment
              )
              "the billing service must run forge-billing as the forge-runtime user against the state directory with outbound network";
          billingSandboxed = lib.asserts.assertMsg (isHardened billingService) "the billing service must be sandboxed like the runner";
          billingEnvTemplate = workerHost.config.sops.templates."forge-billing.env";
          billingKeyFromSops =
            lib.asserts.assertMsg
              (
                billingService.serviceConfig.EnvironmentFile == billingEnvTemplate.path
                && lib.hasPrefix "/run/secrets/" billingEnvTemplate.path
                && billingEnvTemplate.owner == "forge-runtime"
                && billingEnvTemplate.mode == "0400"
                &&
                  billingEnvTemplate.content
                  == "OPENROUTER_API_KEY=${workerHost.config.sops.placeholder.openrouter_api_key}\n"
              )
              "the billing service must load only OPENROUTER_API_KEY from its own sops template under /run/secrets, readable only by forge-runtime";
          billingFiresEveryMinute = lib.asserts.assertMsg (
            billingTimer.timerConfig.OnBootSec == "1min" && billingTimer.timerConfig.OnUnitActiveSec == "1min"
          ) "the billing timer must fire one minute after boot and every minute after that";
          noWorkersNoBilling = lib.asserts.assertMsg (
            !(nixos.config.systemd.services ? forge-billing)
            && !(nixos.config.systemd.timers ? forge-billing)
            && !(repositoryHost.config.systemd.services ? forge-billing)
            && !(repositoryHost.config.systemd.timers ? forge-billing)
          ) "a host with no workers must have neither the billing timer nor the billing service";

          hasSqlite = host: lib.elem host.pkgs.sqlite host.config.environment.systemPackages;
          sqliteWithWorkers = lib.asserts.assertMsg (hasSqlite workerHost) "a host with workers must ship sqlite so the store can be inspected";
          sqliteWithRepositories = lib.asserts.assertMsg (hasSqlite repositoryHost) "a host with repositories must ship sqlite so the store can be inspected";
          sqliteInert = lib.asserts.assertMsg (
            !(hasSqlite nixos)
          ) "a host with no workers or repositories must not ship sqlite";
        in
        {
          example-reflects-config =
            assert hostNameMatches;
            assert keysMatch;
            assert rootLoginDisabled;
            assert rootHasNoKeys;
            assert instantiates;
            assert boxIdentityIsHostKey;
            pkgs.runCommand "example-reflects-config" { } ''
              echo "example host reflects config.example.json; root login disabled; its ed25519 host key is its sops identity" > $out
            '';

          runtime-foundation =
            assert runtimeModuleComposed;
            assert runtimeUserDefined;
            assert stateDirProvisioned;
            assert runtimeInert;
            pkgs.runCommand "runtime-foundation" { } ''
              echo "forge.runtime composed and inert; forge-runtime user and /var/lib/forge state dir provisioned" > $out
            '';

          runtime-runner =
            assert runnerUnitDeclared;
            assert runnerInvokesWorker;
            assert runnerSandboxed;
            assert runnerKeyFromSops;
            assert runnerKeyOnly;
            assert noOpenRouterKeyFileOption;
            assert workerHostInstantiates;
            assert runnerKeyHiddenFromOtherUnits;
            assert runnerEnvWired;
            assert runnerConfigReflectsWorker;
            assert runnerDefaultEffortOmitted;
            assert ghInToolset;
            assert transcriptsProvisioned;
            pkgs.runCommand "runtime-runner" { } ''
              echo "declaring a worker wires a forge-runner@ oneshot invoking forge-run with only the OpenRouter key, from a sops template" > $out
            '';

          runtime-dashboard =
            assert frontendDeclared;
            assert frontendRunsAsUser;
            assert frontendLocalhostOnly;
            assert frontendNoPublicPort;
            assert frontendSandboxed;
            pkgs.runCommand "runtime-dashboard" { } ''
              echo "declaring a worker wires an always-on forge-frontend dashboard bound to localhost, opening no public port" > $out
            '';

          runtime-frontier =
            assert frontierDeclared;
            assert frontierSyncs;
            assert frontierSandboxed;
            assert frontierTokenOptional;
            assert frontierEnvWired;
            assert frontierPollsAtInterval;
            assert frontierDefaultInterval;
            assert frontierConfigReflectsRepositories;
            assert noRepositoriesNoPoller;
            assert dashboardWithoutWorkers;
            assert frontierCommandInstalled;
            pkgs.runCommand "runtime-frontier" { } ''
              echo "declaring a repository wires a forge-frontier-sync timer and service with an optional GitHub token file, puts forge-frontier on the path, and runs the dashboard without workers" > $out
            '';

          runtime-dispatch =
            assert dispatchConfigReflectsWorker;
            assert dispatchConfigReflectsGitIdentity;
            assert missingGitIdentityFails;
            assert dispatchHostEvaluates;
            assert placeholderlessWorkerFails;
            assert undeclaredWorkerFails;
            assert dispatchUnitDeclared;
            assert dispatchUnitRunsDispatch;
            assert dispatchUnitSandboxed;
            assert dispatchUnitEnvironmentFiles;
            assert frontierSyncEnsuresLabels;
            assert writeTokenSeparate;
            assert writeTokenHidden;
            assert dispatchCommandInstalled;
            pkgs.runCommand "runtime-dispatch" { } ''
              echo "a repository's worker wires a forge-dispatch@ oneshot, the forge-dispatch command and the GitHub write token, and a worker without a ticket placeholder fails evaluation" > $out
            '';

          runtime-billing =
            assert billingDeclared;
            assert billingSettles;
            assert billingSandboxed;
            assert billingKeyFromSops;
            assert billingFiresEveryMinute;
            assert noWorkersNoBilling;
            pkgs.runCommand "runtime-billing" { } ''
              echo "declaring a worker wires a forge-billing oneshot on a one-minute timer that settles billed cost with the OpenRouter key from its own sops template" > $out
            '';

          runtime-sqlite =
            assert sqliteWithWorkers;
            assert sqliteWithRepositories;
            assert sqliteInert;
            pkgs.runCommand "runtime-sqlite" { } ''
              echo "a host running forge.runtime ships sqlite to inspect the store; an inert host does not" > $out
            '';

          forge-shared = self.packages.${system}.forge-shared;
          forge-runner = self.packages.${system}.forge-runner;
          frontier-command = pkgs.callPackage ./infra/nix/frontier-command-check.nix { };
          dashboard-stylesheet = pkgs.callPackage ./infra/nix/dashboard-stylesheet.nix {
            forge-runner = self.packages.${system}.forge-runner;
          };
          pi-cli-contract = pkgs.callPackage ./infra/nix/pi-cli-contract.nix {
            forge-runner = self.packages.${system}.forge-runner;
          };
        }
        // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          runtime-toolset = pkgs.callPackage ./infra/nix/runtime-toolset.nix {
            forge-runner = self.packages.${system}.forge-runner;
            sopsModule = sops-nix.nixosModules.sops;
            secretsFile = exampleSecretsFile;
            secretsHostKey = ./tests/fixtures/ssh_host_ed25519_key;
          };
          run-directories = pkgs.callPackage ./infra/nix/run-directories.nix {
            sopsModule = sops-nix.nixosModules.sops;
          };
        }
      );
    };
}
