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
    ]

    rollbacks = [
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
    ]

    # This runner targets a dedicated disposable integration database.
    # Guarded rollback failures are intentional: they expose leftover state
    # rather than silently destroying data that may not belong to the test.
    for sql in rollbacks:
        run_sql(psql, url, sql)

    for sql in migrations:
        run_sql(psql, url, sql)

    for sql in smoke_tests:
        run_sql(psql, url, sql)

    print("POSTGRES_INTEGRATION=PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
