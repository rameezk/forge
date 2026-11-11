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
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -D -m 0555 forge-broker $out/bin/forge-broker
    install -D -m 0555 forge-shell $out/bin/forge-shell
    runHook postInstall
  '';

  nativeInstallCheckInputs = [ binutils ];
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    for binary in forge-broker forge-shell; do
      if readelf -lW $out/bin/$binary | grep -q 'INTERP\|DYNAMIC'; then
        echo "$binary is not statically linked" >&2
        exit 1
      fi
    done
    runHook postInstallCheck
  '';

  meta = {
    description = "The tools sandbox's command broker and the static client that hands it a harness's commands";
    mainProgram = "forge-shell";
    platforms = lib.platforms.linux;
  };
}
