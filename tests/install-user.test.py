#!/usr/bin/env python3
"""Isolated contract tests for the per-user installer.

These tests exercise the shell script with temporary XDG roots and fake
session commands.  They never write to the repository's installation paths,
start a real daemon, or connect to the contributor's desktop session.
"""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sqlite3
import tempfile
import unittest


REPOSITORY = Path(__file__).resolve().parents[1]
INSTALLER = REPOSITORY / "scripts" / "install-user.sh"


class InstallerFixture:
    """Temporary user directories and deterministic command shims."""

    def __init__(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory(prefix="pulse-install-test-")
        self.root = Path(self.tempdir.name)
        self.home = self.root / "home"
        self.config_home = self.root / "config"
        self.data_home = self.root / "data"
        self.cache_home = self.root / "cache"
        self.bin_dir = self.root / "bin"
        self.extension_parent = self.data_home / "extensions"
        self.dbus_dir = self.data_home / "dbus-1" / "services"
        self.systemd_dir = self.config_home / "systemd" / "user"
        self.build_dir = self.root / "build"
        self.fake_bin = self.root / "fake-bin"
        self.command_log = self.root / "commands.log"
        self.gnome_log = self.root / "gnome-extensions.log"
        self.gsettings_state = self.root / "gsettings-enabled-extensions"
        self.daemon = self.root / "input" / "pulse-daemon"
        self.extension_source = (
            self.build_dir / "release" / "extension" / "pulse@kanterlabs"
        )

        for directory in (
            self.home,
            self.config_home,
            self.data_home,
            self.cache_home,
            self.bin_dir,
            self.extension_source,
            self.fake_bin,
        ):
            directory.mkdir(parents=True, exist_ok=True)

        self.daemon.parent.mkdir(parents=True, exist_ok=True)
        self.daemon.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        self.daemon.chmod(0o755)
        (self.extension_source / "extension.js").write_text(
            "// new extension fixture\n", encoding="utf-8"
        )

        self._write_command(
            "id",
            """#!/bin/sh
if [ "${1:-}" = "-u" ]; then
    printf '1000\n'
else
    exec /usr/bin/id "$@"
fi
""",
        )
        self._write_command(
            "gnome-extensions",
            """#!/bin/sh
printf '%s\n' "$*" >> "$PULSE_TEST_GNOME_LOG"
case "${1:-}" in
    disable) exit "${PULSE_TEST_DISABLE_STATUS:-0}" ;;
    enable) exit "${PULSE_TEST_ENABLE_STATUS:-0}" ;;
    *) exit 0 ;;
esac
""",
        )
        self._write_command(
            "systemctl",
            """#!/bin/sh
printf 'systemctl %s\n' "$*" >> "$PULSE_TEST_COMMAND_LOG"
case "$*" in
    *"is-active --quiet"*) exit 3 ;;
    *) exit 0 ;;
esac
""",
        )
        self._write_command(
            "busctl",
            """#!/bin/sh
printf 'busctl %s\n' "$*" >> "$PULSE_TEST_COMMAND_LOG"
exit 0
""",
        )
        self._write_command(
            "dbus-update-activation-environment",
            """#!/bin/sh
printf 'dbus-update-activation-environment %s\n' "$*" >> "$PULSE_TEST_COMMAND_LOG"
exit 0
""",
        )
        self._write_command(
            "gsettings",
            """#!/bin/sh
printf 'gsettings %s\n' "$*" >> "$PULSE_TEST_COMMAND_LOG"
case "${1:-}" in
    get)
        if [ -f "$PULSE_TEST_GSETTINGS_STATE" ]; then
            cat "$PULSE_TEST_GSETTINGS_STATE"
        else
            printf '%s\n' "${PULSE_TEST_GSETTINGS_ENABLED:-@as []}"
        fi
        exit "${PULSE_TEST_GSETTINGS_GET_STATUS:-0}"
        ;;
    set)
        if [ "${PULSE_TEST_GSETTINGS_SET_STATUS:-0}" -ne 0 ]; then
            exit "$PULSE_TEST_GSETTINGS_SET_STATUS"
        fi
        printf '%s\n' "${4:-}" > "$PULSE_TEST_GSETTINGS_STATE"
        exit 0
        ;;
    *)
        exit 1
        ;;
esac
""",
        )

    def _write_command(self, name: str, contents: str) -> None:
        command = self.fake_bin / name
        command.write_text(contents, encoding="utf-8")
        command.chmod(0o755)

    @property
    def extension_dir(self) -> Path:
        return self.extension_parent / "pulse@kanterlabs"

    @property
    def daemon_destination(self) -> Path:
        return self.bin_dir / "pulse-daemon"

    def environment(self, **overrides: str) -> dict[str, str]:
        environment = os.environ.copy()
        environment.update(
            {
                "HOME": str(self.home),
                "PATH": f"{self.fake_bin}:{environment['PATH']}",
                "PULSE_DAEMON_BINARY": str(self.daemon),
                "PULSE_BUILD_DIR": str(self.build_dir),
                "PULSE_BIN_DIR": str(self.bin_dir),
                "PULSE_EXTENSION_PARENT": str(self.extension_parent),
                "PULSE_DBUS_SERVICE_DIR": str(self.dbus_dir),
                "PULSE_SYSTEMD_USER_DIR": str(self.systemd_dir),
                "XDG_CONFIG_HOME": str(self.config_home),
                "XDG_DATA_HOME": str(self.data_home),
                "XDG_CACHE_HOME": str(self.cache_home),
                "PULSE_TEST_COMMAND_LOG": str(self.command_log),
                "PULSE_TEST_GNOME_LOG": str(self.gnome_log),
                "PULSE_TEST_DISABLE_STATUS": "0",
                "PULSE_TEST_ENABLE_STATUS": "0",
                "PULSE_TEST_GSETTINGS_STATE": str(self.gsettings_state),
                "PULSE_TEST_GSETTINGS_ENABLED": "@as []",
                "PULSE_TEST_GSETTINGS_GET_STATUS": "0",
                "PULSE_TEST_GSETTINGS_SET_STATUS": "0",
            }
        )
        environment.update(overrides)
        return environment

    def run(self, *arguments: str, **environment: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(INSTALLER), *arguments],
            cwd=REPOSITORY,
            env=self.environment(**environment),
            capture_output=True,
            text=True,
            check=False,
        )

    def create_populated_runtime_state(self) -> dict[Path, bytes]:
        files = {
            self.config_home / "pulse" / "config.toml": b"[spotify]\nclient_id = 'fixture'\n",
            self.config_home / "pulse" / "oauth-token-backup.txt": b"refresh-token-fixture\n",
            self.cache_home / "pulse" / "artwork" / "track.bin": b"artwork fixture bytes\n",
        }
        for path in files:
            path.parent.mkdir(parents=True, exist_ok=True)
        database_path = self.data_home / "pulse" / "pulse.sqlite3"
        database_path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(database_path) as database:
            database.execute("CREATE TABLE saved_fixture (name TEXT PRIMARY KEY, value TEXT)")
            database.execute(
                "INSERT INTO saved_fixture(name, value) VALUES (?, ?)",
                ("playlist", "Keep this row"),
            )
            database.commit()
        files[database_path] = database_path.read_bytes()
        for path, contents in files.items():
            if path != database_path:
                path.write_bytes(contents)
        return files

    def install_old_extension(self) -> None:
        self.extension_dir.mkdir(parents=True, exist_ok=True)
        (self.extension_dir / "extension.js").write_text(
            "// old extension fixture\n", encoding="utf-8"
        )

    def command_log_text(self) -> str:
        return self.command_log.read_text(encoding="utf-8") if self.command_log.exists() else ""

    def gnome_log_lines(self) -> list[str]:
        if not self.gnome_log.exists():
            return []
        return self.gnome_log.read_text(encoding="utf-8").splitlines()

    def close(self) -> None:
        self.tempdir.cleanup()


class InstallerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = InstallerFixture()

    def tearDown(self) -> None:
        self.fixture.close()

    def assertSuccessful(self, result: subprocess.CompletedProcess[str]) -> None:
        self.assertEqual(
            result.returncode,
            0,
            msg=f"installer failed:\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )

    def test_upgrade_disables_existing_extension_and_preserves_runtime_data(self) -> None:
        self.fixture.install_old_extension()
        preserved = self.fixture.create_populated_runtime_state()

        result = self.fixture.run()

        self.assertSuccessful(result)
        self.assertEqual(
            self.fixture.gnome_log_lines(),
            ["disable pulse@kanterlabs"],
        )
        self.assertNotIn("enable pulse@kanterlabs", self.fixture.gnome_log_lines())
        self.assertIn("enable --now pulse-daemon.service", self.fixture.command_log_text())
        self.assertEqual(
            (self.fixture.extension_dir / "extension.js").read_text(encoding="utf-8"),
            "// new extension fixture\n",
        )
        self.assertTrue(self.fixture.daemon_destination.exists())
        for path, contents in preserved.items():
            self.assertEqual(path.read_bytes(), contents, msg=f"runtime data changed: {path}")
        self.assertIn("left disabled", result.stdout)

    def test_fresh_install_does_not_auto_enable_extension(self) -> None:
        preserved = self.fixture.create_populated_runtime_state()

        result = self.fixture.run("--no-start")

        self.assertSuccessful(result)
        self.assertEqual(
            self.fixture.gnome_log_lines(),
            ["disable pulse@kanterlabs"],
        )
        self.assertEqual(
            (self.fixture.extension_dir / "extension.js").read_text(encoding="utf-8"),
            "// new extension fixture\n",
        )
        self.assertNotIn("enable pulse@kanterlabs", self.fixture.gnome_log_lines())
        for path, contents in preserved.items():
            self.assertEqual(path.read_bytes(), contents, msg=f"runtime data changed: {path}")

    def test_enable_extension_requires_explicit_flag(self) -> None:
        self.fixture.install_old_extension()

        result = self.fixture.run("--enable-extension")

        self.assertSuccessful(result)
        self.assertEqual(
            self.fixture.gnome_log_lines(),
            ["disable pulse@kanterlabs", "enable pulse@kanterlabs"],
        )
        self.assertIn("GNOME extension enabled", result.stdout)

    def test_no_start_upgrade_keeps_daemon_inactive_and_data_intact(self) -> None:
        self.fixture.install_old_extension()
        preserved = self.fixture.create_populated_runtime_state()

        result = self.fixture.run("--no-start")

        self.assertSuccessful(result)
        self.assertEqual(
            self.fixture.gnome_log_lines(),
            ["disable pulse@kanterlabs"],
        )
        self.assertNotIn("enable --now pulse-daemon.service", self.fixture.command_log_text())
        self.assertIn("activation was skipped (--no-start)", result.stdout)
        for path, contents in preserved.items():
            self.assertEqual(path.read_bytes(), contents, msg=f"runtime data changed: {path}")
        with sqlite3.connect(self.fixture.data_home / "pulse" / "pulse.sqlite3") as database:
            self.assertEqual(
                database.execute("SELECT name, value FROM saved_fixture").fetchone(),
                ("playlist", "Keep this row"),
            )

    def test_failed_activation_is_disabled_again(self) -> None:
        self.fixture.install_old_extension()

        result = self.fixture.run("--enable-extension", PULSE_TEST_ENABLE_STATUS="1")

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(
            self.fixture.gnome_log_lines(),
            [
                "disable pulse@kanterlabs",
                "enable pulse@kanterlabs",
                "disable pulse@kanterlabs",
            ],
        )
        self.assertIn("it was disabled again", result.stderr)

    def test_failed_disable_aborts_existing_upgrade_without_mutation(self) -> None:
        self.fixture.install_old_extension()
        preserved = self.fixture.create_populated_runtime_state()
        self.fixture.daemon_destination.write_bytes(b"old daemon\n")

        result = self.fixture.run("--no-start", PULSE_TEST_DISABLE_STATUS="1")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("could not disable existing GNOME extension", result.stderr)
        self.assertEqual(
            (self.fixture.extension_dir / "extension.js").read_text(encoding="utf-8"),
            "// old extension fixture\n",
        )
        self.assertEqual(self.fixture.daemon_destination.read_bytes(), b"old daemon\n")
        self.assertFalse(self.fixture.systemd_dir.exists())
        self.assertFalse(self.fixture.dbus_dir.exists())
        self.assertFalse((self.fixture.data_home / "pulse-extension-quarantine").exists())
        self.assertNotIn("gsettings ", self.fixture.command_log_text())
        for path, contents in preserved.items():
            self.assertEqual(path.read_bytes(), contents, msg=f"runtime data changed: {path}")

    def test_gsettings_clears_stale_uuid_when_gnome_shell_cannot_be_reached(self) -> None:
        preserved = self.fixture.create_populated_runtime_state()

        result = self.fixture.run(
            "--no-start",
            PULSE_TEST_DISABLE_STATUS="1",
            PULSE_TEST_GSETTINGS_ENABLED="['other@kanterlabs', 'pulse@kanterlabs']",
        )

        self.assertSuccessful(result)
        self.assertEqual(self.fixture.gnome_log_lines(), ["disable pulse@kanterlabs"])
        self.assertEqual(
            (self.fixture.extension_dir / "extension.js").read_text(encoding="utf-8"),
            "// new extension fixture\n",
        )
        self.assertEqual(self.fixture.gsettings_state.read_text(encoding="utf-8"), "['other@kanterlabs']\n")
        self.assertNotIn("enable pulse@kanterlabs", self.fixture.gnome_log_lines())
        self.assertFalse((self.fixture.data_home / "pulse-extension-quarantine").exists())
        for path, contents in preserved.items():
            self.assertEqual(path.read_bytes(), contents, msg=f"runtime data changed: {path}")

    def test_fresh_install_aborts_when_disabled_state_cannot_be_verified(self) -> None:
        preserved = self.fixture.create_populated_runtime_state()
        self.fixture.daemon_destination.write_bytes(b"old daemon\n")

        result = self.fixture.run(
            "--no-start",
            PULSE_TEST_DISABLE_STATUS="1",
            PULSE_TEST_GSETTINGS_ENABLED="['pulse@kanterlabs']",
            PULSE_TEST_GSETTINGS_GET_STATUS="1",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("could not confirm GNOME extension", result.stderr)
        self.assertFalse(self.fixture.extension_dir.exists())
        self.assertEqual(self.fixture.daemon_destination.read_bytes(), b"old daemon\n")
        self.assertFalse(self.fixture.systemd_dir.exists())
        self.assertFalse(self.fixture.dbus_dir.exists())
        self.assertFalse((self.fixture.data_home / "pulse-extension-quarantine").exists())
        for path, contents in preserved.items():
            self.assertEqual(path.read_bytes(), contents, msg=f"runtime data changed: {path}")

    def test_missing_gnome_extensions_aborts_existing_upgrade_without_mutation(self) -> None:
        self.fixture.install_old_extension()
        preserved = self.fixture.create_populated_runtime_state()
        self.fixture.daemon_destination.write_bytes(b"old daemon\n")
        (self.fixture.fake_bin / "gnome-extensions").unlink()

        result = self.fixture.run("--no-start")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("could not disable existing GNOME extension", result.stderr)
        self.assertEqual(
            (self.fixture.extension_dir / "extension.js").read_text(encoding="utf-8"),
            "// old extension fixture\n",
        )
        self.assertEqual(self.fixture.daemon_destination.read_bytes(), b"old daemon\n")
        self.assertFalse(self.fixture.systemd_dir.exists())
        self.assertFalse(self.fixture.dbus_dir.exists())
        self.assertFalse((self.fixture.data_home / "pulse-extension-quarantine").exists())
        for path, contents in preserved.items():
            self.assertEqual(path.read_bytes(), contents, msg=f"runtime data changed: {path}")


if __name__ == "__main__":
    unittest.main()
