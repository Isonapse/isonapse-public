<!-- isonapse-public-readme-source repo=Isonapse/isonapse ref=refs/heads/main sha=bce610938cb9d55d69beae1fc1808237ef19c187 -->
# Isonapse — a local policy and safety layer for coding agents

> **Status — Public beta:** free during the beta ·
> macOS 11 or later on Apple silicon · Linux x86_64 with glibc 2.35 or later ·
> proprietary binaries under the [beta EULA](LICENSE.md) · Hook ADK under Apache-2.0

**The problem.** A coding agent such as Claude Code or Codex CLI runs shell
commands, edits files and calls tools on your machine. Each host has its own
approval prompt, permission settings and record of what was approved. You
cannot apply one set of rules to all your agents, and you cannot prove
afterwards what was authorized.

**What Isonapse does.** A small local daemon checks every covered action
before it runs, against a policy you write in Lua. It can allow the action,
ask you, rewrite the call, or block it. Every allow and every question it
issues is signed into a tamper-evident record you can verify offline with
the public key. In Profile mode it watches your normal work and proposes a
policy; you review the diff and switch to Enforce. Everything runs on your
machine: no cloud, no account, no telemetry.

**Who it is for.** Engineers who run Claude Code, Hermes Agent, pi or Codex
CLI on real repositories, and teams that want project rules to travel with
the code and a verifiable record of what their agents did.

