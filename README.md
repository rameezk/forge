# Forge

> A declarative software factory.

Forge is a reusable library for standing up a declarative VPS. You do not deploy
forge directly; you scaffold your own operator repository from its flake template
and drive your box from there.

## Get started

Scaffold an operator repository:

```bash
nix flake init -t github:rameezk/forge
```
