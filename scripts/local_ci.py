#!/usr/bin/env python3
"""Local/CI verification entrypoint for HERMENEIA."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

FOUNDATION_TIMEOUT_SECONDS = 180
NODE_TIMEOUT_SECONDS = 300
RUNTIME_TIMEOUT_SECONDS = 120


def run(*args: str, timeout: int) -> None:
    print("+", " ".join(args), flush=True)
    try:
        subprocess.run(
            args,
            cwd=ROOT,
            check=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        print(
            "COMMAND_TIMEOUT "
            f"seconds={timeout} "
            f"command={' '.join(args)}",
            file=sys.stderr,
            flush=True,
        )
        raise RuntimeError(
            f"Command exceeded {timeout}s: {' '.join(args)}"
        ) from exc


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


def run_foundation() -> None:
    validate_json_files()
    run(
        sys.executable,
        "scripts/validate_sql_contract.py",
        timeout=FOUNDATION_TIMEOUT_SECONDS,
    )
    run(
        sys.executable,
        "scripts/postgres_integration.py",
        timeout=FOUNDATION_TIMEOUT_SECONDS,
    )
    run(
        sys.executable,
        "-m",
        "compileall",
        "-q",
        "research",
        "tests",
        timeout=FOUNDATION_TIMEOUT_SECONDS,
    )
    run(
        sys.executable,
        "research/eval/harness.py",
        "validate",
        timeout=FOUNDATION_TIMEOUT_SECONDS,
    )
    run(
        sys.executable,
        "-m",
        "unittest",
        "discover",
        "-s",
        "tests/eval",
        "-p",
        "test_*.py",
        timeout=FOUNDATION_TIMEOUT_SECONDS,
    )
    run(
        sys.executable,
        "research/eval/harness.py",
        "prepare",
        "--strategy",
        "T0",
        "--split",
        "validation",
        timeout=FOUNDATION_TIMEOUT_SECONDS,
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
        timeout=FOUNDATION_TIMEOUT_SECONDS,
    )
    run(
        sys.executable,
        "research/eval/harness.py",
        "prepare",
        "--strategy",
        "T2_ORACLE",
        "--split",
        "validation",
        timeout=FOUNDATION_TIMEOUT_SECONDS,
    )
    print("LOCAL_CI_STAGE_FOUNDATION=PASS")


def run_node() -> None:
    package_json = ROOT / "package.json"
    if not package_json.exists():
        print("LOCAL_CI_STAGE_NODE=SKIP package_json=no")
        return

    run(
        "npm",
        "run",
        "verify",
        timeout=NODE_TIMEOUT_SECONDS,
    )
    print("LOCAL_CI_STAGE_NODE=PASS")


def run_runtime() -> None:
    package_json = ROOT / "package.json"
    if not package_json.exists():
        print("POSTGRES_RUNTIME_SMOKE=SKIP package_json=no")
        print("LOCAL_CI_STAGE_RUNTIME=SKIP")
        return

    if not postgres_runtime_smoke_ready():
        print(
            "POSTGRES_RUNTIME_SMOKE=SKIP "
            "database_url="
            f"{'yes' if (os.getenv('HERMENEIA_TEST_DATABASE_URL') or os.getenv('DATABASE_URL')) else 'no'} "
            "hmac_key="
            f"{'yes' if os.getenv('SOURCE_FINGERPRINT_HMAC_KEY_BASE64') else 'no'}"
        )
        print("LOCAL_CI_STAGE_RUNTIME=SKIP")
        return

    run(
        "npm",
        "run",
        "smoke:postgres-runtime",
        timeout=RUNTIME_TIMEOUT_SECONDS,
    )
    run(
        "npm",
        "run",
        "smoke:persistent-process-signal",
        timeout=RUNTIME_TIMEOUT_SECONDS,
    )
    print("LOCAL_CI_STAGE_RUNTIME=PASS")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run HERMENEIA verification stages.",
    )
    parser.add_argument(
        "--stage",
        choices=("all", "foundation", "node", "runtime"),
        default="all",
        help="Verification stage to run. Default: all.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if args.stage in {"all", "foundation"}:
        run_foundation()
    if args.stage in {"all", "node"}:
        run_node()
    if args.stage in {"all", "runtime"}:
        run_runtime()

    if args.stage == "all":
        print("LOCAL_CI=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