[Install guide](https://developer.isonapse.com/install) ·
[What it does](https://developer.isonapse.com/product) ·
[Roadmap](https://developer.isonapse.com/roadmap) ·
[Feedback](https://developer.isonapse.com/feedback) ·
[Issues](https://github.com/Isonapse/isonapse-public/issues) ·
[Discussions](https://github.com/Isonapse/isonapse-public/discussions) ·
Security: security@isonapse.com, privately (see [SECURITY.md](SECURITY.md))

## Install — public main

    brew install isonapse/tap/isonapse
    isonapse hook init
    isonapse hook start
    isonapse hook status

The public channel needs no GitHub token. Builds exist only for Apple silicon
Macs and x86_64 Linux: Intel macOS is not supported, and Windows native is out of beta scope.

## Supported hosts

The Hook works with Claude Code, Hermes Agent v0.20.0, and pi 1.0.3 and 1.0.4.
OpenAI Codex CLI and your own agent connect through the Hook ADK.

| Host | Version | Connects through | Block | Ask you | Rewrite input | Replace output |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | No pinned version; Isonapse does not check it | Built in, twelve hook events | Yes | Yes | Yes | Yes, within documented limits |
| Hermes Agent | Exactly v0.20.0 (2026.8.3); setup refuses other builds | Built in, plugin | Yes | No: a question becomes a refusal, recorded when witness storage is available | No: a call that needs a rewrite is refused | No |
| pi | Exactly pi 1.0.3 and 1.0.4; Node.js 22.19.0 or newer | Built in, pinned extension | Yes | Yes, through pi's own prompt | Yes | Yes |
| OpenAI Codex CLI | Proven with codex-cli 0.155.1 on macOS; the adapter does not check the version | Hook ADK reference adapter you review and register | Yes | No: a question becomes a refusal, recorded when witness storage is available | Yes, in Normal and Enforce: shell commands, single-file patches, MCP tool arguments | No; a result can be withheld |
| Your own agent | Your adapter, built with the Hook ADK (Python or TypeScript) | A host profile you register | Yes, if the host honors a refusal | As declared in your reviewed host profile | As declared | As declared |

Isonapse governs Codex through the reference adapter you review and register,
but Codex is a cooperative, fail-open host: it runs the tool when its hook
fails to start. It also runs the tool with no check when it has not trusted
its hook definition. Only the Codex CLI is qualified; the ChatGPT desktop app
runs the same `~/.codex` hooks, but it is unproven and unsupported.

`isonapse hook status` warns when the registration, hook definition or pin of
a registered host, or the Isonapse install, changed and no tool decision from
that host followed, and it names the fix. For a fail-open host this is an
early warning, not a guarantee, so make one harmless call and confirm a new
receipt with `isonapse hook report --host <id>` after setup, after every Codex
or Isonapse update and after any change to the hook definitions.
What each host does when the daemon is unreachable, and when a hook cannot
run, is on the [supported hosts](https://developer.isonapse.com/product#hosts)
page.

## First run

A fresh install starts in Profile: ordinary work is allowed while Isonapse
watches and learns. Review the policy it proposes
(`isonapse hook suggest --user --diff`), then enforce it (`isonapse hook apply`):

    isonapse hook report                  # what Isonapse observed
    isonapse hook suggest --user --diff   # the proposed policy, as a diff
    isonapse hook apply                   # apply it; attempts the switch to Enforce

Hermes Agent and pi have their own init, alongside or instead of the Claude
Code init: `isonapse hook init --host hermes` or `isonapse hook init --host pi`.
Each accepts only the exact host releases listed above. The settings Isonapse
requires of each host are below and in the
[install guide](https://developer.isonapse.com/install).

<details>
<summary><strong>Hermes Agent and pi</strong>: exact versions and required settings</summary>

pi support requires one of the exactly qualified pi releases, currently pi
1.0.3 and 1.0.4. The list is exact, not a minimum or a range: this release
refuses every other pi version by design until it is qualified, including pi
0.80.2. Install the newest with
`npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.0.4` and
confirm `pi --version` prints 1.0.3 or 1.0.4 before
`isonapse hook init --host pi`. `pi update` and the pi.dev installer always
install the newest pi release, which this release may refuse until it is
qualified. On a pi it has not qualified, or whose version it cannot verify
(for example while `PI_PACKAGE_DIR` points elsewhere), the installed extension
refuses every tool call locally inside pi, in every gate mode, without a gate
decision or receipt, as long as that pi still loads the extension. Run
`isonapse hook status` after any pi update, from the directory you start pi
in. After upgrading from pi 0.80.2, re-run `isonapse hook init --host pi`. Pi
keeps `/trust` decisions per agent directory (`PI_CODING_AGENT_DIR`, default
`~/.pi/agent`), so run pi and Isonapse with the same one.

Hermes support requires exactly Hermes Agent v0.20.0 (2026.8.3), audited
upstream commit `3c27eb623`; it is an exact requirement, not a minimum.
`isonapse hook init --host hermes` runs the `hermes` on your `PATH` and
refuses every other build before writing anything. Init installs and enables
the Isonapse plugin, but it only checks the other Hermes settings governance
depends on and refuses when one is wrong. Leave `HERMES_SAFE_MODE` and
`HERMES_ENABLE_PROJECT_PLUGINS` unset (or not `1`, `true`, `yes` or `on`) in
the shell you start Hermes from (init and status can only check their own
environment, so run them from that shell), set
`telemetry.shared_metrics.enabled` to exactly `false`, and disable every other
enabled Hermes plugin (`hermes plugins list --enabled` shows them) so Isonapse
is the sole enabled user plugin. Run init, status and Hermes with the same
`HERMES_HOME` (default `~/.hermes`) and active Hermes profile.

Start Hermes in a recognized launch shape: the `hermes` executable, the
`hermes` console script that pipx, `uv tool install` or a virtual environment
puts on `PATH`, or a source checkout run as `python -m hermes_cli`. The control
plane authenticates the plugin's calls by that Hermes process, so a launch it
does not recognize, such as a renamed wrapper script, fails every tool call
closed with `preparation-refused`; `isonapse hook doctor` reports it as
unauthenticated Hook ingress. Hermes covers pre-tool authorization and session
lifecycle but cannot ask or rewrite: an ASK becomes a DENY, recorded when
witness storage is available. Gate mode is machine-wide, so a mode switch you
make for another host applies to Hermes too. In Normal and Enforce, the gate's
first-action check denies the first tool call of every Hermes session, and the
first after the Isonapse daemon restarts; retrying the same call once proceeds
when policy permits it. Every other ask, such as one for a risky shell command,
also becomes a DENY. An unreachable daemon makes Hermes refuse the call without
a receipt. After a tool call in a fresh Hermes session,
`isonapse hook report --host hermes` shows the recorded decisions.

</details>

Optional local intelligence remains a separate, skippable download:

    isonapse hook intel download

Downloads: `hook init` automatically fetches the required 90.9 MB (86.7 MiB)
embedding model from Hugging Face. The optional, user-started
`isonapse hook intel download` adds 1.877 GB (1.748 GiB) of on-device
detection models; all pinned models total 1.968 GB (1.833 GiB). No user
content or telemetry is uploaded. `hook start` can make an opt-in GitHub
release metadata check; `notify_on_update` defaults off.

The verified script installer is the alternative to Homebrew. It installs
under `~/.isonapse/bin` and does not edit your shell profile:

    curl -fsSL https://github.com/Isonapse/isonapse-public/releases/latest/download/install.sh | sh
    export PATH="$HOME/.isonapse/bin:$PATH"

Add that export to your shell profile for future sessions, then run the same
`hook init`, `hook start` and `hook status`.

## Private alpha and beta channels

Besides the public `main` channel, Isonapse publishes two private channels:
`beta` for invited testers and `alpha` for the newest builds, ahead of beta,
by invitation.
Private channel access must be authorized to read
`Isonapse/isonapse-releases`: use a fine-grained token with
**Contents: Read-only** for that repository, or a classic token with the
**`repo`** scope. Invited testers use the token from their invitation and
unset it when the install finishes:

    export HOMEBREW_GITHUB_API_TOKEN="YOUR_PRIVATE_BETA_TOKEN"
    brew install isonapse/tap/isonapse-beta

Private Homebrew upgrades need the token again; Docker image pulls need their
own `docker login ghcr.io`.

The private script installer needs the GitHub CLI (`gh`) on `$PATH`:

    export GITHUB_TOKEN="YOUR_PRIVATE_BETA_TOKEN"
    gh release download beta-latest \
      --repo Isonapse/isonapse-releases \
      --pattern install.sh \
      --dir /tmp --clobber
    CHANNEL=beta GITHUB_TOKEN="$GITHUB_TOKEN" sh /tmp/install.sh

## Upgrade

After the upgrade and before the restart, run `isonapse hook status` and
review any change it names besides the upgraded Isonapse files, such as
`policy.lua` or `config.toml`: by default (`integrity.refresh_on_restart`), a
restart approves every monitored file as it then is.

    brew upgrade isonapse        # or rerun the script installer
    isonapse hook restart        # moves the daemon onto the installed build
    isonapse hook adk-pin        # Codex CLI only: re-pin the upgraded Hook
    isonapse hook status

After an authorized personal-plugin upgrade, rerun `isonapse hook init` once
`hook restart` has run, and start a fresh Claude Code session to load
regenerated handlers. A running session can retain older cached hooks. Until
`adk-pin` runs, an adapter that reads the pin file, such as the Codex reference
adapter, refuses every tool call.

Managed or unknown authority refuses local replacement while enterprise
approval support is unavailable, including personally chosen `--managed`
registrations. Consult the administrator; rerunning `init --managed` or
supplying a sudo password does not grant that permission.

## Modes

- **Profile** observes and reports. Structural limits, self-protection,
  refusals by the host integration itself and the identity checks that run
  before policy still apply from the first action.
- **Normal** enforces your block rules and asks before risky shell commands.
- **Enforce** also hard-blocks catastrophic commands, applies your ask
  rules and uses the learned baseline.

Gate mode is machine-wide, not per repository or per host.
[Details](https://developer.isonapse.com/product#modes).

## A policy is a Lua file

```lua
return {
  policy_version = "action-rules-v1",
  actions = {
    ["tool:Bash:rm"] = {
      decision = "DENY",
      reason = "destructive — use trash-cli or a scoped script",
    },
  },
}
```

Fourteen commented, loadable examples are in
[examples/policies](examples/policies): one ladder per policy field, one
per Lua pattern. The policy surface is explained on the
[product page](https://developer.isonapse.com/product#policy-example).

## Keep project rules with the repository

Your user policy is the machine-wide baseline; managed controls come first,
then project policy, then user policy. After working in Profile, run this
inside the checkout and review the draft before applying it:

    isonapse hook suggest --repo . --diff
    isonapse hook apply --target project
    isonapse hook policy show --repo .
    git add .isonapse/policy.lua && git commit

Project apply writes restrictions to `.isonapse/policy.lua`; fresh clones
inherit them without a trust grant. Only a reviewed project rule that
widens the user baseline needs `isonapse hook trust .`, bound to the exact
policy bytes; `isonapse hook trust --list` shows the grants and
`isonapse hook untrust .` revokes one. Project apply then attempts the
machine-wide switch to Enforce: while the machine is still in Profile or
Normal, it switches every repository and every host to Enforce, not only
this project. If admission fails, the policy stays applied and the mode is
unchanged.

## Build an adapter with the Hook ADK (Apache-2.0)

The Hook, daemon and policy engine are proprietary binaries. The Hook ADK
that connects other agents to them is open source: Python and TypeScript
packages, the Host Adapter Protocol v1, a conformance suite, and reference
adapters for Codex CLI, Hermes and pi. Source:
[adapter-toolkit](https://github.com/Isonapse/isonapse-public/tree/main/adapter-toolkit).
Every release also ships the packages, the protocol and guides and the Codex
reference adapter as `isonapse-adapter-toolkit.tar.gz`, which Homebrew
installs under `$(brew --prefix)/share/isonapse/` and the script installer
next to the binaries; the packages are not on npm or PyPI. Install one from
that file first, as the toolkit's README shows, then start an adapter:

    python -m isonapse_hook_adk init agent.py
    npx --no-install isonapse-hook-adk init agent.mjs

Start with [INTEGRATION.md](adapter-toolkit/INTEGRATION.md) and
[HOST-PROFILES.md](adapter-toolkit/HOST-PROFILES.md); Codex setup is in
[reference/codex](adapter-toolkit/reference/codex). Register a host from a
normal terminal with OS authentication, never from inside the agent you
are governing. Custom-host transport supports macOS and Linux only.
Propose a host profile with the "Host adapter or profile" issue template.

## What it does not do

- It is not an OS sandbox. It checks the actions a host reports, not every
  process on the machine.
- Shell commands are checked by bounded static analysis. An unusual way of
  writing a command can be attributed to a different program than the one
  that runs.
- Hermes and Codex cannot ask you. When the decision is to ask, they get a
  refusal.
- Refusals a host integration or adapter makes before the daemon decides,
  refusals by the identity and session checks that run before policy, and
  local self-protection stops while the daemon is down carry no receipt.
  When the Hook gets no decision from the daemon, Claude Code falls back to
  its own approval prompt, and Isonapse records nothing you approve there.
- A session's Isonapse identity lasts 8 hours on every host, in every mode.
  After that, no tool call in the session is authorized: Codex and Hermes
  refuse each call, while Claude Code, pi and other hosts that can ask you ask
  for each call (without an approval prompt, the call is refused). A call you
  approve runs without an Isonapse authorization receipt, and its output is
  withheld from the model. Starting a new session (in Codex, a new thread)
  recovers. Resuming the session does not renew the identity; for Claude Code,
  only a resume in a new Claude Code process does (restart Claude Code, then
  resume the session).
- PII and injection detectors can miss. Secret scrubbing protects exact
  values, not encoded or derived copies.
- Withholding a result does not undo an action that already ran.

Full list: [guarantees and limits](https://developer.isonapse.com/product#guarantees).

## When something does not work

    isonapse hook doctor    # daemon, hooks, policy and integrity state; changes nothing
    isonapse hook status    # does the daemon run the installed build; is each host ready
    isonapse hook report    # recent decisions

Start with the
[troubleshooting section of the install guide](https://developer.isonapse.com/install#troubleshooting).
Pausing, disabling and uninstalling are described on the
[install guide](https://developer.isonapse.com/install); the limits of
disable and uninstall are summarized below. The command index and the
troubleshooting guide are on docs.isonapse.com (sign-in required).

<details>
<summary><strong>Disable and uninstall</strong>: what they keep, refuse and cannot guarantee</summary>

In an authorized personal plugin install, `isonapse hook disable` removes only
the generated plugin and keeps Isonapse data; `enable` creates it again only
when the plugin path is absent and refuses to replace an occupied path.
Existing Claude sessions may retain cached hooks: restart Claude, then inspect
`/hooks` in a fresh session. These commands do not pause an OS managed policy.
Managed or unknown installations, including a personally chosen `--managed`
setup, refuse uninstall and other protection-relaxing operations while
enterprise approval support is unavailable. Managed registration does not
prove EE enrollment or licensing, and sudo cannot supply organizational
approval.

Where removal is authorized, `isonapse hook uninstall` first freezes
install-owned local filesystem identities, authenticates custom sockets against
the health and installation PIDs and validates retained cleanup targets.
Managed-policy ownership never overrides the earlier lifecycle refusal. It
preserves unrelated organization policy and fails closed on duplicate,
ambiguous, detected path/identity replacement, or unexpected local state. It
then stops the daemon, revalidates the frozen targets, and removes local
bootstrap data through same-parent quarantine entries. A configured `data_dir`
outside that bootstrap installation is refused before managed-policy mutation;
external witness, policy, vault, or other file overrides are preserved for
deliberate manual cleanup. Timestamped managed-policy backups remain for manual
administrator or MDM restoration; uninstall does not restore one automatically.
This checked workflow is not a filesystem transaction or OS sandbox against a
hostile process already running as the same account (or root) and deliberately
targeting lifecycle or private quarantine entries between syscalls; stop that
process before retrying or resolve the retained state manually.

</details>

## Releases and channels

Every build is `0.3.0-beta+release.<short_sha>`. The CLI, the generated
Claude Code plugin, the GitHub release title and the Homebrew formula all
name that same build; Homebrew adds a numeric package revision to its own
version. Paste the whole `isonapse --version` output when you report a bug.

| Channel | What it is | Releases and access |
| --- | --- | --- |
| `main` | Public beta; default | this repository; anonymous |
| `beta` | Invited testing | private, by invitation |
| `alpha` | Newest builds, ahead of beta | private, by invitation |

All public `main` installs are sourced from this repository; the private
channels are described under
[Private alpha and beta channels](#private-alpha-and-beta-channels).
Install one channel at a time; uninstall the current formula before
switching. Every archive ships a SHA-256 sidecar and a separately signed
identity binding its source commit, product, version, target and digest.
The installer rejects any mismatch. Details are in the
[install guide](https://developer.isonapse.com/install).

## Community Edition and beyond

The Agent Hook is step one. The self-hosted Community Edition brings a
team's sessions onto one dashboard under one policy and is in private beta
for invited testers. Enterprise Edition for whole organisations follows.
[Roadmap](https://developer.isonapse.com/roadmap)

<details>
<summary><strong>Optional containers</strong>, separate from the local Hook</summary>

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
does not apply launcher overrides.

For upgrades or channel switches, back up data and keys and check schema
compatibility first. A different running image is refused: stop explicitly,
update the CLI, inspect the new image references and restart. Volumes persist;
there is no automatic cross-channel migration or rollback guarantee. See the
[installation guide](https://developer.isonapse.com/install) before proceeding.

</details>

## License

This is proprietary software, free of charge during the public beta for
personal testing, research, and internal, non-production evaluation.
Downloading, installing, or using it means you accept the Isonapse Agent Hook
Public Beta EULA in [LICENSE.md](LICENSE.md). Production and commercial use
are not covered by the beta license — contact licensing@isonapse.com.

Attribution for the third-party code and models bundled with Isonapse lives
in `THIRD_PARTY_DEPENDENCIES.md` and `THIRD_PARTY_NOTICES.md` — included in
every release archive and printed by `isonapse licenses`.

It's a beta: expect rough edges, keep backups, and tell us what broke —
https://developer.isonapse.com/feedback
