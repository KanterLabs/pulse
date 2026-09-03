# Security policy

Pulse is pre-alpha and is not yet a supported production release. Security
fixes are developed against the `main` branch; older snapshots may be
incompatible with current Fedora, GNOME, or Spotify behavior.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through the repository's
GitHub Security Advisories channel when it is enabled. If that channel is not
available, contact the maintainers through the KanterLabs GitHub organization
before opening a public issue. Include the affected commit, a minimal
reproduction, and the impact. Redact all credentials, tokens, private
playlists, and personal logs.

Do not disclose a live Spotify client secret, access token, refresh token, or
authorization code in an issue, pull request, screenshot, or chat transcript.
If a credential may have been exposed, revoke it in Spotify and rotate the
application credentials immediately.

## Scope

Reports involving the following areas are especially useful:

- OAuth/PKCE callback handling and Secret Service token storage;
- D-Bus or MPRIS boundary violations and unintended cross-user access;
- installer/uninstaller path traversal, unsafe permissions, or data loss;
- credential or private metadata leakage through logs, caches, or diagnostics;
  and
- CI workflows that expose secrets or grant untrusted pull requests write or
  privileged access.

For contribution and disclosure expectations, see
[CONTRIBUTING.md](CONTRIBUTING.md).
