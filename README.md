<!-- isonapse-public-readme-source repo=Isonapse/isonapse ref=refs/heads/main sha=f1e71fa00a463311dc104a7029593e1f1e584077 -->
# Isonapse Agent Hook — release distribution guide

> **Status — Public beta:** The public `main` channel is the primary,
> token-free distribution. Private `beta` and `alpha` channels remain available
> to invited testers and Isonapse engineers. Every archive receives its own
> generated, channel-bound README.

A local safety layer for AI coding agents. You set the rules; Isonapse
checks covered actions before they run. Controlplane-produced authorizations
that can advance are recorded in a tamper-evident, signed audit trail you can
verify offline; narrow hook-local stops and daemon-unreachable host prompts sit
outside that receipt guarantee.

- Website and docs: https://developer.isonapse.com
- Install guide: https://developer.isonapse.com/install
- Copy-ready Lua policy examples: https://github.com/Isonapse/isonapse-public/tree/main/examples/policies
- Feedback: https://developer.isonapse.com/feedback
- Public issue tracker: https://github.com/Isonapse/isonapse-public/issues
- Discussions: https://github.com/Isonapse/isonapse-public/discussions
- Security reports (please, not in public issues): security@isonapse.com

## What's in this archive

| File | Purpose |
| --- | --- |
| `isonapse` | The CLI — everything is driven from here |
| `isonapse-hook` | Per-event client that Claude Code invokes |
| `isonapse-controlplane` | The local decision engine (runs on your machine) |
| `isonapse-update` | Updater — installs the verified latest or immutable pinned release |
| `LICENSE.md` | The Isonapse Agent Hook Public Beta EULA that governs this software |
| `THIRD_PARTY_NOTICES.md` | Notices for the downloaded machine-learning models |
| `THIRD_PARTY_DEPENDENCIES.md` | License + copyright text for the open-source crates compiled in (also `isonapse licenses`) |
| `README.md` | Generated guide bound to the archive's exact channel and immutable source identity |
| `ISONAPSE_ARCHIVE_MANIFEST` | Schema-v1 target, mode, size, and SHA-256 commitment for every file above |

This is a closed cohort: the script installer validates the manifest and every
listed member before changing an installed file. A missing, undeclared, linked,
non-executable, wrong-target, wrong-size, or digest-mismatched member rejects the
whole archive and leaves the existing installation unchanged.

The installed subset, checksummed build identity, and `installer.conf` commit
as one recoverable cohort under a per-install OS advisory lock shared by the
updater and installer. The installer preflights a complete sibling directory
before the first live rename. Any pre-commit failure restores the prior
directory and config byte-for-byte; after a killed process, the next invocation
resolves the retained identity-bound journal before auth or network access.
macOS keeps its lock sentinel alive through an inherited FIFO writer, and Linux
children inherit the locked descriptor, so a surviving foreground child cannot
overlap a new installer. The fixed release cohort has nine named installed
members; unrelated user-owned entries in the enclosing bin directory remain.

Every release lookup and download in both standalone scripts uses the same
bounded transport policy: 10 seconds to connect, no attempt over 120 seconds,
at most three retries, and five redirects. Two 28-second intermediate probes
reserve a full final attempt, which starts by second 179. One request therefore
reaches a verdict within 300 seconds without trusting the adjustable system
clock. Timeouts, refused connections, HTTP 408/429, and transient 5xx responses
retry; permanent 4xx responses are not retried.
Ambient curl configuration and URL globbing cannot expand that contract, and
production transfers are HTTPS-only. Channel/tag errors omit bearer credentials.
After mandatory recovery of any earlier interrupted install, exhaustion prepares
or commits no new transaction or live-cohort change.

## Install — public main

The recommended public install needs no GitHub token:

    brew install isonapse/tap/isonapse
    isonapse hook init
    isonapse hook start
    isonapse hook status

The verified public script installer is an alternative:

    curl -fsSL https://github.com/Isonapse/isonapse-public/releases/latest/download/install.sh | sh
    export PATH="$HOME/.isonapse/bin:$PATH"

