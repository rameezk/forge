{
  description = "Forge: declarative VPS substrate (OpenTofu provisions, Nix configures)";

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

      configFile =
        if builtins.pathExists ./infra/config.json then
          ./infra/config.json
        else
          ./infra/config.example.json;
      cfg = import ./infra/lib/load-config.nix configFile;

      hostName = cfg.hostname;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.opentofu
              pkgs.disko
              nixos-anywhere.packages.${system}.default
              pkgs.jq
            ];
          };
        }
      );

      nixosConfigurations.${hostName} = lib.nixosSystem {
        system = cfg.arch;
        modules = [
          disko.nixosModules.disko
          ./infra/nixos/configuration.nix
          ./infra/nixos/disko.nix
          { _module.args.forgeConfig = cfg; }
        ];
      };

      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          nixos = self.nixosConfigurations.${hostName};
          actualHostName = nixos.config.networking.hostName;
          actualKeys = nixos.config.users.users.${cfg.adminUser}.openssh.authorizedKeys.keys;
          hostNameMatches = lib.asserts.assertMsg (
            actualHostName == cfg.hostname
          ) "NixOS hostName '${actualHostName}' does not match configured hostname '${cfg.hostname}'";
          keysMatch = lib.asserts.assertMsg (
            actualKeys == cfg.sshPublicKeys
          ) "NixOS authorized keys for '${cfg.adminUser}' do not match the configured sshPublicKeys";
          instantiates = builtins.seq nixos.config.system.build.toplevel.drvPath true;
        in
        {
          nixos-reflects-config =
            assert hostNameMatches;
            assert keysMatch;
            assert instantiates;
            pkgs.runCommand "nixos-reflects-config" { } ''
              echo "hostname and authorized keys match config" > $out
            '';
        }
      );
    };
}
