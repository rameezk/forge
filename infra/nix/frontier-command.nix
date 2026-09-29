{
  lib,
  writeShellApplication,
  forge-runner,
  configFile,
  user,
  stateDir,
  githubTokenFile,
}:
let
  tokenFile = lib.escapeShellArg githubTokenFile;
in
writeShellApplication {
  name = "forge-frontier";
  excludeShellChecks = [ "SC1091" ];
  text = ''
    if [ ! -x "$(dirname ${tokenFile})" ] || { [ -e ${tokenFile} ] && [ ! -r ${tokenFile} ]; }; then
      echo "forge-frontier: cannot read ${githubTokenFile}; run it as the ${user} user: sudo -u ${user} forge-frontier $*" >&2
      exit 1
    fi
    if [ -e ${tokenFile} ]; then
      set -a
      . ${tokenFile}
      set +a
    fi
    export FORGE_RUNTIME_CONFIG=${lib.escapeShellArg configFile}
    export FORGE_STATE_DIR=${lib.escapeShellArg stateDir}
    exec ${lib.getExe' forge-runner "forge-frontier"} "$@"
  '';
  meta.description = "The box's forge-frontier command: runs forge-frontier against the generated runtime config, loading GITHUB_TOKEN from the GitHub token file.";
}
