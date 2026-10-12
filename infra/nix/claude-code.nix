{ lib, claude-code }:
claude-code.override { manifest = lib.importJSON ./claude-code-manifest.json; }