The script does not edit shell profiles; add that export to yours for future
sessions. Then run the same required first-run sequence shown above.

Optional local intelligence remains a separate, skippable download:

    isonapse hook intel download

Every channel supports
macOS 11 or later on Apple silicon and Linuxbrew x86_64 with glibc 2.35 or
later. Every channel release snapshots the exact live tap topology, reconstructs
siblings from canonical channel history, binds their archive digests to the
separately published release checksums, and audits, clean-installs, and tests
every formula on both supported native platforms. The exact cohort advances in
one tap commit only if that source generation is still current. Later private
releases retain all three formulae.

Then follow https://developer.isonapse.com/install for the complete guided
walkthrough from installation to a governed session.

## Private alpha and beta channels

The public `main` channel is the default. Invited testers can instead use
`beta`, and Isonapse engineers can use `alpha`. Private channel access must be
authorized to read `Isonapse/isonapse-releases`: use a fine-grained token with
**Contents: Read-only** for that repository, or a classic token with the
**`repo`** scope.

    export HOMEBREW_GITHUB_API_TOKEN="YOUR_PRIVATE_BETA_TOKEN"
    brew install isonapse/tap/isonapse-beta

Replace `YOUR_PRIVATE_BETA_TOKEN` with the token from your invitation.
Isonapse engineers substitute `isonapse-alpha`.

Every command names one fully qualified formula. Do not run `brew trust` for
the tap: public main needs neither GitHub credentials nor whole-tap trust, and
private alpha/beta need only the documented private-release authorization.
Install one channel at a time. To switch, uninstall the current formula before
installing the new one; Homebrew's ordinary link collision otherwise leaves the
existing linked binaries active and can leave the new keg unlinked.

The private script installer verifies the checksummed source-build identity,
outer archive digest, and complete internal archive manifest. This alternative
requires the GitHub CLI (`gh`) on `$PATH`; use the Homebrew path above if `gh`
is not installed:

    export GITHUB_TOKEN="YOUR_PRIVATE_BETA_TOKEN"
    gh release download beta-latest \
      --repo Isonapse/isonapse-releases \
      --pattern install.sh \
      --dir /tmp --clobber
    CHANNEL=beta GITHUB_TOKEN="$GITHUB_TOKEN" sh /tmp/install.sh

After upgrading an existing install, rerun the same init form you already use
(`isonapse hook init`, or `isonapse hook init --managed`). This regenerates
stale plugin or managed-host configuration without resetting your Isonapse
state. Then start a fresh Claude Code session so the host loads the regenerated
55-second handlers; a session that was already open can retain its old timeout.

## Releases and versions

Isonapse defines three channels. Public binaries ship on `main`; private
`alpha` and `beta` rings carry earlier candidates.

Each published archive gets its own generated README rather than a copy of this
public-main page. That generated guide names the exact channel, immutable tag,
full source commit, authoritative distribution repository, authentication
requirement, and channel-matching install/update commands.

| Channel | What it is | Authoritative releases | Access |
| --- | --- | --- | --- |
| `main` | Public beta; default channel | `Isonapse/isonapse-public` | anonymous |
| `beta` | Invited-test ring | `Isonapse/isonapse-releases` | private, by invitation |
| `alpha` | Development ring | `Isonapse/isonapse-releases` | private, by invitation |

Release CI treats the private repository as required for the current `alpha`
and `beta` channels: it
publishes and then fetches back both the immutable and moving releases, checking
the exact scripts, complete target asset cohort, checksums, source commit, and
channel. The private copy of `main` is only an advisory rollback archive;
public `main` installs are sourced from `Isonapse/isonapse-public`.

Each release ships binaries for macOS 11 or later on Apple silicon and Linux
x86_64 with glibc 2.35 or later. Every archive has a SHA-256 sidecar plus a
separately checksummed, versioned identity that binds its full source commit,
channel, product version, target, archive name, and digest. The installer
rejects any mismatch before replacement and retains that full identity beside
the binaries. Intel macOS is not supported in Wave 1; there is no Intel
prebuilt artifact. Windows native is out of beta scope; no Windows build is
tested or released.

