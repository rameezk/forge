{
  description = "A Software Factory";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        python = pkgs.python313;
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            python
            pkgs.uv
          ];

          env = {
            UV_PYTHON_DOWNLOADS = "never";
            UV_PYTHON = python.interpreter;
          };

          shellHook = ''
                        cat <<'BANNER'
                         __
                        / _|  ___   _ __  __ _   ___
                       | |_  / _ \ | '__|/ _` | / _ \
                       |  _|| (_) || |  | (_| ||  __/
                       |_|   \___/ |_|   \__, | \___|
                                         |___/
            BANNER
                        echo "python $(python --version)"
                        echo "uv $(uv --version)"
          '';
        };
      }
    );
}
