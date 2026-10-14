{
  lib,
  callPackage,
  runCommand,
  writeShellApplication,
}:
let
  configFile = "/forge-runtime.json";

  forge-runner = writeShellApplication {
    name = "forge-frontier";
    text = ''
      echo "argv=$*"
      echo "config=$FORGE_RUNTIME_CONFIG"
      echo "state=''${FORGE_STATE_DIR-unset}"
      echo "app=''${FORGE_GITHUB_APP_ID-unset}"
      echo "key=''${FORGE_GITHUB_APP_PRIVATE_KEY_FILE-unset}"
      echo "node_options=''${NODE_OPTIONS-unset}"
    '';
  };

  command = callPackage ./frontier-command.nix {
    inherit forge-runner configFile;
    user = "forge-runtime";
    githubAppIdFile = "secrets/app.env";
    githubAppPrivateKeyFile = "secrets/app-key.pem";
  };

  forgeFrontier = lib.getExe command;
in
runCommand "frontier-command"
  {
    meta.description = "Runs the box's forge-frontier command over a stub runtime, checking it only lists, points at the runtime config, and reads FORGE_GITHUB_APP_ID from the App id file as data, never as shell, and points the runtime at the private key file.";
  }
  ''
    cd "$(mktemp -d)"

    expect() {
      grep -qxF "$1" "$2" || { echo "expected '$1' in $2:"; cat "$2"; exit 1; }
    }

    refused() {
      if ${forgeFrontier} "$@" > refused.out 2>&1; then
        echo "forge-frontier $* ran:"; cat refused.out; exit 1
      fi
      if grep -q '^argv=' refused.out; then
        echo "forge-frontier $* reached the runtime:"; cat refused.out; exit 1
      fi
    }

    ${forgeFrontier} list > no-dir.out
    expect 'argv=list' no-dir.out
    expect 'config=${configFile}' no-dir.out
    expect 'state=unset' no-dir.out
    expect 'app=unset' no-dir.out
    expect 'key=secrets/app-key.pem' no-dir.out

    mkdir secrets
    FORGE_GITHUB_APP_ID=from_the_shell FORGE_GITHUB_APP_PRIVATE_KEY_FILE=/from/the/shell ${forgeFrontier} list > no-file.out
    expect 'app=unset' no-file.out
    expect 'key=secrets/app-key.pem' no-file.out

    printf 'FORGE_GITHUB_APP_ID=%s\n' 5313638 > secrets/app.env
    ${forgeFrontier} list > present.out
    expect 'app=5313638' present.out

    {
      echo 'touch sourced'
      echo 'NODE_OPTIONS=--require=./injected.js'
      echo 'FORGE_GITHUB_APP_ID=5313638$(touch expanded)'
    } > secrets/app.env
    ${forgeFrontier} list > data.out
    if [ -e sourced ] || [ -e expanded ]; then
      echo "the App id file was run as shell"; exit 1
    fi
    expect 'app=5313638$(touch expanded)' data.out
    expect 'node_options=unset' data.out

    printf 'FORGE_GITHUB_APP_ID="5313638"\n' > secrets/app.env
    ${forgeFrontier} list > double.out
    expect 'app=5313638' double.out
    printf "FORGE_GITHUB_APP_ID='5313638'\\n" > secrets/app.env
    ${forgeFrontier} list > single.out
    expect 'app=5313638' single.out
    printf '  FORGE_GITHUB_APP_ID=5313638\r\n' > secrets/app.env
    ${forgeFrontier} list > crlf.out
    expect 'app=5313638' crlf.out
    printf 'FORGE_GITHUB_APP_ID = "5313638" \t\n' > secrets/app.env
    ${forgeFrontier} list > spaced.out
    expect 'app=5313638' spaced.out

    rm secrets/app.env
    ln -s /dev/null secrets/app.env
    refused list
    expect 'forge-frontier: secrets/app.env is not a regular file' refused.out
    rm secrets/app.env
    printf 'FORGE_GITHUB_APP_ID=%s\n' 5313638 > secrets/app.env

    ln -s /dev/null secrets/app-key.pem
    refused list
    expect 'forge-frontier: secrets/app-key.pem is not a regular file' refused.out
    rm secrets/app-key.pem
    printf 'not a key\n' > secrets/app-key.pem

    refused sync
    refused
    refused list extra

    chmod 000 secrets/app.env
    refused list
    expect 'forge-frontier: cannot read secrets/app.env; run it as the forge-runtime user: sudo -u forge-runtime forge-frontier list' refused.out
    chmod 600 secrets/app.env
    chmod 000 secrets/app-key.pem
    refused list
    expect 'forge-frontier: cannot read secrets/app-key.pem; run it as the forge-runtime user: sudo -u forge-runtime forge-frontier list' refused.out
    chmod 600 secrets/app-key.pem
    chmod 000 secrets
    refused list
    expect 'forge-frontier: cannot read secrets/app.env; run it as the forge-runtime user: sudo -u forge-runtime forge-frontier list' refused.out
    chmod 700 secrets

    echo "the box's forge-frontier command only lists, reads FORGE_GITHUB_APP_ID from the App id file as data, and points the runtime at the private key file" > $out
  ''
