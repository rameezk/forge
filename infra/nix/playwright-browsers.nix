{
  lib,
  playwright-driver,
}:
let
  pinned =
    (lib.importJSON ../../runtime/package-lock.json).packages."node_modules/@playwright/test".version;
in
assert lib.assertMsg (pinned == playwright-driver.version)
  "@playwright/test ${pinned} in runtime/package-lock.json must match nixpkgs' playwright-driver ${playwright-driver.version}, so the browsers from nixpkgs are the ones it drives";
playwright-driver.browsers-chromium
