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
      echo "token=''${GITHUB_TOKEN-unset}"
      echo "node_options=''${NODE_OPTIONS-unset}"
    '';
  };

  command = callPackage ./frontier-command.nix {
    inherit forge-runner configFile;
    user = "forge-runtime";
    githubTokenFile = "tokens/github.env";
  };

  forgeFrontier = lib.getExe command;
in
runCommand "frontier-command"
  {
    meta.description = "Runs the box's forge-frontier command over a stub runtime, checking it only lists, points at the runtime config, and reads GITHUB_TOKEN from the token file as data, never as shell.";
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
    expect 'token=unset' no-dir.out

    mkdir tokens
    GITHUB_TOKEN=from_the_shell ${forgeFrontier} list > no-file.out
    expect 'token=unset' no-file.out

    printf 'GITHUB_TOKEN=%s\n' github_pat_test > tokens/github.env
    ${forgeFrontier} list > present.out
    expect 'token=github_pat_test' present.out

    {
      echo 'touch sourced'
      echo 'NODE_OPTIONS=--require=./injected.js'
      echo 'GITHUB_TOKEN=github_pat_test$(touch expanded)'
    } > tokens/github.env
    ${forgeFrontier} list > data.out
    if [ -e sourced ] || [ -e expanded ]; then
      echo "the token file was run as shell"; exit 1
    fi
    expect 'token=github_pat_test$(touch expanded)' data.out
    expect 'node_options=unset' data.out

    printf 'GITHUB_TOKEN="github_pat_double"\n' > tokens/github.env
    ${forgeFrontier} list > double.out
    expect 'token=github_pat_double' double.out
    printf "GITHUB_TOKEN='github_pat_single'\\n" > tokens/github.env
    ${forgeFrontier} list > single.out
    expect 'token=github_pat_single' single.out
    printf '  GITHUB_TOKEN=github_pat_crlf\r\n' > tokens/github.env
    ${forgeFrontier} list > crlf.out
    expect 'token=github_pat_crlf' crlf.out
    printf 'GITHUB_TOKEN = "github_pat_spaced" \t\n' > tokens/github.env
    ${forgeFrontier} list > spaced.out
    expect 'token=github_pat_spaced' spaced.out

    rm tokens/github.env
    ln -s /dev/null tokens/github.env
    refused list
    expect 'forge-frontier: tokens/github.env is not a regular file' refused.out
    rm tokens/github.env
    printf 'GITHUB_TOKEN=%s\n' github_pat_test > tokens/github.env

    refused sync
    refused
    refused list extra

    chmod 000 tokens/github.env
    refused list
    expect 'forge-frontier: cannot read tokens/github.env; run it as the forge-runtime user: sudo -u forge-runtime forge-frontier list' refused.out
    chmod 600 tokens/github.env
    chmod 000 tokens
    refused list
    expect 'forge-frontier: cannot read tokens/github.env; run it as the forge-runtime user: sudo -u forge-runtime forge-frontier list' refused.out
    chmod 700 tokens

    echo "the box's forge-frontier command only lists, and reads GITHUB_TOKEN from the token file as data" > $out
  ''
