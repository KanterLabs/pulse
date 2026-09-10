#!/usr/bin/env python3
"""Copy rollback code/config and verify an online SQLite backup before upgrade."""
import pathlib
import shutil
import sqlite3
import sys
import time

backup, config, data, binaries, extension, systemd = map(pathlib.Path, sys.argv[1:])
for source, name in (
    (config / "pulse/config.toml", "config.toml"),
    (config / "pulse/player.json", "player.json"),
    (binaries / "pulse-daemon", "pulse-daemon"),
    (systemd / "pulse-daemon.service", "pulse-daemon.service"),
    (systemd / "pulse-player.service", "pulse-player.service"),
    (systemd / "pulse-daemon.service.d/50-pulse-player.conf", "50-pulse-player.conf"),
):
    if source.is_file():
        shutil.copy2(source, backup / name)
        if source.read_bytes() != (backup / name).read_bytes():
            raise RuntimeError("Backup verification failed")
for source, name in ((extension, "extension"), (data / "pulse/player", "player")):
    if source.is_dir():
        shutil.copytree(source, backup / name, symlinks=True)
database = data / "pulse/pulse.sqlite3"
if database.exists():
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=5) as source:
        with sqlite3.connect(backup / "pulse.sqlite3") as destination:
            deadline = time.monotonic() + 15
            def progress(_status, _remaining, _total):
                if time.monotonic() > deadline:
                    raise TimeoutError("Database backup timed out; upgrade stopped")
            source.backup(destination, pages=256, progress=progress, sleep=0.05)
            if destination.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                raise RuntimeError("Database backup integrity check failed")
(backup / "README.txt").write_text(
    "Verified pre-upgrade snapshot. Config and database are retained by normal upgrades.\n"
    "Do not restore the database as a normal rollback: it would discard newer writes.\n"
    "The retained pulse-daemon and extension can be used for code rollback.\n",
    encoding="utf-8",
)
