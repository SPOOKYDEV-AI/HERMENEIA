#!/usr/bin/env python3
"""Run live PostgreSQL migration smoke tests when psql + DB URL are available."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

MIGRATIONS_DIR = ROOT / "db/migrations"
SMOKE_TESTS_DIR = ROOT / "db/tests"

FORWARD_MIGRATION_RE = re.compile(
    r"^(?P<ordinal>\d{4})_(?P<name>[a-z0-9_]+)\.sql$"
)
DOWN_MIGRATION_RE = re.compile(
    r"^(?P<ordinal>\d{4})_(?P<name>[a-z0-9_]+)\.down\.sql$"
)
SMOKE_TEST_RE = re.compile(
    r"^\d{4}_[a-z0-9_]+_smoke\.sql$"
)


def discover_migration_catalog() -> tuple[list[Path], list[Path]]:
    forwards: list[tuple[int, str, Path]] = []
    downs: dict[tuple[int, str], Path] = {}
    ordinal_owner: dict[int, str] = {}

    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        down_match = DOWN_MIGRATION_RE.fullmatch(path.name)
        if down_match:
            key = (
                int(down_match.group("ordinal")),
                down_match.group("name"),
            )
            if key in downs:
                raise RuntimeError(
                    f"Duplicate rollback migration for {path.name}"
                )
            downs[key] = path
            continue

        forward_match = FORWARD_MIGRATION_RE.fullmatch(path.name)
        if not forward_match:
            raise RuntimeError(
                f"Unexpected migration filename: {path.name}"
            )

        ordinal = int(forward_match.group("ordinal"))
        name = forward_match.group("name")
        previous = ordinal_owner.get(ordinal)
        if previous is not None:
            raise RuntimeError(
                "Duplicate migration ordinal "
                f"{ordinal:04d}: {previous} and {path.name}"
            )

        ordinal_owner[ordinal] = path.name
        forwards.append((ordinal, name, path))

    if not forwards:
        raise RuntimeError("No PostgreSQL migrations discovered")

    forwards.sort(key=lambda item: item[0])
    ordinals = [item[0] for item in forwards]
    expected = list(range(ordinals[0], ordinals[-1] + 1))
    if ordinals != expected:
        missing = sorted(set(expected) - set(ordinals))
        raise RuntimeError(
            "Migration ordinals must be contiguous; missing="
            + ",".join(f"{value:04d}" for value in missing)
        )

    rollback_paths: list[Path] = []
    for ordinal, name, path in forwards:
        key = (ordinal, name)
        rollback = downs.pop(key, None)
        if rollback is None:
            raise RuntimeError(
                f"Forward migration has no matching rollback: {path.name}"
            )
        rollback_paths.append(rollback)

    if downs:
        orphaned = ", ".join(
            path.name for path in sorted(downs.values())
        )
        raise RuntimeError(
            f"Rollback migration has no matching forward migration: {orphaned}"
        )

    migrations = [item[2] for item in forwards]
    rollbacks = list(reversed(rollback_paths))
    print(
        "POSTGRES_MIGRATION_CATALOG=PASS "
        f"count={len(migrations)} "
        f"latest={migrations[-1].name}",
        flush=True,
    )
    return migrations, rollbacks


def discover_smoke_tests() -> list[Path]:
    tests = sorted(SMOKE_TESTS_DIR.glob("*.sql"))
    if not tests:
        raise RuntimeError("No PostgreSQL smoke tests discovered")

    unexpected = [
        path.name
        for path in tests
        if not SMOKE_TEST_RE.fullmatch(path.name)
    ]
    if unexpected:
        raise RuntimeError(
            "Unexpected PostgreSQL smoke-test filename(s): "
            + ", ".join(unexpected)
        )

    return tests



def run_sql(psql: str, url: str, sql: Path) -> None:
    print("+ psql", sql.relative_to(ROOT), flush=True)
    subprocess.run(
        [psql, url, "-v", "ON_ERROR_STOP=1", "-f", str(sql)],
        cwd=ROOT,
        check=True,
    )


def schema_exists(psql: str, url: str) -> bool:
    result = subprocess.run(
        [
            psql,
            url,
            "-X",
            "-q",
            "-t",
            "-A",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            "SELECT CASE WHEN to_regclass('public.message_metadata') IS NULL "
            "THEN '0' ELSE '1' END;",
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    value = result.stdout.strip()
    if value not in {"0", "1"}:
        raise RuntimeError(
            f"Unexpected PostgreSQL schema probe result: {value!r}"
        )
    return value == "1"


def main() -> int:
    url = os.getenv("HERMENEIA_TEST_DATABASE_URL")
    psql = shutil.which("psql")

    if not url or not psql:
        print(
            "POSTGRES_INTEGRATION=SKIP "
            f"psql={'yes' if psql else 'no'} "
            f"url={'yes' if url else 'no'}"
        )
        return 0

    migrations, rollbacks = discover_migration_catalog()
    smoke_tests = discover_smoke_tests()

    # This runner targets a dedicated disposable integration database.
    # A virgin database must not fail because later down migrations reference
    # tables that have never existed. Clean up only when the base schema is
    # already present.
    if schema_exists(psql, url):
        print("POSTGRES_INTEGRATION=CLEANUP existing_schema=yes")
        for sql in rollbacks:
            run_sql(psql, url, sql)
    else:
        print("POSTGRES_INTEGRATION=CLEANUP existing_schema=no")

    # First forward migration + smoke pass.
    for sql in migrations:
        run_sql(psql, url, sql)

    for sql in smoke_tests:
        run_sql(psql, url, sql)

    # Prove the reverse chain against the schema we just created. Smoke tests
    # are transaction-scoped/rolled back, so guarded downs should remain safe.
    for sql in rollbacks:
        run_sql(psql, url, sql)

    if schema_exists(psql, url):
        raise RuntimeError(
            "Rollback chain completed but core schema is still present"
        )

    # Re-apply once more so the disposable DB is left in the current schema and
    # prove that a complete down/up cycle remains reproducible.
    for sql in migrations:
        run_sql(psql, url, sql)

    for sql in smoke_tests:
        run_sql(psql, url, sql)

    print("POSTGRES_INTEGRATION=PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
