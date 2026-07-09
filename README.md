# Isonapse

Isonapse is a local safety layer for AI coding agents. It watches what an
agent does — commands, file edits, network calls — decides what is allowed
by policy you control, and keeps a verifiable record of every decision.

The **Agent Hook** (public beta) governs Claude Code on your machine: it
learns your normal way of working in Profile mode, enforces your rules when
you say so, and proves what happened afterwards. Nothing leaves your
machine — no usage data, no crash reports, no telemetry.

Learn more at [isonapse.com](https://isonapse.com).

## Install

With [Homebrew](https://brew.sh) (macOS Apple Silicon, Linux x86_64):

```sh
brew install isonapse/tap/isonapse
```

Or with the installer script:

```sh
curl -fsSL https://github.com/Isonapse/isonapse-public/releases/latest/download/install.sh | sh
```

Then register the hook with Claude Code:

```sh
isonapse hook init
```

### Release channels

| Channel | What it is | Access |
|---|---|---|
| `main` | The public beta — what the commands above install | anonymous |
| `beta` | Pre-release ring | private, by invitation |
| `alpha` | Development ring | private, by invitation |

The releases on this repository are the `main` channel. Each release ships
binaries for macOS (Apple Silicon) and Linux (x86_64), with sha256
checksums alongside. Intel Macs can run the Apple Silicon binary under
Rosetta.

### How beta releases are marked

Isonapse is beta software, and every build says so in its version string:

```
isonapse 0.2.0-beta+main.a3f5d2e
         └─version─┘ └channel.build┘
```

- **`0.2.0-beta`** — the product version. The `-beta` suffix means beta
  software (see the [terms](https://isonapse.com/terms)); it is dropped
  when Isonapse graduates from beta.
- **`main.a3f5d2e`** — the release channel and the build identifier.

Release titles on this repository carry the same version. When reporting
a bug, paste the whole `isonapse --version` output — it identifies the
exact build.

## Example policies

Policies are plain Lua — deterministic, reviewable, and yours. The
[`examples/policies/`](examples/policies/) directory holds small,
self-contained examples to start from: protecting secrets on disk,
allowlisting network egress, and per-action runtime rules.

## Bugs and feedback

- **Bug reports and feature requests:** [open an issue](../../issues/new/choose)
  on this repository. The templates ask for the version, channel, and OS —
  please never paste tokens, keys, or other secrets into an issue.
- **Questions and ideas:** [Discussions](../../discussions).
- **Security vulnerabilities:** see [SECURITY.md](SECURITY.md) — please do
  not report vulnerabilities in public issues.

## Licensing

The Agent Hook and the forthcoming self-hosted Community Edition are free
forever, each under its own license. Enterprise Edition is the commercial
product. The license text ships with the releases on this repository; where
this README and the LICENSE file differ, the LICENSE file wins.

See also: [terms](https://isonapse.com/terms) ·
[privacy](https://isonapse.com/privacy) ·
[roadmap](https://isonapse.com/roadmap)
