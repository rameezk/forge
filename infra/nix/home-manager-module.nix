{ forgePackages }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.forge-mcp;
  forge-mcp = forgePackages.${pkgs.stdenv.hostPlatform.system}.forge-mcp;
  configured = pkgs.symlinkJoin {
    name = "forge-mcp-configured";
    paths = [ forge-mcp ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      wrapProgram "$out/bin/forge-mcp" \
        --set FORGE_BOX_ADDRESS ${lib.escapeShellArg cfg.boxAddress} \
        --prefix PATH : ${lib.makeBinPath [ pkgs.gh ]}
    '';
    meta.mainProgram = "forge-mcp";
  };
in
{
  options.programs.forge-mcp = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Install forge-mcp, forge's local MCP server, on the home profile. It does not write any MCP client's configuration: register the profile's forge-mcp in each client once.";
    };
    boxAddress = lib.mkOption {
      type = lib.types.str;
      example = "forge-box.tailnet.ts.net";
      description = "The box's full tailnet name, `<hostname>.<tailnet>.ts.net`, the same host as the dashboard, where forge-mcp reads forge's read-only JSON interface. forge-mcp reaches it over HTTPS, and a short name such as `forge-box` is refused because the box's certificate covers only the full name. An address with an `http://` or `https://` scheme is used as given.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ configured ];
  };
}
