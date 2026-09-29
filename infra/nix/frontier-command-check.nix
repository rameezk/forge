{
  lib,
  callPackage,
  runCommand,
  writeText,
  forge-runner,
}:
let
  configFile = writeText "forge-runtime.json" (
    builtins.toJSON {
      harnesses = { };
      workers = { };
      repositories = {
        forge.github = "rameezk/forge";
        quiet.github = "rameezk/quiet";
      };
    }
  );

  command = callPackage ./frontier-command.nix {
    inherit forge-runner configFile;
    user = "forge-runtime";
    stateDir = "state";
    githubTokenFile = "tokens/github.env";
  };

  forgeFrontier = lib.getExe command;
in
runCommand "frontier-command"
  {
    meta.description = "Runs the box's forge-frontier command against the generated runtime config with the GitHub token file missing, unreadable, and present, checking it loads the token only from that file.";
  }
  ''
    cd "$(mktemp -d)"
    mkdir tokens

    if ${forgeFrontier} list > missing.out 2>&1; then
      echo "list succeeded without a token file:"; cat missing.out; exit 1
    fi
    grep -qxF 'forge (rameezk/forge)' missing.out
    grep -qxF 'quiet (rameezk/quiet)' missing.out
    [ "$(grep -cxF '  error: GitHub token missing' missing.out)" = 2 ] || {
      echo "list did not report the missing token on every repository:"; cat missing.out; exit 1
    }

    printf 'GITHUB_TOKEN=%s\n' github_pat_test > tokens/github.env
    unreadable() {
      if ${forgeFrontier} list > unreadable.out 2>&1; then
        echo "list succeeded with an unreadable token file:"; cat unreadable.out; exit 1
      fi
      grep -qF 'sudo -u forge-runtime forge-frontier list' unreadable.out || {
        echo "list did not explain the unreadable token file:"; cat unreadable.out; exit 1
      }
    }
    chmod 000 tokens/github.env
    unreadable
    chmod 600 tokens/github.env
    chmod 000 tokens
    unreadable
    chmod 700 tokens

    ${forgeFrontier} list > present.out 2>&1 || true
    grep -qxF 'forge (rameezk/forge)' present.out
    if grep -qF 'GitHub token missing' present.out; then
      echo "list did not load the token file:"; cat present.out; exit 1
    fi

    echo "the box's forge-frontier command reads the runtime config and loads GITHUB_TOKEN from the token file" > $out
  ''
