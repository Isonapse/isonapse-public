# Isonapse Host Adapter Toolkit

> **Status — Public beta:** Current Agent Hook release archives ship the Hook
> ADK inside their signed bytes. Its APIs and the Codex reference can still
> change between releases.

Build a small host integration that routes native agent events through the
installed `isonapse-hook` binary, applies the exact typed result, and fails
closed when no usable authorization exists. This Apache-2.0 toolkit is glue;
the hook binary, daemon, policy engine, and receipt machinery are not included.

## Where the toolkit is

Current Agent Hook release archives carry the toolkit as one file,
`isonapse-adapter-toolkit.tar.gz`. It is covered by the release archive's
signature and checksum; it is not signed separately, and Isonapse itself never
runs it.

| Installation | Toolkit path |
| --- | --- |
| Homebrew | `$(brew --prefix)/share/isonapse/isonapse-adapter-toolkit.tar.gz` |
| `install.sh` | next to the installed binaries, by default `~/.isonapse/bin/isonapse-adapter-toolkit.tar.gz` |

The release bundle contains:

- `TOOLKIT.json`: the ADK version, the source commit and the SHA-256 of every
  other file in the bundle;
- this README, `PROTOCOL.md`, `INTEGRATION.md`, `HOST-PROFILES.md`, `LICENSE`
  and `NOTICE`;
- `reference/codex/`: the OpenAI Codex CLI reference adapter, its `hooks.json`
  template, `supported-versions.json` and its README;
- `typescript/isonapse-hook-adk-1.1.0.tgz`: the packed TypeScript/JavaScript
  package;
- `python/isonapse_hook_adk-1.1.0-py3-none-any.whl`: the Python wheel.

The source tree has more: the package sources and tests, `conformance/`,
`template/`, and the Hermes and pi references. The main release also publishes
that source tree to the public repository's `adapter-toolkit/` directory.

If you install an older release that predates the toolkit, delete the
`isonapse-adapter-toolkit.tar.gz` left beside the binaries: it belongs to the
newer release.

## Quick start

Install the packages from the bundle. Both installs work offline: nothing is
fetched from a registry, and neither package is published to npm or PyPI.

```sh
TOOLKIT="$(brew --prefix)/share/isonapse/isonapse-adapter-toolkit.tar.gz"   # install.sh: ~/.isonapse/bin/isonapse-adapter-toolkit.tar.gz
mkdir -p ~/my-adapter && cd ~/my-adapter && tar -xzf "$TOOLKIT"
python3 -m venv .venv
.venv/bin/python -m pip install --no-index --no-deps \
  ./isonapse-adapter-toolkit/python/isonapse_hook_adk-1.1.0-py3-none-any.whl
.venv/bin/python -m isonapse_hook_adk init my_agent.py
# Or, in your Node project:
npm install --offline --no-audit --no-fund --ignore-scripts \
  ./isonapse-adapter-toolkit/typescript/isonapse-hook-adk-1.1.0.tgz
npx --no-install isonapse-hook-adk init my-agent.mjs
```

npm and pip each install a copy, so the adapter never depends on files inside a
Homebrew keg. The package READMEs describe APIs, version/pin checks and
callback boundaries. Follow `HOST-PROFILES.md` to register the reviewed
runtime. Starters use native file callbacks, not a synthetic shell executor.

## Validate an adapter (source tree)

These tools are in the source tree, not in the release bundle.

`python3 conformance/packages.py` builds and installs both language packages in
disposable environments, tests those installed bytes, and checks that starter
initialization cannot overwrite an existing host. Use `--language python` or
`--language typescript` for a focused run. Python's exact build backend is
fetched when not cached; Node 22+ and npm are needed for the TypeScript path.
Run the package tests with
`PYTHONPATH=python/src python3 -m unittest discover -s python/tests -v` and
`node --test typescript/tests/*.test.js`. These are fast protocol and
native-callback tests; they do not prove that a live daemon persisted an
authorization.

The older language-neutral fixture runner remains useful for custom adapters:

```sh
cp -R template my-host-adapter
python3 conformance/run.py --adapter my-host-adapter/adapter.py
```

The scaffold declares all three capabilities. For a narrower host, repeat
`--capability` only for capabilities it can prove, use `--no-capabilities` for
none (omitting both means all three), and use `--expected-host <id>` when the
host already has a registered id. The suite selects each fixture's explicit
incapable-host expectation; it never skips a case.

The runner uses only the Python standard library. It creates a stub
`isonapse-hook`, drives the adapter executable through all canonical fixtures,
checks the actual command/result effect rather than trusting adapter output,
and finishes with an anti-theater mutation proof. No Isonapse source checkout
or live daemon is needed.

