#!/usr/bin/env python3
"""Run live PostgreSQL migration smoke tests when psql + DB URL are available."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


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

    migrations = [
        ROOT / "db/migrations/0001_core_messaging.sql",
        ROOT / "db/migrations/0002_session_access_credential.sql",
        ROOT / "db/migrations/0003_runtime_alignment.sql",
        ROOT / "db/migrations/0004_command_fingerprint.sql",
        ROOT / "db/migrations/0005_tenant_device_sync_state.sql",
        ROOT / "db/migrations/0006_outbox_superseded.sql",
        ROOT / "db/migrations/0007_outbox_lease_shape.sql",
        ROOT / "db/migrations/0008_translation_execution.sql",
        ROOT / "db/migrations/0009_translation_source_required_event.sql",
        ROOT / "db/migrations/0010_device_trust_lifecycle.sql",
        ROOT / "db/migrations/0011_tenant_local_inbox_sequence.sql",
        ROOT / "db/migrations/0012_context_snapshots.sql",
        ROOT / "db/migrations/0013_context_state.sql",
        ROOT / "db/migrations/0014_context_snapshot_policy_fence.sql",
        ROOT / "db/migrations/0015_explicit_style_preference.sql",
    ]

    rollbacks = [
        ROOT / "db/migrations/0015_explicit_style_preference.down.sql",
        ROOT / "db/migrations/0014_context_snapshot_policy_fence.down.sql",
        ROOT / "db/migrations/0013_context_state.down.sql",
        ROOT / "db/migrations/0012_context_snapshots.down.sql",
        ROOT / "db/migrations/0011_tenant_local_inbox_sequence.down.sql",
        ROOT / "db/migrations/0010_device_trust_lifecycle.down.sql",
        ROOT / "db/migrations/0009_translation_source_required_event.down.sql",
        ROOT / "db/migrations/0008_translation_execution.down.sql",
        ROOT / "db/migrations/0007_outbox_lease_shape.down.sql",
        ROOT / "db/migrations/0006_outbox_superseded.down.sql",
        ROOT / "db/migrations/0005_tenant_device_sync_state.down.sql",
        ROOT / "db/migrations/0004_command_fingerprint.down.sql",
        ROOT / "db/migrations/0003_runtime_alignment.down.sql",
        ROOT / "db/migrations/0002_session_access_credential.down.sql",
        ROOT / "db/migrations/0001_core_messaging.down.sql",
    ]

    smoke_tests = [
        ROOT / "db/tests/0001_core_messaging_smoke.sql",
        ROOT / "db/tests/0003_runtime_alignment_smoke.sql",
        ROOT / "db/tests/0008_translation_schema_smoke.sql",
        ROOT / "db/tests/0010_device_trust_smoke.sql",
        ROOT / "db/tests/0011_tenant_local_inbox_sequence_smoke.sql",
        ROOT / "db/tests/0012_context_snapshots_smoke.sql",
        ROOT / "db/tests/0013_context_state_smoke.sql",
        ROOT / "db/tests/0014_context_snapshot_policy_fence_smoke.sql",
        ROOT / "db/tests/0015_explicit_style_preference_smoke.sql",
    ]

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
