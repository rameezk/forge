{
  writeShellApplication,
  coreutils,
  curl,
  git,
  jq,
  nixos-rebuild-ng,
  openssl,
}:
writeShellApplication {
  name = "forge-pull-deploy";
  runtimeInputs = [
    coreutils
    curl
    git
    jq
    nixos-rebuild-ng
    openssl
  ];
  text = builtins.readFile ./pull-deploy-command.sh;
  meta.description = "Switches the box to its operator repository's main whenever the commit at its head differs from the one the box runs.";
}
