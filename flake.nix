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
          handPlacedTokensRemoved =
            lib.asserts.assertMsg
              (
                lib.elem "r /var/lib/forge/github.env - - - - -" nixos.config.systemd.tmpfiles.rules
                && lib.elem "R /var/lib/forge-credentials - - - - -" nixos.config.systemd.tmpfiles.rules
                && !(lib.any (lib.hasPrefix "d /var/lib/forge-credentials") nixos.config.systemd.tmpfiles.rules)
              )
              "every host must delete a leftover hand-placed github.env and /var/lib/forge-credentials on activation, so no plain-text token stays behind";
          definedByRuntimeModule =
            option:
            lib.any (
              definition: lib.hasSuffix "/infra/nixos/runtime.nix" (toString definition.file)
            ) option.definitionsWithLocations;
          sandboxSupported =
            lib.asserts.assertMsg
              (
                nixos.config.security.allowUserNamespaces
                && definedByRuntimeModule nixos.options.security.allowUserNamespaces
              )
              "the forge.runtime module must allow user namespaces explicitly: every workload's harness runs in a bubblewrap sandbox that needs them";
          runtimeHomeEmpty =
            lib.asserts.assertMsg (nixos.config.users.users.forge-runtime.home == "/var/empty")
              "the forge-runtime user's home must be /var/empty, so none of forge's processes read dotfiles from the state directory";
          nixSettings = nixos.config.nix.settings;
          flakesEnabled =
            lib.asserts.assertMsg
              (lib.all (feature: lib.elem feature (nixSettings.experimental-features or [ ])) [
                "nix-command"
                "flakes"
              ])
              "the forge.runtime module must enable nix-command and flakes box-wide, so a workload can run nix run and nix print-dev-env";
          storeCollectedWeekly =
            lib.asserts.assertMsg
              (
                nixos.config.nix.gc.automatic
                && nixos.config.nix.gc.dates == [ "weekly" ]
                && nixos.config.nix.gc.options == "--delete-older-than 14d"
              )
              "the nix store must be garbage collected weekly, deleting anything older than 14 days, to match the age-out of run directories";
          nixInToolset = lib.asserts.assertMsg (lib.elem nixos.config.nix.package nixos.config.forge.runtime.toolset) "the base workload toolset must carry the box's nix, so a workload can use nix through the daemon";
          trustingHost =
            module:
            mkHost {
              configFile = exampleConfigFile;
              secretsFile = exampleSecretsFile;
              modules = [ module ];
            };
          trusting = trustedUsers: { nix.settings.trusted-users = trustedUsers; };
          trustedRuntimeFails =
            module:
            let
              host = trustingHost module;
            in
            !(evaluates host)
            && lib.any (lib.hasInfix "must never be a trusted nix user") (failedAssertions host);
          runtimeNeverTrusted =
            lib.asserts.assertMsg
              (
                lib.all trustedRuntimeFails [
                  (trusting [ "forge-runtime" ])
                  (trusting [ "@forge-runtime" ])
                  (trusting [ "*" ])
                  (trusting [ "@wheel" ] // { users.users.forge-runtime.extraGroups = [ "wheel" ]; })
                  { nix.settings.extra-trusted-users = [ "forge-runtime" ]; }
                  (trusting [ "root  forge-runtime" ])
                  { nix.settings.extra-trusted-users = "root @forge-runtime"; }
                  { nix.extraOptions = "trusted-users = root forge-runtime"; }
                  { nix.extraOptions = "extra-trusted-users = @forge-runtime"; }
                ]
                && evaluates (trustingHost (trusting [ "@wheel" ]))
                && evaluates (trustingHost {
                  nix.settings.extra-trusted-users = [ "@wheel" ];
                })
              )
              "a host that makes forge-runtime a trusted nix user in trusted-users or extra-trusted-users, by name, by any of its groups or through a wildcard, or that sets either in nix.extraOptions, must fail evaluation: one workload could otherwise plant a tool for a later one through the store";
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
          isUnitHardened =
            unit:
            unit.serviceConfig.NoNewPrivileges == true
            && unit.serviceConfig.ProtectSystem == "strict"
            && unit.serviceConfig.ProtectHome == true
            && unit.serviceConfig.PrivateTmp == true
            && unit.serviceConfig.ReadWritePaths == [ "/var/lib/forge" ]
            && unit.serviceConfig.RestrictSUIDSGID == true
            && unit.serviceConfig.ProtectControlGroups == true
            &&
              (unit.serviceConfig.InaccessiblePaths or [ ]) == [
                "/run/secrets"
                "/run/secrets.d"
              ];
          isHardened = unit: isUnitHardened unit && unit.serviceConfig.ProtectKernelTunables == true;
          isWorkloadHardened = unit: isUnitHardened unit && unit.serviceConfig.ProtectKernelTunables == false;
          runnerSandboxed = lib.asserts.assertMsg (isWorkloadHardened runnerUnit) "the runner unit must be sandboxed: no new privileges, protected system and home, private tmp, writable only under the state directory, and blind to every secrets generation, which reaches it only through what systemd reads outside its namespace. Its kernel tunables stay unprotected, because bubblewrap must mount a fresh /proc for a workload's sandbox, which their read-only overmounts in /proc forbid, and must write /proc/sys/user/max_user_namespaces to refuse nested user namespaces (ADR-0030)";
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
          workerHostInstantiates = builtins.seq workerHost.config.system.build.toplevel.drvPath true;
          relativeHarnessCommandFails =
            lib.asserts.assertMsg
              (
                !(evaluates (mkHost {
                  configFile = exampleConfigFile;
                  secretsFile = exampleSecretsFile;
                  modules = [
                    {
                      forge.runtime.harnesses.pi.command = "pi";
                      forge.runtime.workers.builder = {
                        harness = "pi";
                        model = "anthropic/claude-sonnet-4";
                        prompt = "build the thing";
                      };
                    }
                  ];
                }))
              )
              "a harness command that is not an absolute path must fail evaluation: the workload sandbox can only run a command resolved to its real path";
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
          ghInToolset = lib.asserts.assertMsg (lib.elem workerHost.pkgs.gh workerHost.config.forge.runtime.toolset) "the base workload toolset must carry gh, so a dispatched agent can open pull requests with its GITHUB_TOKEN";
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
          firewall = workerHost.config.networking.firewall;
          firewallAllowLists = [ firewall ] ++ lib.attrValues firewall.interfaces;
          frontendNoPublicPort =
            lib.asserts.assertMsg
              (lib.all (
                allowList:
                !(lib.elem dashboardPort (allowList.allowedTCPPorts ++ allowList.allowedUDPPorts))
                && lib.all (range: dashboardPort < range.from || dashboardPort > range.to) (
                  allowList.allowedTCPPortRanges ++ allowList.allowedUDPPortRanges
                )
              ) firewallAllowLists)
              "the dashboard port must never be opened in any firewall allow-list: it is reached only through tailscale serve";
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
          servesDashboardOnTailnet =
            host:
            let
              unit = host.config.systemd.services.forge-frontend-tailnet;
              tailscaleBin = lib.getExe host.config.services.tailscale.package;
              port = toString host.config.forge.runtime.dashboardPort;
            in
            (host.config.systemd.services ? forge-frontend-tailnet)
            && unit.wantedBy == [ "multi-user.target" ]
            && lib.all (dependency: lib.elem dependency unit.after && lib.elem dependency unit.wants) [
              "tailscaled-autoconnect.service"
              "forge-frontend.service"
            ]
            && unit.serviceConfig.ExecStart == "${tailscaleBin} serve --https=443 http://127.0.0.1:${port}"
            && unit.serviceConfig.Restart == "always"
            && unit.serviceConfig.NoNewPrivileges == true
            && unit.serviceConfig.ProtectSystem == "strict"
            && unit.serviceConfig.ProtectHome == true
            && unit.serviceConfig.PrivateTmp == true
            && unit.serviceConfig.RestrictSUIDSGID == true
            && unit.serviceConfig.ProtectKernelTunables == true
            && unit.serviceConfig.ProtectControlGroups == true
            && unit.serviceConfig.CapabilityBoundingSet == ""
            && !(unit.serviceConfig ? ReadWritePaths)
            &&
              unit.serviceConfig.InaccessiblePaths == [
                "/run/secrets"
                "/run/secrets.d"
              ]
            && unit.serviceConfig.RestrictAddressFamilies == [ "AF_UNIX" ]
            && unit.serviceConfig.IPAddressDeny == "any";
          frontendOffTailnetWithoutTailscale =
            let
              host = mkHost {
                configFile = exampleConfigFile;
                secretsFile = exampleSecretsFile;
                modules = [
                  {
                    services.tailscale.enable = lib.mkForce false;
                    forge.runtime.repositories.forge.github = "rameezk/forge";
                  }
                ];
              };
            in
            lib.asserts.assertMsg (
              (host.config.systemd.services ? forge-frontend)
              && !(host.config.systemd.services ? forge-frontend-tailnet)
            ) "a host without tailscale must run the dashboard without a tailscale serve unit";
          frontendOnTailnet = lib.asserts.assertMsg (servesDashboardOnTailnet workerHost) "declaring a worker must serve the localhost dashboard over HTTPS on the tailnet through a supervised tailscale serve unit, locked down to talking to tailscaled over its local socket with no capabilities, no writable paths and blind to the secrets";

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
          frontierTokenTemplate = repositoryHost.config.sops.templates."forge-github.env";
          frontierTokenFromSops =
            lib.asserts.assertMsg
              (
                frontierService.serviceConfig.EnvironmentFile == frontierTokenTemplate.path
                && lib.hasPrefix "/run/secrets/" frontierTokenTemplate.path
                && frontierTokenTemplate.owner == "forge-runtime"
                && frontierTokenTemplate.mode == "0400"
                &&
                  frontierTokenTemplate.content
                  == "GITHUB_TOKEN=${repositoryHost.config.sops.placeholder.github_token}\n"
                && repositoryHost.config.sops.secrets.github_token.sopsFile == exampleSecretsFile
                && !(workerHost.config.sops.secrets ? github_token)
              )
              "the sync service must load only GITHUB_TOKEN as a required EnvironmentFile, from a sops template of the runtime secrets file's github_token under /run/secrets readable only by forge-runtime, and a host without repositories must not need github_token";
          frontierCommandReadsSopsToken =
            let
              command = lib.findFirst (
                package: lib.getName package == "forge-frontier"
              ) null repositoryHost.config.environment.systemPackages;
            in
            lib.asserts.assertMsg (
              command != null && lib.hasInfix frontierTokenTemplate.path command.text
            ) "the forge-frontier command must read GITHUB_TOKEN from the frontier token's sops template";
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
                && servesDashboardOnTailnet repositoryHost
                && !(repositoryHost.config.systemd.services ? "forge-runner@")
              )
              "declaring repositories without workers must run the dashboard, locked down as before and served on the tailnet, and no runner";

          repositoryModule = {
            forge.runtime.repositories.forge.github = "rameezk/forge";
          };
          gitIdentity = {
            name = "Forge Operator";
            email = "operator@example.com";
          };
          dispatchModuleWith =
            {
              prompt ? "/work-on {url}",
              dispatch ? { inherit gitIdentity; },
            }:
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
            };
          dispatchModule = dispatchModuleWith { };
          secretsHost =
            secretsFile: module:
            mkHost {
              configFile = exampleConfigFile;
              inherit secretsFile;
              modules = [ module ];
            };
          dispatchHostWith = args: secretsHost exampleSecretsFile (dispatchModuleWith args);
          dispatchHost = secretsHost exampleSecretsFile dispatchModule;
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
          dispatchConfigReflectsGitIdentity =
            lib.asserts.assertMsg
              (
                dispatchHost.config.forge.runtime.settings.dispatch == {
                  inherit gitIdentity;
                  maxConcurrent = 1;
                }
                && !(workerAndRepositoryHost.config.forge.runtime.settings ? dispatch)
              )
              "the generated runtime config must carry the dispatch git identity and a concurrency limit of 1 by default on a host that dispatches, and no dispatch settings on one that does not";
          concurrentDispatchHost = dispatchHostWith {
            dispatch = {
              inherit gitIdentity;
              maxConcurrent = 3;
            };
          };
          dispatchConfigReflectsMaxConcurrent =
            lib.asserts.assertMsg
              (
                evaluates concurrentDispatchHost
                && concurrentDispatchHost.config.forge.runtime.settings.dispatch.maxConcurrent == 3
                && !(evaluates (dispatchHostWith {
                  dispatch = {
                    inherit gitIdentity;
                    maxConcurrent = 0;
                  };
                }))
              )
              "a host built with mkHost { modules } that sets dispatch.maxConcurrent must carry it into the runtime config, and a limit below 1 must fail evaluation";
          passUnit = dispatchHost.config.systemd.services.forge-dispatch-pass;
          dispatchPassFollowsSync =
            lib.asserts.assertMsg
              (
                lib.elem "forge-dispatch-pass.service" dispatchHostSync.wants
                && lib.elem "forge-dispatch-pass.service" dispatchHostSync.before
                && !(lib.elem "forge-dispatch-pass.service" frontierService.wants)
                && !(workerAndRepositoryHost.config.systemd.services ? forge-dispatch-pass)
              )
              "on a host that dispatches, every frontier sync must pull in the dispatch pass and finish before it starts, and a host that does not dispatch must have no pass";
          dispatchPassStartsUnits =
            lib.asserts.assertMsg
              (
                passUnit.serviceConfig.Type == "oneshot"
                &&
                  passUnit.serviceConfig.ExecStart
                  == "${dispatchHost.config.forge.runtime.package}/bin/forge-dispatch-pass"
                && passUnit.serviceConfig.User == "forge-runtime"
                && passUnit.serviceConfig.Group == "forge-runtime"
                && lib.any (e: lib.hasInfix "FORGE_RUNTIME_CONFIG=" e) passUnit.serviceConfig.Environment
                && lib.elem "FORGE_STATE_DIR=/var/lib/forge" passUnit.serviceConfig.Environment
                && lib.elem "FORGE_SYSTEMCTL=${dispatchHost.config.systemd.package}/bin/systemctl" passUnit.serviceConfig.Environment
                && isHardened passUnit
                && passUnit.serviceConfig.RestrictAddressFamilies == [ "AF_UNIX" ]
                && passUnit.serviceConfig.IPAddressDeny == "any"
                && passUnit.serviceConfig.PrivateNetwork
                && passUnit.serviceConfig.PrivateDevices
                && passUnit.serviceConfig.ProtectKernelModules
                && passUnit.serviceConfig.ProtectKernelLogs
                && passUnit.serviceConfig.ProtectClock
                && passUnit.serviceConfig.ProtectHostname
                && passUnit.serviceConfig.RestrictNamespaces
                && passUnit.serviceConfig.LockPersonality
                && passUnit.serviceConfig.CapabilityBoundingSet == ""
                && passUnit.serviceConfig.SystemCallArchitectures == "native"
                && passUnit.serviceConfig.SystemCallFilter == [ "@system-service" ]
                && !(passUnit.serviceConfig ? EnvironmentFile)
                && !(passUnit.serviceConfig ? LoadCredential)
              )
              "the dispatch pass must be a hardened oneshot running forge-dispatch-pass as forge-runtime with systemctl, no network, devices, namespaces, capabilities or secrets, and only the system-service calls: it holds the polkit grant to start forge-dispatch units";
          dispatchPolkitRule = dispatchHost.config.security.polkit.extraConfig;
          dispatchPassMayStartOnlyDispatchUnits =
            lib.asserts.assertMsg
              (
                dispatchHost.config.security.polkit.enable
                && lib.hasInfix ''subject.user == "forge-runtime"'' dispatchPolkitRule
                && lib.hasInfix ''action.lookup("verb") == "start"'' dispatchPolkitRule
                && lib.hasInfix ''/^forge-dispatch@(?:forge):[1-9][0-9]*\.service$/'' dispatchPolkitRule
                && !(lib.hasInfix "forge-runtime" workerAndRepositoryHost.config.security.polkit.extraConfig)
              )
              "on a host that dispatches, polkit must let forge-runtime only start forge-dispatch@ units of declared repositories, and a host that does not dispatch must grant it nothing";
          missingGitIdentityFails =
            let
              host = dispatchHostWith { dispatch = { }; };
            in
            lib.asserts.assertMsg
              (
                !(evaluates host)
                && lib.any (lib.hasInfix "forge.runtime.dispatch.gitIdentity") (failedAssertions host)
              )
              "a repository that declares a worker on a host with no dispatch git identity must fail evaluation";
          dispatchHostEvaluates = lib.asserts.assertMsg (
            evaluates dispatchHost
            && evaluates (dispatchHostWith {
              prompt = "Build {repo}#{issue}";
            })
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
          dispatchUnitSandboxed = lib.asserts.assertMsg (isWorkloadHardened dispatchUnit) "the dispatch unit must be sandboxed like the runner";
          writeTokenTemplate = dispatchHost.config.sops.templates."forge-github-write.env";
          readsWriteTokenAsCredential =
            unit:
            unit.serviceConfig.LoadCredential == [ "github-write-token:${writeTokenTemplate.path}" ]
            && lib.elem "FORGE_GITHUB_WRITE_TOKEN_FILE=%d/github-write-token" unit.serviceConfig.Environment;
          dispatchFrontierToken = dispatchHost.config.sops.templates."forge-github.env".path;
          writeTokenFromSops =
            lib.asserts.assertMsg
              (
                lib.hasPrefix "/run/secrets/" writeTokenTemplate.path
                && writeTokenTemplate.owner == "forge-runtime"
                && writeTokenTemplate.mode == "0400"
                &&
                  writeTokenTemplate.content
                  == "GITHUB_TOKEN=${dispatchHost.config.sops.placeholder.github_write_token}\n"
                && dispatchHost.config.sops.secrets.github_write_token.sopsFile == exampleSecretsFile
                && writeTokenTemplate.path != dispatchFrontierToken
                && !(workerAndRepositoryHost.config.sops.secrets ? github_write_token)
              )
              "the GitHub write token must be its own sops template of the runtime secrets file's github_write_token under /run/secrets, readable only by forge-runtime, and a host that does not dispatch must not need github_write_token";
          dispatchUnitEnvironmentFiles =
            lib.asserts.assertMsg
              (
                dispatchUnit.serviceConfig.EnvironmentFile
                == dispatchHost.config.sops.templates."forge-runner.env".path
                && readsWriteTokenAsCredential dispatchUnit
              )
              "the dispatch unit must load only the runner's OpenRouter key as an EnvironmentFile, and read the GitHub write token's sops template as data, through its own credential";
          dispatchHostSync = dispatchHost.config.systemd.services.forge-frontier-sync;
          frontierSyncEnsuresLabels =
            lib.asserts.assertMsg
              (
                readsWriteTokenAsCredential dispatchHostSync
                && dispatchHostSync.serviceConfig.EnvironmentFile == dispatchFrontierToken
                && !(lib.any (lib.hasInfix "FORGE_GITHUB_WRITE_TOKEN_FILE") frontierService.serviceConfig.Environment)
                && !(frontierService.serviceConfig ? LoadCredential)
              )
              "on a host that dispatches, the sync service must read the GitHub write token's sops template as data, through its own credential, to ensure the forge labels, while polling with the frontier's read-only token; a host that does not dispatch must not give it the write token";
          forgeServices =
            host: lib.filterAttrs (name: _: lib.hasPrefix "forge" name) host.config.systemd.services;
          environmentFiles = unit: lib.toList (unit.serviceConfig.EnvironmentFile or [ ]);
          writeTokenNeverLoaded = lib.asserts.assertMsg (lib.all
            (unit: !(lib.elem writeTokenTemplate.path (environmentFiles unit)))
            (lib.attrValues (forgeServices dispatchHost))
          ) "no unit may load the GitHub write token as an EnvironmentFile: it is read only as data";
          noHandPlacedTokens =
            let
              mentionsHandPlacedPath =
                text:
                lib.hasInfix "/var/lib/forge/github.env" text || lib.hasInfix "/var/lib/forge-credentials" text;
              unitMentions =
                unit:
                lib.any mentionsHandPlacedPath (environmentFiles unit ++ (unit.serviceConfig.Environment or [ ]));
            in
            lib.asserts.assertMsg
              (
                !(dispatchHost.options.forge.runtime ? githubTokenFile)
                && !(dispatchHost.options.forge.runtime ? githubWriteTokenFile)
                && !(lib.any unitMentions (lib.attrValues (forgeServices dispatchHost)))
              )
              "the githubTokenFile and githubWriteTokenFile options must be gone, and no unit may read a token from the state directory or /var/lib/forge-credentials: both GitHub tokens come only from sops";
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

          tailscale = nixos.config.services.tailscale;
          tailnetJoined =
            lib.asserts.assertMsg
              (
                tailscale.enable
                && tailscale.authKeyFile == nixos.config.sops.secrets.tailscale_auth_key.path
                && nixos.config.sops.secrets.tailscale_auth_key.sopsFile == exampleSecretsFile
                && tailscale.authKeyParameters.preauthorized == true
                && tailscale.authKeyParameters.ephemeral == false
                && lib.all (flag: lib.elem flag tailscale.extraUpFlags) [
                  "--advertise-tags=tag:forge"
                  "--hostname=${exampleCfg.hostname}"
                ]
              )
              "every box must join the tailnet as a preauthorized, non-ephemeral device tagged tag:forge under its config hostname, authenticating with tailscale_auth_key from the runtime secrets file";
          tailnetAddresses = [
            "100.64.0.0/10"
            "fd7a:115c:a1e0::/48"
          ];
          workloadsOffTailnet =
            lib.asserts.assertMsg
              (
                runnerUnit.serviceConfig.IPAddressDeny == tailnetAddresses
                && dispatchUnit.serviceConfig.IPAddressDeny == tailnetAddresses
                && workerHost.config.systemd.services.nix-daemon.serviceConfig.IPAddressDeny == tailnetAddresses
                && lib.elem "--accept-dns=false" tailscale.extraUpFlags
              )
              "a workload must not reach the tailnet: the runner and dispatch units, and the nix daemon whose builds a workload can start, deny every tailnet address, and the box keeps its own DNS rather than the tailnet's resolver, so workloads still resolve names";
          sshFirewall = nixos.config.networking.firewall;
          sshPort = exampleCfg.sshPort;
          tailnetInterface = tailscale.interfaceName;
          publiclyOpen =
            port: allowList:
            lib.elem port allowList.allowedTCPPorts
            || lib.any (range: range.from <= port && port <= range.to) allowList.allowedTCPPortRanges;
          sshOnlyOnTailnet =
            lib.asserts.assertMsg
              (
                sshFirewall.enable
                && lib.elem "--netfilter-mode=off" tailscale.extraUpFlags
                && lib.elem "--netfilter-mode=off" tailscale.extraSetFlags
                && !(publiclyOpen sshPort sshFirewall)
                && sshFirewall.interfaces.${tailnetInterface}.allowedTCPPorts == [ sshPort ]
                && sshFirewall.interfaces.${tailnetInterface}.allowedTCPPortRanges == [ ]
                && sshFirewall.interfaces.${tailnetInterface}.allowedUDPPorts == [ ]
                && sshFirewall.interfaces.${tailnetInterface}.allowedUDPPortRanges == [ ]
                && !(lib.elem tailnetInterface sshFirewall.trustedInterfaces)
                && lib.all (
                  name: name == tailnetInterface || !(publiclyOpen sshPort sshFirewall.interfaces.${name})
                ) (lib.attrNames sshFirewall.interfaces)
              )
              "sshPort must be open only on the tailscale interface, closed on the public firewall, with nothing else opened on the tailscale interface and the interface not trusted as a whole, and tailscaled must leave netfilter to the enabled NixOS firewall from its first login and again on every boot, so its own rules cannot accept everything arriving on the tailscale interface";
          tailnetDirect = lib.asserts.assertMsg (lib.elem 41641 nixos.config.networking.firewall.allowedUDPPorts) "public UDP 41641 must be open, so the operator's devices can connect to the box directly";
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

          box-tailnet =
            assert tailnetJoined;
            assert tailnetDirect;
            assert sshOnlyOnTailnet;
            assert workloadsOffTailnet;
            pkgs.runCommand "box-tailnet" { } ''
              echo "every box joins the tailnet as tag:forge under its config hostname with tailscale_auth_key from the runtime secrets file, with public UDP 41641 open for direct connections and SSH open only on the tailscale interface, while workloads and the builds they start reach no tailnet address and the box keeps its own DNS" > $out
            '';

          runtime-foundation =
            assert runtimeModuleComposed;
            assert runtimeUserDefined;
            assert stateDirProvisioned;
            assert runtimeInert;
            assert handPlacedTokensRemoved;
            assert sandboxSupported;
            assert runtimeHomeEmpty;
            pkgs.runCommand "runtime-foundation" { } ''
              echo "forge.runtime composed and inert; forge-runtime user with an empty home and /var/lib/forge state dir provisioned; user namespaces allowed for the workload sandbox; hand-placed GitHub token files removed" > $out
            '';

          runtime-nix =
            assert flakesEnabled;
            assert storeCollectedWeekly;
            assert nixInToolset;
            assert runtimeNeverTrusted;
            pkgs.runCommand "runtime-nix" { } ''
              echo "flakes enabled box-wide; the store collected weekly, deleting anything older than 14 days; nix in the base workload toolset; forge-runtime never a trusted nix user" > $out
            '';

          runtime-runner =
            assert runnerUnitDeclared;
            assert runnerInvokesWorker;
            assert runnerSandboxed;
            assert runnerKeyFromSops;
            assert runnerKeyOnly;
            assert noOpenRouterKeyFileOption;
            assert workerHostInstantiates;
            assert relativeHarnessCommandFails;
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
            assert frontendOnTailnet;
            assert frontendOffTailnetWithoutTailscale;
            pkgs.runCommand "runtime-dashboard" { } ''
              echo "declaring a worker wires an always-on forge-frontend dashboard bound to localhost, opening no public port, and served over HTTPS on the tailnet through tailscale serve" > $out
            '';

          runtime-frontier =
            assert frontierDeclared;
            assert frontierSyncs;
            assert frontierSandboxed;
            assert frontierTokenFromSops;
            assert frontierCommandReadsSopsToken;
            assert frontierEnvWired;
            assert frontierPollsAtInterval;
            assert frontierDefaultInterval;
            assert frontierConfigReflectsRepositories;
            assert noRepositoriesNoPoller;
            assert dashboardWithoutWorkers;
            assert frontierCommandInstalled;
            pkgs.runCommand "runtime-frontier" { } ''
              echo "declaring a repository wires a forge-frontier-sync timer and service with the GitHub token from a sops template, puts forge-frontier on the path reading the same token, and runs the dashboard without workers" > $out
            '';

          runtime-dispatch =
            assert dispatchConfigReflectsWorker;
            assert dispatchConfigReflectsGitIdentity;
            assert dispatchConfigReflectsMaxConcurrent;
            assert dispatchPassFollowsSync;
            assert dispatchPassStartsUnits;
            assert dispatchPassMayStartOnlyDispatchUnits;
            assert missingGitIdentityFails;
            assert dispatchHostEvaluates;
            assert placeholderlessWorkerFails;
            assert undeclaredWorkerFails;
            assert dispatchUnitDeclared;
            assert dispatchUnitRunsDispatch;
            assert dispatchUnitSandboxed;
            assert dispatchUnitEnvironmentFiles;
            assert frontierSyncEnsuresLabels;
            assert writeTokenFromSops;
            assert writeTokenNeverLoaded;
            assert noHandPlacedTokens;
            assert dispatchCommandInstalled;
            pkgs.runCommand "runtime-dispatch" { } ''
              echo "a repository's worker wires a forge-dispatch@ oneshot, the forge-dispatch command, the GitHub write token from sops, and a dispatch pass after every frontier sync that may start only forge-dispatch@ units, bounded by dispatch.maxConcurrent; a worker without a ticket placeholder fails evaluation" > $out
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
          runtime-secrets = pkgs.callPackage ./infra/nix/runtime-secrets-check.nix {
            inherit (sops-nix.packages.${system}) sops-install-secrets;
            cases = [
              {
                name = "repository-without-github-token";
                host = secretsHost ./tests/fixtures/runtime-secrets-without-github.yaml repositoryModule;
                refusedKey = "github_token";
              }
              {
                name = "repository-without-write-token";
                host = secretsHost ./tests/fixtures/runtime-secrets-without-github-write.yaml repositoryModule;
              }
              {
                name = "dispatch-without-write-token";
                host = secretsHost ./tests/fixtures/runtime-secrets-without-github-write.yaml dispatchModule;
                refusedKey = "github_write_token";
              }
              {
                name = "box-without-tailscale-key";
                host = secretsHost ./tests/fixtures/runtime-secrets-without-tailscale.yaml dispatchModule;
                refusedKey = "tailscale_auth_key";
              }
              {
                name = "dispatch-with-every-token";
                host = secretsHost exampleSecretsFile dispatchModule;
              }
            ];
          };
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
          github-tokens = pkgs.callPackage ./infra/nix/github-tokens.nix {
            sopsModule = sops-nix.nixosModules.sops;
            secretsFile = exampleSecretsFile;
            secretsHostKey = ./tests/fixtures/ssh_host_ed25519_key;
          };
          workload-sandbox = pkgs.callPackage ./infra/nix/workload-sandbox.nix {
            forge-runner = self.packages.${system}.forge-runner;
            sopsModule = sops-nix.nixosModules.sops;
            secretsFile = exampleSecretsFile;
            secretsHostKey = ./tests/fixtures/ssh_host_ed25519_key;
          };
          automatic-dispatch = pkgs.callPackage ./infra/nix/automatic-dispatch.nix {
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