Isonapse is beta software, and every build says so in its version string:

The canonical identity is `0.2.0-beta+<channel>.<short_sha>` everywhere it is
shown: the CLI, generated Claude Code plugin, GitHub Release title, and
Homebrew formula all describe the same build.

```
isonapse 0.2.0-beta+beta.a3f5d2e
         └─version─┘ └channel.build┘
```

- **`0.2.0-beta`** — the product version. The `-beta` suffix marks beta
  software (see the [terms](https://developer.isonapse.com/terms)); it is
  dropped when Isonapse graduates from beta.
- **`beta.a3f5d2e`** — the release channel and the build identifier.

The short identifier is for display. Update, immutable pin, installer, and
Homebrew decisions use the checksummed release identity, so the publication
repository's `main` branch is never treated as the private source commit. A pin
gets its installer from the same accepted immutable release and commits only if
the installer's identity fetch has the exact build-identity digest already approved;
it never falls through to the moving alias.

When reporting a bug, paste the whole `isonapse --version` output — it
identifies the exact build.

## Quick facts

- Everything runs locally: no cloud service, no account, and no telemetry.
- Model setup uses Hugging Face GETs: `hook init` automatically fetches the
  required 90.9 MB (86.7 MiB) embedding model; `hook intel download` adds the
  user-started 1.877 GB (1.748 GiB) optional set. All pinned models total
  1.968 GB (1.833 GiB); no user content or telemetry is uploaded.
- Every verified model file requires macOS kqueue or Linux inotify. Linux arms
  its watcher through the retained parent descriptor under `/proc/self/fd`. If
  the required embedding cannot arm that watcher, startup fails; restore the
  facility and start the daemon again.
- After required validation succeeds, Linux lazy model loading additionally
  requires `memfd_create` with file sealing and `/proc/self/fd`. First use
  temporarily needs sealed backing equal to one model footprint — up to 837.1
  MB (798.3 MiB) for PII — plus ONNX Runtime session memory. Only one cold model
  is admitted; another caller does not queue. If only that later construction
  is blocked, the daemon remains up while PII/injection use regex/structural
  fallbacks, NLI is unavailable, and an Enforce learned check without an
  explicit policy permit asks for confirmation.
- `hook start` can make an opt-in GitHub release metadata check;
  `notify_on_update` defaults off, the response contains release metadata only,
  and the check sends no user content.
- A fresh install starts in Profile mode — ordinary behavioral actions are
  allowed while Isonapse watches and learns. Budgets, hard envelopes, and the
  narrow self-protection guard can still block from the first action.
- Every install mode locally denies direct Edit/Write and `rm`/`chmod` attempts
  against Isonapse data and its active plugin before contacting the daemon.
  Managed mode also installs current Claude Code host permission rules. This is
  best-effort defense in depth, not an OS sandbox; a daemon-down local DENY has
  no witness receipt.
- In plugin mode, `isonapse hook disable` removes only the generated plugin and
  keeps Isonapse data; `enable` creates it again only when the plugin path is
  absent and refuses to replace an occupied path. These commands do not pause an OS
  managed policy. `isonapse hook uninstall` first freezes install-owned local filesystem
  identities, authenticates custom sockets against the health and installation
  PIDs, then verifies and removes an exact current or published
  Isonapse-generated managed policy. It preserves unrelated organization policy
  and fails closed on duplicate, ambiguous, detected path/identity replacement,
  or unexpected local state.
  It then stops the daemon, revalidates the frozen targets, and removes local
  bootstrap data through same-parent quarantine entries. A configured
  `data_dir` outside that bootstrap installation is refused before
  managed-policy mutation; external witness, policy, vault, or other file
  overrides are preserved for deliberate manual cleanup.
  Timestamped managed-policy backups remain for manual administrator or MDM
  restoration; uninstall does not restore one automatically. This checked
  workflow is not a filesystem transaction or OS sandbox against a hostile
  process already running as the same account (or root) and deliberately
  targeting lifecycle or private quarantine entries between syscalls; stop that process before
  retrying or resolve the retained state manually.

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
https://developer.isonapse.com/feedback
