"""Updates the pinned yt-dlp version in engines.json and the CI workflow.

Usage: python bump_ytdlp.py <version> <sha256-of-yt-dlp.exe>
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENGINES = ROOT / "companion" / "installer" / "engines.json"
CI = ROOT / ".github" / "workflows" / "ci.yml"
RELEASE_URL = "https://github.com/yt-dlp/yt-dlp/releases/download/{version}/yt-dlp.exe"


def validate(version: str, sha256: str) -> None:
    if not re.fullmatch(r"\d{4}\.\d{2}\.\d{2}(\.\d+)?", version):
        raise ValueError(f"unexpected yt-dlp version: {version!r}")
    if not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise ValueError(f"not a SHA-256: {sha256!r}")


def bump_engines(engines_json: str, version: str, sha256: str) -> str:
    engines = json.loads(engines_json)
    engines["ytDlp"] = {"version": version, "url": RELEASE_URL.format(version=version), "sha256": sha256}
    return json.dumps(engines, indent=2, ensure_ascii=False) + "\n"


def bump_ci(ci_yaml: str, version: str) -> str:
    updated, count = re.subn(r"(YT_DLP_VERSION: ')[^']*(')", rf"\g<1>{version}\g<2>", ci_yaml)
    if count != 1:
        raise ValueError("YT_DLP_VERSION not found exactly once in ci.yml")
    return updated


def current_version(engines_json: str) -> str:
    return json.loads(engines_json)["ytDlp"]["version"]


def main(version: str, sha256: str) -> None:
    validate(version, sha256)
    ENGINES.write_text(bump_engines(ENGINES.read_text(encoding="utf-8"), version, sha256), encoding="utf-8")
    CI.write_text(bump_ci(CI.read_text(encoding="utf-8"), version), encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--current":
        print(current_version(ENGINES.read_text(encoding="utf-8")))
    elif len(sys.argv) == 3:
        main(sys.argv[1], sys.argv[2])
    else:
        sys.exit(__doc__)
