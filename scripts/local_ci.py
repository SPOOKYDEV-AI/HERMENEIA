#!/usr/bin/env python3
"""Local/CI verification entrypoint for HERMENEIA."""
from __future__ import annotations

import json
import os
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


def postgres_runtime_smoke_ready() -> bool:
    database_url = (
        os.getenv("HERMENEIA_TEST_DATABASE_URL")
        or os.getenv("DATABASE_URL")
    )
    hmac_key = os.getenv("SOURCE_FINGERPRINT_HMAC_KEY_BASE64")
    return bool(database_url and hmac_key)


def main() -> int:
    validate_json_files()
    run(sys.executable, "scripts/validate_sql_contract.py")
    run(sys.executable, "scripts/postgres_integration.py")
    run(sys.executable, "-m", "compileall", "-q", "research", "tests")
    run(sys.executable, "research/eval/harness.py", "validate")
    run(
        sys.executable,
        "-m",
        "unittest",
        "discover",
        "-s",
        "tests/eval",
        "-p",
        "test_*.py",
    )
    run(
        sys.executable,
        "research/eval/harness.py",
        "prepare",
        "--strategy",
        "T0",
        "--split",
        "validation",
    )
    run(
        sys.executable,
        "research/eval/harness.py",
        "prepare",
        "--strategy",
        "T1",
        "--window",
        "3",
        "--split",
        "validation",
    )
    run(
        sys.executable,
        "research/eval/harness.py",
        "prepare",
        "--strategy",
        "T2_ORACLE",
        "--split",
        "validation",
    )

    package_json = ROOT / "package.json"
    if package_json.exists():
        run("npm", "run", "verify")
        if postgres_runtime_smoke_ready():
            run("npm", "run", "smoke:postgres-runtime")
        else:
            print(
                "POSTGRES_RUNTIME_SMOKE=SKIP "
                "database_url="
                f"{'yes' if (os.getenv('HERMENEIA_TEST_DATABASE_URL') or os.getenv('DATABASE_URL')) else 'no'} "
                "hmac_key="
                f"{'yes' if os.getenv('SOURCE_FINGERPRINT_HMAC_KEY_BASE64') else 'no'}"
            )

    print("LOCAL_CI=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
