{
  lib,
  modulesPath,
  forgeConfig,
  ...
}:
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
  };

  boot.loader.grub = {
    enable = true;
    efiSupport = false;
  };

  system.stateVersion = forgeConfig.nixosRelease;
}
