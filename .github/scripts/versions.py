"""Single version for the extension and the companion.

  python versions.py check            # fails if package.json, Cargo.toml and Cargo.lock disagree
  python versions.py check v1.2.3     # ...or if they differ from a release tag
  python versions.py set 1.2.3        # writes the version everywhere
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PACKAGE_JSON = ROOT / "extension" / "package.json"
CARGO_TOML = ROOT / "companion" / "Cargo.toml"
CARGO_LOCK = ROOT / "companion" / "Cargo.lock"
CRATE = "mediadown-host"
SEMVER = re.compile(r"\d+\.\d+\.\d+")


def read_package(text: str) -> str:
    return json.loads(text)["version"]


def write_package(text: str, version: str) -> str:
    updated, count = re.subn(r'("version"\s*:\s*")[^"]*(")', rf"\g<1>{version}\g<2>", text, count=1)
    if count != 1:
        raise ValueError("version not found in package.json")
    return updated


def read_cargo_toml(text: str) -> str:
    match = re.search(r'(?m)^\[package\][^\[]*?^version\s*=\s*"([^"]+)"', text)
    if not match:
        raise ValueError("version not found in Cargo.toml [package]")
    return match.group(1)


def write_cargo_toml(text: str, version: str) -> str:
    updated, count = re.subn(r'(?m)(^\[package\][^\[]*?^version\s*=\s*")[^"]+(")', rf"\g<1>{version}\g<2>", text, count=1)
    if count != 1:
        raise ValueError("version not found in Cargo.toml [package]")
    return updated


def read_cargo_lock(text: str) -> str:
    match = re.search(rf'name = "{CRATE}"\nversion = "([^"]+)"', text)
    if not match:
        raise ValueError(f"{CRATE} not found in Cargo.lock")
    return match.group(1)


def write_cargo_lock(text: str, version: str) -> str:
    updated, count = re.subn(rf'(name = "{CRATE}"\nversion = ")[^"]+(")', rf"\g<1>{version}\g<2>", text, count=1)
    if count != 1:
        raise ValueError(f"{CRATE} not found in Cargo.lock")
    return updated


def current_versions() -> dict:
    return {
        "extension/package.json": read_package(PACKAGE_JSON.read_text(encoding="utf-8")),
        "companion/Cargo.toml": read_cargo_toml(CARGO_TOML.read_text(encoding="utf-8")),
        "companion/Cargo.lock": read_cargo_lock(CARGO_LOCK.read_text(encoding="utf-8")),
    }


def check(tag: str | None = None) -> str:
    versions = current_versions()
    distinct = set(versions.values())
    if len(distinct) != 1:
        raise SystemExit(f"versions disagree: {versions}")
    version = distinct.pop()
    if tag is not None and tag.removeprefix("v") != version:
        raise SystemExit(f"tag {tag} does not match version {version}")
    return version


def set_version(version: str) -> None:
    if not SEMVER.fullmatch(version):
        raise SystemExit(f"not a MAJOR.MINOR.PATCH version: {version}")
    for path, writer in ((PACKAGE_JSON, write_package), (CARGO_TOML, write_cargo_toml), (CARGO_LOCK, write_cargo_lock)):
        path.write_text(writer(path.read_text(encoding="utf-8"), version), encoding="utf-8")


if __name__ == "__main__":
    match sys.argv[1:]:
        case ["check"]:
            print(check())
        case ["check", tag]:
            print(check(tag))
        case ["set", version]:
            set_version(version)
            print(check())
        case _:
            sys.exit(__doc__)
