{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

    disko.url = "github:nix-community/disko";
    disko.inputs.nixpkgs.follows = "nixpkgs";

    nixos-anywhere.url = "github:nix-community/nixos-anywhere";
    nixos-anywhere.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      self,
      nixpkgs,
      disko,
      nixos-anywhere,
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
          modules ? [ ],
        }:
        let
          cfg = loadConfig configFile;
        in
        lib.nixosSystem {
          system = cfg.arch;
          modules = [
            disko.nixosModules.disko
            ./infra/nixos/configuration.nix
            ./infra/nixos/disko.nix
            ./infra/nixos/runtime.nix
            { nixpkgs.overlays = [ runnerOverlay ]; }
            { _module.args.forgeConfig = cfg; }
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
          };
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          exampleConfigFile = ./infra/config.example.json;
          exampleCfg = loadConfig exampleConfigFile;
          nixos = mkHost { configFile = exampleConfigFile; };
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
          runnerSandboxed =
            lib.asserts.assertMsg
              (
                runnerUnit.serviceConfig.NoNewPrivileges == true
                && runnerUnit.serviceConfig.ProtectSystem == "strict"
                && runnerUnit.serviceConfig.ProtectHome == true
                && runnerUnit.serviceConfig.PrivateTmp == true
                && runnerUnit.serviceConfig.ReadWritePaths == [ "/var/lib/forge" ]
                && runnerUnit.serviceConfig.RestrictSUIDSGID == true
                && runnerUnit.serviceConfig.ProtectKernelTunables == true
                && runnerUnit.serviceConfig.ProtectControlGroups == true
              )
              "the runner unit must be sandboxed: no new privileges, protected system and home, private tmp, and writable only under the state directory";
          runnerKeyOutOfStore = lib.asserts.assertMsg (
            runnerUnit.serviceConfig.EnvironmentFile == "/var/lib/forge/openrouter.env"
            && !(lib.hasPrefix builtins.storeDir runnerUnit.serviceConfig.EnvironmentFile)
          ) "the OpenRouter key must reach the runner via an EnvironmentFile outside the Nix store";
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
            unit.serviceConfig.NoNewPrivileges == true
            && unit.serviceConfig.ProtectSystem == "strict"
            && unit.serviceConfig.ProtectHome == true
            && unit.serviceConfig.PrivateTmp == true
            && unit.serviceConfig.ReadWritePaths == [ "/var/lib/forge" ]
            && unit.serviceConfig.RestrictSUIDSGID == true
            && unit.serviceConfig.ProtectKernelTunables == true
            && unit.serviceConfig.ProtectControlGroups == true
            &&
              unit.serviceConfig.RestrictAddressFamilies == [
                "AF_INET"
                "AF_INET6"
                "AF_UNIX"
              ]
            && unit.serviceConfig.IPAddressAllow == "localhost"
            && unit.serviceConfig.IPAddressDeny == "any";
          frontendSandboxed = lib.asserts.assertMsg (frontendIsLockedDown frontendUnit) "the dashboard unit must be sandboxed like the runner";

          repositoryHost = mkHost {
            configFile = exampleConfigFile;
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
          frontierSandboxed = lib.asserts.assertMsg (
            frontierService.serviceConfig.NoNewPrivileges == true
            && frontierService.serviceConfig.ProtectSystem == "strict"
            && frontierService.serviceConfig.ProtectHome == true
            && frontierService.serviceConfig.PrivateTmp == true
            && frontierService.serviceConfig.ReadWritePaths == [ "/var/lib/forge" ]
            && frontierService.serviceConfig.RestrictSUIDSGID == true
            && frontierService.serviceConfig.ProtectKernelTunables == true
            && frontierService.serviceConfig.ProtectControlGroups == true
          ) "the sync service must be sandboxed like the runner";
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
          dashboardWithoutWorkers =
            lib.asserts.assertMsg
              (
                (repositoryHost.config.systemd.services ? forge-frontend)
                && frontendIsLockedDown repositoryHost.config.systemd.services.forge-frontend
                && !(repositoryHost.config.systemd.services ? "forge-runner@")
              )
              "declaring repositories without workers must run the dashboard, locked down as before, and no runner";
        in
        {
          example-reflects-config =
            assert hostNameMatches;
            assert keysMatch;
            assert rootLoginDisabled;
            assert rootHasNoKeys;
            assert instantiates;
            pkgs.runCommand "example-reflects-config" { } ''
              echo "example host reflects config.example.json; root login disabled" > $out
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
            assert runnerKeyOutOfStore;
            assert runnerEnvWired;
            assert runnerConfigReflectsWorker;
            assert runnerDefaultEffortOmitted;
            assert transcriptsProvisioned;
            pkgs.runCommand "runtime-runner" { } ''
              echo "declaring a worker wires a forge-runner@ oneshot invoking forge-run with an out-of-store OpenRouter key" > $out
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
            pkgs.runCommand "runtime-frontier" { } ''
              echo "declaring a repository wires a forge-frontier-sync timer and service with an optional GitHub token file, and runs the dashboard without workers" > $out
            '';

          forge-shared = self.packages.${system}.forge-shared;
          forge-runner = self.packages.${system}.forge-runner;
          pi-cli-contract = pkgs.callPackage ./infra/nix/pi-cli-contract.nix {
            forge-runner = self.packages.${system}.forge-runner;
          };
        }
        // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          runtime-toolset = pkgs.callPackage ./infra/nix/runtime-toolset.nix {
            forge-runner = self.packages.${system}.forge-runner;
          };
        }
      );
    };
}
