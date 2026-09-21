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
        }
      );

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
          ) "forge.runtime must stay inert: no systemd service until later slices declare workers";
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

          forge-shared = self.packages.${system}.forge-shared;
        }
      );
    };
}