The legacy scaffold is a synthetic fixture executor, not production host glue.
Do not copy its transport into a new adapter: use the packages instead.
`PROTOCOL.md` is normative; `INTEGRATION.md` explains receipt checks.

## Hook-command hosts

Not every host loads a plugin. OpenAI Codex CLI and other Claude-shaped
`hooks.json` runtimes start a fresh adapter process for every native event,
hand it one JSON event on stdin and read a host-shaped answer from stdout and
the exit status. The in-process `Runtime` starter (pre, effect and post inside
one call) does not fit that shape. Both packages carry a `hook-command` helper
for it (`@isonapse/hook-adk/hook-command`, `isonapse_hook_adk.hook_command`):
strict stdin decoding, one decision at the right boundary through the installed
Hook, and a typed outcome to branch on. The adapter renders the host's wire
format itself. `reference/codex/` is the maintained example. Codex is a
cooperative, fail-open host, and the reference is proven only with the
codex-cli versions listed in `reference/codex/supported-versions.json`. Read its
README for the capability boundary, the install, upgrade and uninstall steps,
and what the model sees.

## Before you register a host

- **Fail-open host?** If the host runs the tool when a hook crashes, times
  out, cannot be started or answers in an unsupported shape, the adapter must
  answer every path explicitly (an explicit deny on every failure it can see,
  including a failed package import), keep its own deadline below the host's,
  and keep interpreter and adapter paths stable. Document that the host is
  cooperative and fail-open; the protocol cannot bind a host that ignores a
  dead hook.
- **Registrable interpreter?** The pinned executable must be the path the
  kernel reports for the running process, owner-controlled and not under a
  group- or world-writable directory. Framework and Homebrew Python and
  Homebrew Node on macOS fail that check; `HOST-PROFILES.md` gives the working
  recipes.
- **Only provable capabilities.** Declare `--input-replacement`,
  `--output-replacement` and `--approval` only where the host applies the
  exact object or opens a real approval surface. The daemon converts an
  undeliverable input rewrite or ask into a witnessed deny; an undeliverable
  output replacement is the adapter's job to withhold.
- **Events the registered id accepts.** Session start/end and pre/post-tool
  only (plus the prompt boundary when declared). `stop` and every other native
  event fail closed for a registered id.
- **Operator terminal.** Register from a normal terminal with OS
  authentication, never from inside the agent you are governing.
- **Adapter location.** Keep the adapter directory, including its
  `node_modules` or virtual environment, out of any workspace an agent can
  write. The registration pins the interpreter and the adapter script, not the
  modules the script imports.
- **Upgrade plan.** The Hook's SHA-256 changes with every Isonapse release.
  Until the pin is updated, the ADK refuses every event with a `pin mismatch`
  cause. Read the pin from the pin file that `isonapse hook adk-pin` writes
  after verifying the Hook against its signed release manifest: after the
  usual `isonapse hook restart`, an upgrade then needs only
  `isonapse hook adk-pin`, and the host's hook definition never changes.
  With an inline pin in the definition, every upgrade edits it, and a host
  that keys its trust on the definition, such as Codex, needs a re-trust each
  time (observed on codex-cli 0.155.1, not a maintained test).

## Contents of the source tree

- `PROTOCOL.md`: Host Adapter Protocol v1 wire and safety contract.
- `INTEGRATION.md`: implementation, installation, receipt, and support guide.
- `HOST-PROFILES.md`: operator admission, compatibility and contribution route.
- `python/` and `typescript/`: installable libraries, native starter generators,
  callback APIs and executable package tests.
- `conformance/`: standalone runner plus the same 15 golden fixtures used by Isonapse.
- `template/`: executable Python scaffold that is green before customization.
- `reference/hermes/` and `reference/pi/`: shipped host-side glue for comparison.
- `reference/codex/`: the OpenAI Codex CLI hook-command reference adapter,
  its `hooks.json` template, its supported-versions list and README
  (registered host; input replacement only).

Report toolkit bugs and propose host profiles in the public repository's issue
tracker. Never attach tokens, API keys, secrets, private prompts, or unredacted
receipts. Security vulnerabilities belong at `security@isonapse.com`, not in a
public issue.

## License and naming

Toolkit files are Apache-2.0; see `LICENSE` and `NOTICE`. The proprietary
Isonapse binaries remain under their distributed license. You may say
“compatible with Isonapse Host Adapter Protocol v1.” Do not call a community
adapter “Isonapse”, imply endorsement, or use Isonapse logos without permission.
