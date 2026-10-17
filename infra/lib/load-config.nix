configFile:
let
  raw = builtins.fromJSON (builtins.readFile configFile);
  defaults = {
    nixosRelease = "26.05";
    locale = "en_US.UTF-8";
    sshPort = 22;
    adminUser = "forge";
    arch = "x86_64-linux";
    diskDevice = "/dev/sda";
  };
in
if raw ? timezone then
  throw "config.json sets 'timezone', which is no longer supported: the box is fixed to UTC. Remove it, and set forge.runtime.dashboard.timeZone to choose the time zone the dashboard shows"
else
  defaults // raw
