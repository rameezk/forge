{ lib, config, ... }:
let
  cfg = config.forge.runtime;
in
{
  options.forge.runtime = {
    user = lib.mkOption {
      type = lib.types.str;
      default = "forge-runtime";
      readOnly = true;
      description = "Dedicated service user that owns the runtime state and, in later slices, runs the runner and dashboard.";
    };

    stateDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/forge";
      readOnly = true;
      description = "State directory owned by the runtime service user, holding the SQLite store and per-run transcripts.";
    };
  };

  config = {
    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.user;
      home = cfg.stateDir;
      description = "Forge runtime service user";
    };
    users.groups.${cfg.user} = { };

    systemd.tmpfiles.rules = [
      "d ${cfg.stateDir} 0750 ${cfg.user} ${cfg.user} - -"
    ];
  };
}
