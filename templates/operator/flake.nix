{
  description = "Forge Operator";

  inputs = {
    forge.url = "github:rameezk/forge";
    nixpkgs.follows = "forge/nixpkgs";
  };

  outputs =
    {
      self,
      forge,
      nixpkgs,
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

      configFile = ./config.json;
      cfg = forge.lib.loadConfig configFile;
      exampleCfg = forge.lib.loadConfig ./config.example.json;

      configIsFilled =
        lib.asserts.assertMsg (cfg.sshPublicKeys != exampleCfg.sshPublicKeys)
          "config.json still holds the example placeholder SSH key; replace it with your own before building";

      secretsFile = ./secrets/runtime.yaml;
      secretsArePresent = lib.asserts.assertMsg (builtins.pathExists secretsFile) "secrets/runtime.yaml is missing; create it with sops and track it in git before building";
      recipientsAreFilled =
        lib.asserts.assertMsg (!(lib.hasInfix "REPLACE_WITH_" (builtins.readFile ./.sops.yaml)))
          ".sops.yaml still holds the placeholder recipients; replace them with your operator age key and the box's age recipient before building";

      host = forge.lib.mkHost { inherit configFile secretsFile; };
      # Declare a worker to turn this box into a runnable forge host. Pass inline
      # NixOS modules to mkHost; each sets forge.runtime.* and installs the harness
      # binary. Uncomment and adapt:
      #
      #   host = forge.lib.mkHost {
      #     inherit configFile secretsFile;
      #     modules = [
      #       (
      #         { pkgs, ... }:
      #         {
      #           forge.runtime.harnesses.pi.command = "/run/current-system/sw/bin/pi";
      #           forge.runtime.workers.refiner = {
      #             harness = "pi";
      #             model = "anthropic/claude-opus-4";
      #             prompt = "refine the spec";
      #           };
      #           environment.systemPackages = [ pkgs.pi-coding-agent ];
      #         }
      #       )
      #     ];
      #   };
      actualKeys = host.config.users.users.${cfg.adminUser}.openssh.authorizedKeys.keys;
      actualHostName = host.config.networking.hostName;

      keysReflectConfig = lib.asserts.assertMsg (
        actualKeys == cfg.sshPublicKeys
      ) "built authorized keys for '${cfg.adminUser}' do not match config.json sshPublicKeys";
      hostNameReflectsConfig = lib.asserts.assertMsg (
        actualHostName == cfg.hostname
      ) "built hostName '${actualHostName}' does not match config.json hostname '${cfg.hostname}'";
    in
    {
      nixosConfigurations.${cfg.hostname} =
        assert configIsFilled;
        assert secretsArePresent;
        assert recipientsAreFilled;
        host;

      lib.reflect = {
        hostname = actualHostName;
        authorizedKeys = actualKeys;
        adminUser = cfg.adminUser;
        sshPort = builtins.head host.config.services.openssh.ports;
      };

      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          reflect-config =
            assert configIsFilled;
            assert secretsArePresent;
            assert recipientsAreFilled;
            assert keysReflectConfig;
            assert hostNameReflectsConfig;
            pkgs.runCommand "reflect-config" { } ''
              echo "built host authorized keys and hostname reflect config.json" > $out
            '';
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = forge.lib.operatorToolchain system;
          };
        }
      );
    };
}
