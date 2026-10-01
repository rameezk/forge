{
  lib,
  runCommand,
  writeText,
  sops-install-secrets,
  cases,
}:
let
  manifestOf =
    name: host:
    let
      text = host.config.system.build.sops-nix-manifest.text;
      sourceContext = lib.filterAttrs (path: _: !lib.hasSuffix ".drv" path) (builtins.getContext text);
    in
    writeText "${name}-manifest.json" (
      builtins.appendContext (builtins.unsafeDiscardStringContext text) sourceContext
    );

  check =
    {
      name,
      host,
      refusedKey ? null,
    }:
    let
      manifest = manifestOf name host;
      validate = "${lib.getExe' sops-install-secrets "sops-install-secrets"} -check-mode=sopsfile ${manifest} > ${name}.out 2>&1";
    in
    if refusedKey == null then
      ''
        if ! ${validate}; then
          echo "${name}: the runtime secrets were refused:"; cat ${name}.out; exit 1
        fi
      ''
    else
      ''
        if ${validate}; then
          echo "${name}: the runtime secrets were accepted without ${refusedKey}"; exit 1
        fi
        if ! grep -qF "secret ${refusedKey} in" ${name}.out; then
          echo "${name}: the runtime secrets were refused without naming ${refusedKey}:"; cat ${name}.out; exit 1
        fi
      '';
in
runCommand "runtime-secrets"
  {
    meta.description = "Validates each host's sops manifest against its runtime secrets file with sops-nix's own build-time check, so a host missing a key it needs is refused, naming the key.";
  }
  ''
    cd "$(mktemp -d)"
    ${lib.concatMapStrings check cases}
    echo "a host is refused when its runtime secrets file lacks a key it needs, naming the key" > $out
  ''
