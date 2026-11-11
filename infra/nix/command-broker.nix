{
  lib,
  stdenv,
  binutils,
}:
stdenv.mkDerivation {
  pname = "forge-command-broker";
  version = "0.0.0";

  src = lib.fileset.toSource {
    root = ../command-broker;
    fileset = ../command-broker;
  };

  buildPhase = ''
    runHook preBuild
    $CC -Wall -Wextra -Werror -O2 -o forge-broker broker.c
    $CC -Wall -Wextra -Werror -O2 -o forge-shell client.c
    $CC -Wall -Wextra -Werror -O2 -DFORGE_GIT_SHIM -o forge-git client.c
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -D -m 0555 forge-broker $out/bin/forge-broker
    install -D -m 0555 forge-shell $out/bin/forge-shell
    install -D -m 0555 forge-shell $out/libexec/forge-bash/bash
    install -D -m 0555 forge-git $out/libexec/forge-git/git
    runHook postInstall
  '';

  nativeInstallCheckInputs = [ binutils ];
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    for binary in bin/forge-broker bin/forge-shell libexec/forge-bash/bash libexec/forge-git/git; do
      if readelf -lW $out/$binary | grep -q 'INTERP\|DYNAMIC'; then
        echo "$binary is not statically linked" >&2
        exit 1
      fi
    done
    runHook postInstallCheck
  '';

  meta = {
    description = "The tools sandbox's command broker, the static client that hands it a harness's commands, the same client installed as bash for Claude Code, and the static git shim that hands it the harness's own git calls";
    mainProgram = "forge-shell";
    platforms = lib.platforms.linux;
  };
}
