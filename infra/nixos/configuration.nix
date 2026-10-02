{
  config,
  lib,
  modulesPath,
  forgeConfig,
  ...
}:
let
  hostKey = "/etc/ssh/ssh_host_ed25519_key";
in
{
  imports = [ (modulesPath + "/profiles/qemu-guest.nix") ];

  networking.hostName = forgeConfig.hostname;
  networking.useDHCP = lib.mkDefault true;

  time.timeZone = forgeConfig.timezone;
  i18n.defaultLocale = forgeConfig.locale;

  users.users.${forgeConfig.adminUser} = {
    isNormalUser = true;
    extraGroups = [ "wheel" ];
    openssh.authorizedKeys.keys = forgeConfig.sshPublicKeys;
  };

  security.sudo.wheelNeedsPassword = false;

  services.openssh = {
    enable = true;
    ports = [ forgeConfig.sshPort ];
    settings = {
      PasswordAuthentication = false;
      PermitRootLogin = "no";
    };
    hostKeys = [
      {
        path = hostKey;
        type = "ed25519";
      }
    ];
  };

  sops.age.sshKeyPaths = [ hostKey ];

  sops.secrets.tailscale_auth_key.sopsFile = config.forge.runtime.secretsFile;

  services.tailscale = {
    enable = true;
    openFirewall = true;
    authKeyFile = config.sops.secrets.tailscale_auth_key.path;
    authKeyParameters = {
      preauthorized = true;
      ephemeral = false;
    };
    extraUpFlags = [
      "--advertise-tags=tag:forge"
      "--hostname=${forgeConfig.hostname}"
      "--accept-dns=false"
    ];
  };

  boot.loader.grub = {
    enable = true;
    efiSupport = false;
  };

  system.stateVersion = forgeConfig.nixosRelease;
}
