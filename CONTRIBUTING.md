# Contributing to Pulse

Thanks for helping build Pulse. It is a pre-alpha Fedora/GNOME companion, so
small, reviewable changes and evidence from a real GNOME session are more
useful than broad speculative features.

## Before you start

Read the [README](README.md) and the
[Fedora laptop implementation plan](docs/FEDORA_IMPLEMENTATION_PLAN.md). The
plan defines the process boundary, milestones, data-retention rules, and
acceptance criteria. Please open an issue or discussion for a change that
would alter those boundaries before implementing it.

Do not commit Spotify client secrets, refresh tokens, access tokens, browser
callback URLs, private playlists, local databases, or private logs. The
repository's ignore rules cover common local state, but inspect `git diff`
before every commit.

## Development setup

Use Fedora Workstation with GNOME, Rust 1.88+, Cargo, GJS/GNOME Shell, Bash,
Python 3, a session D-Bus, GNOME Keyring/Secret Service, and an official
Spotify desktop client. `shellcheck`, Node.js, and `glib-compile-schemas` are
useful for extension and script checks.

The supported copied-folder workflow is:

```bash
cd /path/to/pulse
./scripts/doctor-fedora.sh
./scripts/build.sh
```

Use `./scripts/install-user.sh` only when you need to exercise the installed
per-user systemd/D-Bus/extension lifecycle. Use `--help` on repository scripts
before passing optional flags. Never run the installer as root.

## Validation

Run the checks relevant to your change before opening a pull request:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
./scripts/build.sh
```

For shell or extension changes, also run the local equivalents when available:

```bash
find scripts -type f \( -name '*.sh' -o -name '*.bash' \) -print0 | xargs -0 -r bash -n
find scripts -type f \( -name '*.sh' -o -name '*.bash' \) -print0 | xargs -0 -r shellcheck
```

Validate extension JSON with Python and GSettings schemas with
`glib-compile-schemas --strict --dry-run` when those files exist. The CI
workflow performs conditional JavaScript/schema validation and reports when an
optional validator is unavailable.

Contract tests should use a private session bus and deterministic fixtures;
they must not depend on a contributor's live desktop session, Spotify account,
or network. Do not add tests that require real credentials to pass.

## Pull requests

- Keep each pull request focused and explain the user-visible or maintenance
  outcome.
- Describe the Fedora/GNOME versions and session type used for manual testing.
- Include the exact validation commands and their results.
- Update public documentation when behavior, commands, paths, permissions, or
  maturity changes.
- Add screenshots only when they show an actual working UI; until then, keep
  the README's screenshots section marked pending.
- Call out migrations, cache changes, new OAuth scopes, D-Bus contract changes,
  and security-sensitive behavior prominently in the PR description.

CI runs on the repository's `homelab` runner for metadata, lint, and short
checks, and on `homelab-heavy` for Rust workspace builds and tests. Pull
requests use the ordinary `pull_request` event with read-only repository
permissions and no secrets. Do not introduce `pull_request_target`, privileged
steps, or workflows that execute untrusted pull-request code with credentials.

## Security reports

Please do not file a public issue for a vulnerability, credential exposure,
token-handling bug, or cross-user data access. Follow the private reporting
instructions in [SECURITY.md](SECURITY.md), including a minimal reproduction
and affected commit, but redact all credentials and private user data. Allow
time for a fix before public disclosure.

## License

By contributing, you agree that your work is provided under the repository's
[MIT License](LICENSE).
