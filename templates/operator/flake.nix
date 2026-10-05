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

      knownHostsFile = ./known_hosts;
      hostPublicKeyFile = ./secrets/host.pub;
      hostKeyIsPinned =
        lib.asserts.assertMsg
          (
            builtins.pathExists knownHostsFile
            && builtins.pathExists hostPublicKeyFile
            &&
              lib.trim (builtins.readFile knownHostsFile)
              == "${cfg.hostname} ${lib.trim (builtins.readFile hostPublicKeyFile)}"
          )
          "known_hosts must be a single line pinning secrets/host.pub under the hostname '${cfg.hostname}'; write it as the README's setup steps describe before building";

      repoIsReady = configIsFilled && secretsArePresent && recipientsAreFilled && hostKeyIsPinned;

      host = forge.lib.mkHost { inherit configFile secretsFile; };
      # Declare a worker to turn this box into a runnable forge host. Pass inline
      # NixOS modules to mkHost; each sets forge.runtime.* and installs the harness
      # binary. A ticket is dispatchable once its repository names a worker whose
      # prompt takes the ticket as {url}. Uncomment and adapt:
      #
      # forge:example-begin
      #   host = forge.lib.mkHost {
      #     inherit configFile secretsFile;
      #     modules = [
      #       (
      #         { pkgs, ... }:
      #         {
      #           forge.runtime.harnesses.pi.command = "/run/current-system/sw/bin/pi";
      #           forge.runtime.workers.builder = {
      #             harness = "pi";
      #             model = "anthropic/claude-sonnet-5.5";
      #             prompt = "/work-on {url}";
      #           };
      #           forge.runtime.repositories.myrepo = {
      #             github = "your-org/your-repo";
      #             worker = "builder";
      #           };
      #           forge.runtime.dispatch.gitIdentity = {
      #             name = "Your Name";
      #             email = "you@example.com";
      #           };
      #           environment.systemPackages = [ pkgs.pi-coding-agent ];
      #         }
      #       )
      #     ];
      #   };
      # forge:example-end
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
        assert repoIsReady;
        host;

      lib.reflect =
        assert repoIsReady;
        {
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
            assert repoIsReady;
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
