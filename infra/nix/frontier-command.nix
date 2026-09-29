{
  lib,
  writeShellApplication,
  forge-runner,
  configFile,
  user,
  githubTokenFile,
}:
let
  tokenFile = lib.escapeShellArg githubTokenFile;
  tokenDir = lib.escapeShellArg (dirOf githubTokenFile);
in
writeShellApplication {
  name = "forge-frontier";
  text = ''
    if [ "$#" -ne 1 ] || [ "$1" != list ]; then
      echo "usage: forge-frontier list" >&2
      exit 2
    fi
    if { [ -e ${tokenDir} ] && [ ! -x ${tokenDir} ]; } || { [ -e ${tokenFile} ] && [ ! -r ${tokenFile} ]; }; then
      echo "forge-frontier: cannot read ${githubTokenFile}; run it as the ${user} user: sudo -u ${user} forge-frontier list" >&2
      exit 1
    fi
    if [ -e ${tokenFile} ] && [ ! -f ${tokenFile} ]; then
      echo "forge-frontier: ${githubTokenFile} is not a regular file" >&2
      exit 1
    fi
    trim() {
      local text="$1"
      text="''${text#"''${text%%[![:space:]]*}"}"
      printf '%s' "''${text%"''${text##*[![:space:]]}"}"
    }
    unset GITHUB_TOKEN
    if [ -e ${tokenFile} ]; then
      while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
          *=*)
            if [ "$(trim "''${line%%=*}")" = GITHUB_TOKEN ]; then
              GITHUB_TOKEN="$(trim "''${line#*=}")"
              case "$GITHUB_TOKEN" in
                \"*\" | \'*\') GITHUB_TOKEN="''${GITHUB_TOKEN:1:-1}" ;;
              esac
            fi
            ;;
        esac
      done < ${tokenFile}
    fi
    if [ -n "''${GITHUB_TOKEN-}" ]; then
      export GITHUB_TOKEN
    fi
    export FORGE_RUNTIME_CONFIG=${lib.escapeShellArg configFile}
    exec ${lib.getExe' forge-runner "forge-frontier"} list
  '';
  meta.description = "The box's forge-frontier command: lists the frontier live against the generated runtime config, reading GITHUB_TOKEN from the GitHub token file as data.";
}
