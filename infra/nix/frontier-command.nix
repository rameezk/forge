{
  lib,
  writeShellApplication,
  forge-runner,
  configFile,
  user,
  githubAppIdFile,
  githubAppPrivateKeyFile,
}:
let
  idFile = lib.escapeShellArg githubAppIdFile;
  idDir = lib.escapeShellArg (dirOf githubAppIdFile);
  keyFile = lib.escapeShellArg githubAppPrivateKeyFile;
  keyDir = lib.escapeShellArg (dirOf githubAppPrivateKeyFile);
  refuse = file: ''
    echo "forge-frontier: cannot read ${file}; run it as the ${user} user: sudo -u ${user} forge-frontier list" >&2
    exit 1
  '';
in
writeShellApplication {
  name = "forge-frontier";
  text = ''
    if [ "$#" -ne 1 ] || [ "$1" != list ]; then
      echo "usage: forge-frontier list" >&2
      exit 2
    fi
    if { [ -e ${idDir} ] && [ ! -x ${idDir} ]; } || { [ -e ${idFile} ] && [ ! -r ${idFile} ]; }; then
      ${refuse githubAppIdFile}
    fi
    if { [ -e ${keyDir} ] && [ ! -x ${keyDir} ]; } || { [ -e ${keyFile} ] && [ ! -r ${keyFile} ]; }; then
      ${refuse githubAppPrivateKeyFile}
    fi
    if [ -e ${idFile} ] && [ ! -f ${idFile} ]; then
      echo "forge-frontier: ${githubAppIdFile} is not a regular file" >&2
      exit 1
    fi
    if [ -e ${keyFile} ] && [ ! -f ${keyFile} ]; then
      echo "forge-frontier: ${githubAppPrivateKeyFile} is not a regular file" >&2
      exit 1
    fi
    trim() {
      local text="$1"
      text="''${text#"''${text%%[![:space:]]*}"}"
      printf '%s' "''${text%"''${text##*[![:space:]]}"}"
    }
    unset FORGE_GITHUB_APP_ID FORGE_GITHUB_APP_PRIVATE_KEY_FILE
    if [ -e ${idFile} ]; then
      while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
          *=*)
            if [ "$(trim "''${line%%=*}")" = FORGE_GITHUB_APP_ID ]; then
              FORGE_GITHUB_APP_ID="$(trim "''${line#*=}")"
              case "$FORGE_GITHUB_APP_ID" in
                \"*\" | \'*\') FORGE_GITHUB_APP_ID="''${FORGE_GITHUB_APP_ID:1:-1}" ;;
              esac
            fi
            ;;
        esac
      done < ${idFile}
    fi
    if [ -n "''${FORGE_GITHUB_APP_ID-}" ]; then
      export FORGE_GITHUB_APP_ID
    fi
    export FORGE_GITHUB_APP_PRIVATE_KEY_FILE=${keyFile}
    export FORGE_RUNTIME_CONFIG=${lib.escapeShellArg configFile}
    exec ${lib.getExe' forge-runner "forge-frontier"} list
  '';
  meta.description = "The box's forge-frontier command: lists the frontier live against the generated runtime config, reading FORGE_GITHUB_APP_ID from the App id file as data and pointing the runtime at the App private key file.";
}
