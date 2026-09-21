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
        { configFile }:
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
          ];
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

          workerHost = lib.nixosSystem {
            system = exampleCfg.arch;
            modules = [
              disko.nixosModules.disko
              ./infra/nixos/configuration.nix
              ./infra/nixos/disko.nix
              ./infra/nixos/runtime.nix
              { nixpkgs.overlays = [ runnerOverlay ]; }
              { _module.args.forgeConfig = exampleCfg; }
              {
                forge.runtime.harnesses.pi = {
                  command = "/run/current-system/sw/bin/pi";
                  args = [ "run" ];
                };
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

          forge-shared = self.packages.${system}.forge-shared;
          forge-runner = self.packages.${system}.forge-runner;
        }
      );
    };
}
