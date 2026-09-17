{
  lib,
  forgeConfig,
  ...
}:
{
  networking.hostName = forgeConfig.hostname;
  networking.useDHCP = lib.mkDefault true;

  time.timeZone = forgeConfig.timezone;
  i18n.defaultLocale = forgeConfig.locale;

  users.users.${forgeConfig.adminUser} = {
    isNormalUser = true;
    extraGroups = [ "wheel" ];
    openssh.authorizedKeys.keys = forgeConfig.sshPublicKeys;
  };

  users.users.root.openssh.authorizedKeys.keys = forgeConfig.sshPublicKeys;

  security.sudo.wheelNeedsPassword = false;

  services.openssh = {
    enable = true;
    ports = [ forgeConfig.sshPort ];
    settings = {
      PasswordAuthentication = false;
      PermitRootLogin = "prohibit-password";
    };
  };

  boot.loader.grub = {
    enable = true;
    efiSupport = false;
  };

  system.stateVersion = forgeConfig.nixosRelease;
}
