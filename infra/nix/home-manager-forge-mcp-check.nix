{
  lib,
  runCommand,
  home-manager,
  homeModule,
  pkgs,
}:
let
  address = "forge-box.tailnet.ts.net";
  home = home-manager.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [
      homeModule
      {
        home = {
          username = "operator";
          homeDirectory = "/home/operator";
          stateVersion = "26.05";
        };
        programs.forge-mcp.boxAddress = address;
      }
    ];
  };
in
runCommand "home-manager-forge-mcp" { } ''
  profile=${home.config.home.path}
  wrapper="$profile/bin/forge-mcp"
  test -x "$wrapper"
  grep -q "FORGE_BOX_ADDRESS" "$wrapper"
  grep -q ${lib.escapeShellArg address} "$wrapper"
  grep -q "${pkgs.gh}/bin" "$wrapper"
  echo "a home configuration using forge's module with a box address installs forge-mcp on the profile's stable path, configured with that address and with gh on its PATH" > $out
''
