import tomllib
from importlib.metadata import entry_points
from pathlib import Path

from forge.watch import forge_main


def _pyproject() -> dict:
    path = Path(__file__).resolve().parents[1] / "pyproject.toml"
    return tomllib.loads(path.read_text(encoding="utf-8"))


def given_pyproject_when_inspected_then_forge_build_resolves_to_forge_main():
    scripts = _pyproject()["project"]["scripts"]

    assert scripts["forge-build"] == "forge.watch:forge_main"


def given_the_installed_package_when_loading_the_forge_build_entry_point_then_it_imports_forge_main():
    (script,) = entry_points(group="console_scripts", name="forge-build")

    assert script.load() is forge_main
