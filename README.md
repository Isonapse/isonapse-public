# Isonapse Agent Hook — public beta

A local safety layer for AI coding agents. You set the rules; Isonapse
enforces them on every action your agent takes — before it runs — and
records every decision in a tamper-evident, signed audit trail you can
verify offline.

- Website and docs: https://developers.isonapse.com
- Install guide: https://developers.isonapse.com/install
- Bug reports: https://github.com/Isonapse/isonapse-public/issues
- Questions and ideas: https://github.com/Isonapse/isonapse-public/discussions
- Security reports (please, not in public issues): security@isonapse.com

## What's in this archive

| File | Purpose |
| --- | --- |
| `isonapse` | The CLI — everything is driven from here |
| `isonapse-hook` | Per-event client that Claude Code invokes |
| `isonapse-controlplane` | The local decision engine (runs on your machine) |
| `isonapse-update` | Updater — fetches and installs the newest release |
| `LICENSE.md` | The public-beta EULA that governs this software |
| `THIRD_PARTY_NOTICES.md` | Notices for the downloaded machine-learning models |
| `THIRD_PARTY_DEPENDENCIES.md` | License + copyright text for the open-source crates compiled in (also `isonapse licenses`) |

## Install

The recommended path is Homebrew:

    brew install isonapse/tap/isonapse
    isonapse hook init

or the installer script (which verifies checksums):

    curl -fsSL https://github.com/Isonapse/isonapse-public/releases/latest/download/install.sh | sh

Then follow https://developers.isonapse.com/install — four steps from
zero to a governed session.

## Quick facts

- Everything runs locally: no cloud service, no account, and no telemetry.
- The only network call at runtime is an optional model download you start
  yourself (`isonapse hook intel download`, a one-time ~1.5 GB).
- A fresh install starts in Profile mode — watching and learning, nothing
  blocked. You review the rules it proposes and promote to enforcement
  when you're ready.
- Leaving is clean: `isonapse hook uninstall` removes everything and
  Claude Code runs exactly as it did before.

## License

This is proprietary software, free of charge during the public beta for
personal testing, research, and internal, non-production evaluation.
Downloading, installing, or using it means you accept the EULA in
[LICENSE.md](LICENSE.md). Production and commercial use are not covered
by the beta license — contact licensing@isonapse.com.

Attribution for the third-party code and models bundled with Isonapse lives
in `THIRD_PARTY_DEPENDENCIES.md` and `THIRD_PARTY_NOTICES.md` — included in
every release archive and printed by `isonapse licenses`.

It's a beta: expect rough edges, keep backups, and tell us what broke —
https://developers.isonapse.com/feedback
