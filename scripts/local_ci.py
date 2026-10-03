#!/usr/bin/env python3
"""Local/sandbox CI entrypoint for HERMENEIA.

Designed to run without GitHub Actions and without third-party dependencies
during the pre-implementation phase.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(*args: str) -> None:
    print("+", " ".join(args), flush=True)
    subprocess.run(args, cwd=ROOT, check=True)


def validate_json_files() -> None:
    files = [
        ROOT / "datasets/pilot/v1/case.schema.json",
        ROOT / "packages/protocol/schemas/send-message.schema.json",
        ROOT / "packages/protocol/schemas/server-event.schema.json",
        ROOT / "packages/protocol/schemas/api-error.schema.json",
    ]
    for path in files:
        print("+ json", path.relative_to(ROOT), flush=True)
        with path.open("r", encoding="utf-8") as fh:
            json.load(fh)


def main() -> int:
    validate_json_files()
    run(sys.executable, "-m", "compileall", "-q", "research", "tests")
    run(sys.executable, "research/eval/harness.py", "validate")
    run(sys.executable, "-m", "unittest", "discover", "-s", "tests/eval", "-p", "test_*.py")
    run(sys.executable, "research/eval/harness.py", "prepare", "--strategy", "T0", "--split", "validation")
    run(sys.executable, "research/eval/harness.py", "prepare", "--strategy", "T1", "--window", "3", "--split", "validation")
    run(sys.executable, "research/eval/harness.py", "prepare", "--strategy", "T2_ORACLE", "--split", "validation")

    package_json = ROOT / "package.json"
    if package_json.exists():
        run("npm", "run", "typecheck")
        run("npm", "run", "build")
        run("npm", "test")

    print("LOCAL_CI=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
