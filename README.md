<!-- isonapse-public-readme-source repo=Isonapse/isonapse ref=refs/heads/main sha=0167172e9f2a4661847b1224ea9f2156184e5fa4 -->
# Isonapse — a local policy and safety layer for AI coding agents

> **Status — Public beta:** The public `main` channel is the primary,
> token-free distribution. Private `beta` and `alpha` channels remain available
> to invited testers and Isonapse engineers. Every archive receives its own
> generated, candidate-bound README explaining channel selection.

**Available today: the Isonapse Agent Hook for Claude Code, Hermes Agent v0.20.0,
and pi 1.0.3 and 1.0.4.** You set the
rules; Isonapse checks every covered action before it runs — shell, file,
web, and tool calls — and keeps a signed, tamper-evident record you can
verify offline. Local-only: no cloud, no account, no telemetry. OpenAI Codex
CLI can be connected through the Apache-2.0 Hook ADK's reference adapter that you
review and register yourself, but Codex is a cooperative, fail-open host: it runs
the tool when its hook fails to start (see [Build an adapter](#build-an-adapter)).

    brew install isonapse/tap/isonapse

First run — `hook init`, `hook start`, `hook status`, and the one-time model
download it needs — is in [Install — public main](#install--public-main), with
the exact sizes stated up front.

Work normally while it learns (Profile), review the policy it proposes
(`isonapse hook suggest --user --diff`), then enforce it (`isonapse hook apply`).
Project rules that travel with a repository use their own preview and apply
commands; see [Keep project rules with the repository](#keep-project-rules-with-the-repository).

Free during the public beta · macOS 11+ (Apple silicon) · Linux x86_64
(glibc 2.35+) · License: proprietary — free during the public beta
([EULA](LICENSE.md))

**Where this is going:** the Agent Hook is step one, not the product ceiling.
The optional self-hosted **Community Edition** brings your developers' sessions
and containerised agents on one dashboard under one policy, free under its
own license, with an open adapter protocol for agents beyond Claude Code and
per-repository rules that travel with the repo. Its Wave 2 packages are evaluated
in private alpha/beta; public availability follows main release verification.
After that, the **Enterprise
Edition** scales the same provable record to a whole organisation: SSO,
fleet-wide budgets, compliance-ready reporting.
→ [Roadmap](https://developer.isonapse.com/roadmap)

For private-ring CE testers, optional session-purpose sharing is separate from
signed witness delivery. Use the installed CLI's
`hook config set explanatory_context.enabled true` and follow the
[purpose-sharing setup guide](https://docs.isonapse.com/docs/products/ce#optional-session-purpose)
for retention (seven days by default, at most 30), policy permissions, activation
and receiver consent. Existing witness-only enrollment is not silently widened.
New requests can provide purpose labels; old prompts cannot be reconstructed.
Check active settings and consent with `hook federation status`, then verify a
new request/action in the dashboard as administrator. These descriptions are not
complete transcripts or proof of task success. This candidate's setup improvements
do not imply that an older public installation supports the new settings.

[Install guide](https://developer.isonapse.com/install) ·
[What it does](https://developer.isonapse.com/product) ·
[Copy-ready Lua policies](https://github.com/Isonapse/isonapse-public/tree/main/examples/policies) ·
[Apache-2.0 adapter toolkit](https://github.com/Isonapse/isonapse-public/tree/main/adapter-toolkit) ·
[Feedback](https://developer.isonapse.com/feedback) ·
[Issues](https://github.com/Isonapse/isonapse-public/issues) ·
[Discussions](https://github.com/Isonapse/isonapse-public/discussions) ·
Security: security@isonapse.com (privately, please)

*Scope note: controlplane-produced authorizations that can advance are
recorded in the signed audit trail; narrow hook-local stops and
daemon-unreachable host prompts sit outside that receipt guarantee.*

## Diagnose a problem without changing protection

Run `isonapse hook doctor` first. It separates daemon health from installed hooks
and policy state, and explains when existing Claude sessions may still have
cached hooks. `hook events` shows configured events. Doctor and `hook status`
also state the learned-protection pause truthfully (an expired pause is never
shown as active), print per-session structural capacity, and say whether the
next automatic daemon start would keep its `controlplane.log` in the data
directory; a daemon the Hook starts automatically keeps running after that Hook
exits and appends to the same owner-only log. For a changed skill,
`hook skill check` or bare `hook skill diff` compares fingerprints and observed
package versions without printing file contents. For escaped local content review,
`hook skill diff <manifest-key> --baseline <known-good-file>` requires your supplied
copy to match the on-disk trusted digest exactly; it saves no source copies.
`hook skill untrust <manifest-key>` revokes trust for one key with operator
authentication, and rescans, `skill verify`, init and restart keep that
revocation until an explicit `skill trust`.
An upgrade never silently trusts new bytes. `hook integrity verify [--json]` is a
read-only comparison of the monitored Hook binary, config and policy with the
established baseline (exit 0 clean, 1 tampered, 2 unavailable, 3 partial); it
never rebaselines or clears containment, and a damaged saved baseline stays
unavailable rather than silently re-trusted. `hook witness query` filters retained
signed history by exact capability, inclusive RFC3339 `--since`/`--until` bounds
and `--order`, with `--json` summaries that omit payloads; `isonapse vault
sessions` lists resident vault session IDs and entry counts without opening closed
vaults or revealing values. Block messages name the event, risk, and next
diagnostic step; a denial that was durably recorded names its action id and
witness sequence on its `Evidence:` line. A `[session-structural-capacity]` block
means a fixed per-session limit was reached (256 distinct agent/capability pairs
or 64 agents); no policy, approval or mode change clears it, so end the session
and start a new one.

A personal install can pause only Enforce's learned checks with
`isonapse hook pause --for 10m`, for no more than 30 minutes. Your Lua policy
must explicitly permit `lifecycle:pause-learned` through an unscoped static rule without
a custom action dispatcher, and you must authenticate
freshly with the operating system. The current mode and other controls remain
unchanged; authorization and completion receipts are still required. Work
permitted through a pause does not become permanent learned approval.
Expiry, `hook resume`, restart, or a
mode or policy change restores the learned layer. Managed or unknown
installations deny this and other protection-relaxing changes while enterprise
approval support is unavailable. A local password does not grant enterprise permission.

## Build an adapter

The Apache-2.0 Hook ADK provides Python and TypeScript libraries, native callback
starters, Protocol v1 conformance, Hermes/Pi references, and a hook-command
reference adapter for OpenAI Codex CLI (proven with codex-cli 0.155.1 on macOS;
input replacement only, no approval, no exact output replacement; Codex is a
cooperative, fail-open host, so re-trust its hook definition after every
Isonapse upgrade: that Codex un-trusts an edited definition was observed on
codex-cli 0.155.1 and is not a maintained test). Install the pinned
toolkit package following its language README; no private source checkout is
needed. Production use requires an installed Agent Hook with host-profile
registration support. The synthetic scaffold remains a protocol test host,
not a production tool executor. Codex silently skips a hook definition it has
not been told to trust, which leaves it ungoverned. Setup, the supported Codex
versions and the steps after every Isonapse upgrade are in the toolkit's
[Codex reference adapter](https://github.com/Isonapse/isonapse-public/tree/main/adapter-toolkit/reference/codex)
guide. Isonapse does not yet warn when a registered Codex host stops sending
events; check its receipts with `isonapse hook report --host` and its registered host ID.

    python -m isonapse_hook_adk init agent.py
    npx --no-install isonapse-hook-adk init agent.mjs

Follow `adapter-toolkit/INTEGRATION.md` and `HOST-PROFILES.md` to review your
native callbacks, pin their executable/entrypoint and authorize capabilities
with `isonapse hook host-profile create`, `validate` and `register`. Activation
requires an authorized daemon restart. Managed policy can refuse registration;
capabilities are never accepted from model input. The initial custom-host
transport supports macOS and Linux. Windows custom-host transport is not supported. Use public issues for bugs;
send vulnerabilities privately to security@isonapse.com.

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
later. Then follow https://developer.isonapse.com/install for the complete
guided walkthrough from installation to a governed session.

Hermes Agent and pi use their own init command in place of the Claude Code
init, as the install guide shows. pi support requires one of the exactly
qualified pi releases, currently pi 1.0.3 and 1.0.4. The list is exact, not a
minimum or a range: this release refuses every other pi version by design until
it is qualified, including pi 0.80.2. Install the newest with
`npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.0.4` and
confirm `pi --version` prints 1.0.3 or 1.0.4 before `isonapse hook init --host pi`.
`pi update` and the pi.dev installer always install the newest pi release,
which this release may refuse until it is qualified. On a pi it has not
qualified, or whose version it cannot verify (for example while
`PI_PACKAGE_DIR` points elsewhere), the installed extension refuses every tool
call locally inside pi, in every gate mode, without a gate decision or receipt,
as long as that pi still loads the extension; run `isonapse hook status` after
any pi update. After upgrading from
pi 0.80.2, re-run `isonapse hook init --host pi`. Pi keeps
`/trust` decisions per agent directory (`PI_CODING_AGENT_DIR`, default
`~/.pi/agent`), so run pi and Isonapse with the same one.

Hermes support requires exactly Hermes Agent v0.20.0 (2026.8.3), audited upstream
commit `3c27eb623`; it is an exact requirement, not a minimum. Use
`isonapse hook init --host hermes` in place of the Claude Code init: it runs the
`hermes` on your `PATH`, refuses every other build and stops before writing
anything. Init installs and enables the Isonapse plugin, but it only checks the
other Hermes settings governance depends on and refuses when one is wrong. Leave
`HERMES_SAFE_MODE` and `HERMES_ENABLE_PROJECT_PLUGINS` unset (or not
`1`, `true`, `yes` or `on`) in the shell you start Hermes from (init and status
can only check their own environment, so run them from that shell), set
`telemetry.shared_metrics.enabled` to exactly `false`, and disable every other
enabled Hermes plugin (`hermes plugins list --enabled` shows them) so Isonapse is
the sole enabled user plugin. Run init, status and Hermes with the same
`HERMES_HOME` (default `~/.hermes`) and active Hermes profile.

Start Hermes in a recognized launch shape: the `hermes` executable, the `hermes`
console script that pipx, `uv tool install` or a virtual environment puts on
`PATH`, or a source checkout run as `python -m hermes_cli`. The control plane
authenticates the plugin's calls by that Hermes process, so a launch it does not
recognize, such as a renamed wrapper script, fails every tool call closed with
`preparation-refused`; `isonapse hook doctor` reports it as unauthenticated Hook
ingress. Hermes covers pre-tool authorization and session lifecycle but cannot
ask or rewrite: an ASK becomes a witnessed DENY. Gate mode is machine-wide, so a
mode switch you make for another host applies to Hermes too. In Normal and
Enforce, the gate's first-action check denies the first tool call of every Hermes
session, and the first after the Isonapse daemon restarts, with a witnessed DENY;
retrying the same call once proceeds when policy permits it. Every other ask, such
as one for a risky shell command, also becomes a witnessed DENY. An unreachable daemon
makes Hermes refuse the call without a receipt. After a tool call in a fresh
Hermes session, `isonapse hook report --host hermes` shows the recorded
decisions.

## Keep project rules with the repository

Your user policy is the machine-wide baseline; managed controls come first, then
project policy, then user policy. Learned history is stored per repository (by
normalized Git origin, or the canonical path without one), and Enforce falls back
to discounted machine-wide learning only when the repository has no opinion.
After working in Profile, run this inside the checkout and review the draft
before applying it:

    isonapse hook suggest --repo . --diff
    isonapse hook apply --target project
    isonapse hook policy show --repo .
    git add .isonapse/policy.lua && git commit

Project apply writes restrictions to `.isonapse/policy.lua`; fresh clones inherit
them without a trust grant. Only a reviewed project rule that widens the user
baseline needs `isonapse hook trust .`, bound to the exact policy bytes;
`isonapse hook trust --list` shows the grants and `isonapse hook untrust .`
revokes one. Plain `isonapse hook apply` targets the user baseline, not the
project file. `isonapse hook suggest --repo .` without `--diff` summarizes what
the repository has learned and says when it fell back to machine-wide learning.

Project apply then attempts the guarded Enforce transition. Gate mode is
machine-wide, not per repository: while the machine is still in Profile or
Normal, that transition switches every repository and every host to Enforce, not
only this project. If admission fails, the policy stays applied and the mode is
unchanged; `isonapse hook mode` shows the current mode.

## Optional containers — separate from the local Hook

The CLI also provides `isonapse images`, `isonapse server` and
`isonapse dashboard`. These optional launchers do not install or start Docker,
embed the CE backend in the Hook, or establish a supported public CE release.
Install Docker yourself; private GHCR packages require a separate Docker login
authorized to read them. A Homebrew or release-download token does not sign
Docker in.

Provision and retain an independent `ISONAPSE_BOOTSTRAP_SECRET` of at least 32
bytes for first-administrator setup and a 64-character hex `ISONAPSE_DB_KEY`.
Export those saved values from protected configuration. Server and dashboard
use persistent EdDSA issuer custody and JWKS verification, not a shared JWT
environment secret. Then run:

    isonapse images
    isonapse server start
    isonapse dashboard start

Open `http://127.0.0.1:3200/setup` once, enter the saved bootstrap secret and
create the first administrator. Afterwards use `/sign-in`.

The launchers bind only localhost (server 8080, dashboard 3200), retain the
server's data volume and never mount the host Docker socket. Image tags bind
the selected installation channel and full source revision: public main uses
`ghcr.io/isonapse/server`, `dashboard` and `controlplane`; private alpha/beta
use their `-preview` counterparts, with `candidate-<full-source-sha>` tags.
Images must be published and accessible. Brew and script installation record the
channel automatically; raw archives and development builds without that verified
context require explicit image references. Tags are source pins, not digest pins.

Launcher `--image` overrides the corresponding `ISONAPSE_SERVER_IMAGE` or
`ISONAPSE_DASHBOARD_IMAGE`, then the embedded reference. `isonapse images --env`
prints all three embedded image assignments for a Compose `--env-file`; it
does not apply launcher overrides. The tracked Compose recipe requires those
assignments and uses separate named volumes from the CLI launcher.

For upgrades or channel switches, back up data and keys and check schema
compatibility first. A different running image is refused: stop explicitly,
update the CLI, inspect the new image references and restart. Volumes persist;
there is no automatic cross-channel migration or rollback guarantee. See the
[installation guide](https://developer.isonapse.com/install) before proceeding.

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
- In an authorized personal plugin install, `isonapse hook disable` removes only the generated plugin and
  keeps Isonapse data; `enable` creates it again only when the plugin path is
  absent and refuses to replace an occupied path. Existing Claude sessions may
  retain cached hooks: restart Claude, then inspect `/hooks` in a fresh session.
  These commands do not pause an OS managed policy. Managed or unknown
  installations—including a personally chosen `--managed` setup—refuse uninstall
  and other protection-relaxing operations while enterprise approval support is
  unavailable. Managed registration does not prove EE enrollment or licensing,
  and sudo cannot supply organizational approval. Where removal is authorized,
  `isonapse hook uninstall` first freezes install-owned local filesystem
  identities, authenticates custom sockets against the health and installation
  PIDs and validates retained cleanup targets. Managed-policy ownership never
  overrides the earlier lifecycle refusal. It preserves unrelated organization policy
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

## Releases and versions

Isonapse defines three channels. Public binaries ship on `main`; private
`alpha` and `beta` rings carry earlier candidates.

| Channel | What it is | Authoritative releases | Access |
| --- | --- | --- | --- |
| `main` | Public beta; default channel | `Isonapse/isonapse-public` | anonymous |
| `beta` | Invited-test ring | `Isonapse/isonapse-releases` | private, by invitation |
| `alpha` | Private candidate ring | `Isonapse/isonapse-releases` | private, by invitation |

Isonapse is beta software, and every build says so in its version string.
The published identity is `0.3.0-beta+release.<short_sha>` everywhere it is
shown: the CLI, generated Claude Code plugin, GitHub Release title, and
Homebrew formula all describe the same build.

```
isonapse 0.3.0-beta+release.a3f5d2e
```

- **`0.3.0-beta`** — the product version. The `-beta` suffix marks beta
  software (see the [terms](https://developer.isonapse.com/terms)); it is
  dropped when Isonapse graduates from beta.
- **`release.a3f5d2e`** — the ring-neutral build identifier. The installer
  records your selected channel separately, so promotion keeps the same binary.

When reporting a bug, paste the whole `isonapse --version` output — it
identifies the exact build.

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

Token hygiene: limit a fine-grained token to `Isonapse/isonapse-releases` with
**Contents: Read-only** and nothing else, give it a short expiration and renew
it when it lapses, and revoke it in your GitHub settings as soon as you no
longer need it or if it may have been exposed. To keep it out of shell history,
enter it with `read -rs HOMEBREW_GITHUB_API_TOKEN && export HOMEBREW_GITHUB_API_TOKEN`,
and unset it when the install finishes. Private Homebrew upgrades need the
token again; Docker image pulls need their own `docker login ghcr.io`.

Every command and option is listed in the
[Hook command index](https://docs.isonapse.com/docs/products/agent-hook#command-index);
see the [troubleshooting guide](https://docs.isonapse.com/docs/products/agent-hook#troubleshooting)
when something does not work (sign-in required).

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

After an authorized personal-plugin upgrade, rerun `isonapse hook init` and
start a fresh Claude Code session to load regenerated handlers. A running
session can retain older cached hooks. Managed or unknown authority refuses
local replacement while enterprise approval support is unavailable, including
personally chosen `--managed` registrations. Consult the administrator; rerunning
`init --managed` or supplying a sudo password does not grant that permission.

<details>
<summary><strong>Distribution and verification internals</strong> — archive
contents, installer transaction, transport contract, and release binding</summary>

## What's in this archive

| File | Purpose |
| --- | --- |
| `isonapse` | The CLI — everything is driven from here |
| `isonapse-hook` | Per-event client that Claude Code invokes |
| `isonapse-controlplane` | The local decision engine (runs on your machine) |
| `isonapse-hermes-adapter` | Host Adapter Protocol bridge used by Hermes's native Python plugin for pre-tool authorization, lifecycle, and opportunistic result observation |
| `isonapse-pi-adapter` | Host Adapter Protocol bridge used by the Pi extension |
| `isonapse-update` | Updater — installs the verified latest or immutable pinned release |
| `LICENSE.md` | The Isonapse Agent Hook Public Beta EULA that governs this software |
| `THIRD_PARTY_NOTICES.md` | Notices for the downloaded machine-learning models |
| `THIRD_PARTY_DEPENDENCIES.md` | License + copyright text for open-source dependencies used by the native build groups, including build-time crates (also `isonapse licenses`) |
| `README.md` | Generated guide bound to the archive's exact channel and immutable source identity |
| `ISONAPSE_ARCHIVE_MANIFEST` | Schema-v1 target, mode, size, and SHA-256 commitment for every file above |

The dependency manifest follows the actual native archive and container Cargo
build groups, including normal, build and proc-macro dependencies. It covers
Darwin arm64/Linux amd64 archives and Linux amd64/arm64 containers, retaining
workspace features genuinely used by those artifacts while excluding test-only
and unrelated unbuilt dependencies. CE carries its separate manifest for CE
and shared Hook build groups.

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

## Release binding and channel machinery

Each published archive gets its own generated README rather than a copy of this
public-main page. That guide names the exact candidate, product and target and
explains public/private channel selection. It remains unchanged during promotion.

Release CI treats the private repository as required for the current `alpha`
and `beta` channels: it
publishes and then fetches back both the immutable and moving releases, checking
the exact scripts, complete target asset cohort, checksums, source commit, and
channel. The private copy of `main` is only an advisory rollback archive;
public `main` installs are sourced from `Isonapse/isonapse-public`.

Each release ships binaries for macOS 11 or later on Apple silicon and Linux
x86_64 with glibc 2.35 or later. Every archive has a SHA-256 sidecar plus a
separately signed and checksummed identity that binds its full source commit,
product, version, target, archive name and digest. The installer
rejects any mismatch before replacement and retains that full identity beside
the binaries. Intel macOS is not supported; there is no Intel prebuilt
artifact. Windows native is out of beta scope; no Windows build is
tested or released.

Each publication audits, clean-installs and tests only its selected formula on
both supported native platforms, with an empty tap-trust store. Unchanged tap
files remain byte-preserved; older releases are not prerequisites. The selected
formula advances only if the observed tap commit remains current, followed by
exact readback. A controlled candidate fixture tests channel link collisions.
Homebrew also tests upgrade ordering across candidates, including hashes that sort
lower than the installed hash. Its numeric package revision suffix does not change
the signed binary version, and the same candidate remains an upgrade no-op.

The short identifier is for display. Update, immutable pin, installer, and
Homebrew decisions use the checksummed release identity, so the publication
repository's `main` branch is never treated as the private source commit. A pin
gets its installer from the same accepted immutable release and commits only if
the installer's identity fetch has the exact build-identity digest already approved;
it never falls through to the moving alias.

</details>

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
