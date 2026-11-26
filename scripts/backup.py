"""Create a consistent, non-overwriting SQLite backup."""
import pathlib
import sqlite3
import sys

if len(sys.argv) != 3:
    raise SystemExit("Usage: python scripts/backup.py SOURCE.db DESTINATION.db")
source, destination = map(lambda p: pathlib.Path(p).resolve(), sys.argv[1:])
if not source.is_file():
    raise SystemExit("Source database does not exist")
if source == destination:
    raise SystemExit("Source and destination must differ")
destination.parent.mkdir(parents=True, exist_ok=True)
with destination.open("xb"):
    pass
try:
    with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as src:
        with sqlite3.connect(destination) as dst:
            src.backup(dst)
            if dst.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("Backup integrity check failed")
    print(f"Verified backup: {destination}")
except Exception:
    print(f"Backup failed; do not use incomplete file: {destination}", file=sys.stderr)
    raise
