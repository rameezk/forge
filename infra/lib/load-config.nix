configFile:
let
  raw = builtins.fromJSON (builtins.readFile configFile);
  defaults = {
    nixosRelease = "26.05";
    timezone = "UTC";
    locale = "en_US.UTF-8";
    sshPort = 22;
    adminUser = "forge";
    baseImage = "debian-12";
    arch = "x86_64-linux";
    diskDevice = "/dev/sda";
  };
in
defaults // raw
