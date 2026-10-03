#!/usr/bin/env python3
"""Run live PostgreSQL migration smoke tests when psql + DB URL are available."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


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

    migration = ROOT / "db/migrations/0001_core_messaging.sql"
    session_migration = ROOT / "db/migrations/0002_session_access_credential.sql"
    runtime_migration = ROOT / "db/migrations/0003_runtime_alignment.sql"
    command_migration = ROOT / "db/migrations/0004_command_fingerprint.sql"
    smoke = ROOT / "db/tests/0001_core_messaging_smoke.sql"
    runtime_smoke = ROOT / "db/tests/0003_runtime_alignment_smoke.sql"
    down = ROOT / "db/migrations/0001_core_messaging.down.sql"

    for sql in (
        down,
        migration,
        session_migration,
        runtime_migration,
        command_migration,
        smoke,
        runtime_smoke,
    ):
        print("+ psql", sql.relative_to(ROOT), flush=True)
        subprocess.run(
            [psql, url, "-v", "ON_ERROR_STOP=1", "-f", str(sql)],
            cwd=ROOT,
            check=True,
        )

    print("POSTGRES_INTEGRATION=PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
