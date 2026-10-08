# Lua Policy Examples

> **Status — Shipped:** These policies exercise the Lua surface available in
> the Isonapse Agent Hook public beta.

Two tutorial ladders covering the Isonapse Lua policy surface available in the public beta.

Every `.lua` file in this directory is **loadable as-is** by the engine — copy any one to your `policy_path` and restart the controlplane (`isonapse hook restart`) to pick it up. Each file is heavily commented; read it as a tutorial, not as terse code.

For repository-scoped governance, place a reviewed policy at
`<git-root>/.isonapse/policy.lua` instead of replacing the machine-wide
`policy_path`. Project DENY/DEFER routes and tighter constraints apply without
trust and travel with a clone. PERMIT/LEARNED widening activates only after
`isonapse hook trust <repo>` records that exact file hash; changing any byte
returns it to restrictive-only mode. See the runnable
[`../per-repo/`](../per-repo/) walkthrough for the learned-policy publication
flow.

Compound Bash evidence names the tool boundary (`tool:Bash:%compound`), while static
policy checks separately analyze its executable subjects. New compound receipts also list
those subjects in their signed description: `pwd && ls -la` records `ls` and `pwd`, and
`sh -c 'test -f x && printf ok'` records `printf`, `sh` (the wrapper) and `test`. Only
shipped program file names are listed, with a known sub-command such as `git:status`; any
other executable is counted, never named, and directories and arguments are never recorded.
A subject is a file name, as policy matches it: a script called by path (`./ls`) or found
through a changed `PATH` is recorded under its file name. `hook witness query` (including
`--json`), `hook explain` and `hook observations` show the list; receipts signed earlier
have none. A `sh -c` wrapper keeps its conservative write classification. A receipt does
not prove that every conditional command ran. A program run by a `trap` handler, or by a
here-string or heredoc that `source`, `.` or `bash /dev/stdin` reads, is listed like one
written directly; an alias, a `hash` binding or a script read from a pipe is counted as
unnamed; the command `sudo` or `ssh` runs, and a script piped into `bash`, are not
listed. Unresolved executable names are refused outside Profile; quoted data is not treated as executable
source. Historical signed evidence is unchanged.
Simple `sleep` and supported read-only `find` searches retain read classification; redirects,
delete predicates and child execution still receive their stronger checks. Recognized find predicate
and explicit-path values remain data; child-execution predicates keep compound evidence through `env -S`
and transparent wrappers.

## Public snapshot

Every `main` release publishes this README and the 14 files listed below to
`Isonapse/isonapse-public/examples/policies/` as one machine-authored snapshot. The generated
`.isonapse-source.json` beside them records the full source commit and each Git blob identity, so
the public policy files remain byte-for-byte equal to this canonical tree. Alpha and beta do not
mutate that public snapshot; edit examples here, never in the public repository.

## Ladder A — `fields/` (coverage)

One rung per shipped policy field cluster, with cumulative complexity. Reading from top to bottom teaches you the full operator-facing surface, including the half no built-in template exercises.

| File | Shows |
|---|---|
| [`01-permissive.lua`](fields/01-permissive.lua) | The minimum loadable policy. `policy_version` label. |
| [`02-blocked-capabilities.lua`](fields/02-blocked-capabilities.lua) | `blocked_capabilities` — agent-pattern wildcards, exact denials. The deterministic floor. |
| [`03-domain-rules.lua`](fields/03-domain-rules.lua) | `allowed_domains` + `blocked_domains` for HTTP egress; blocked beats allowed. |
| [`04-rate-limits.lua`](fields/04-rate-limits.lua) | Per-capability sliding-window counters (minute / hour / day). |
| [`05-action-rules.lua`](fields/05-action-rules.lua) | `actions` — PERMIT/DENY/DEFER/LEARNED, trust zones, PII allowlists, secret allowlists, secret injection. After policy/rate/coherence gating, PERMIT bypasses the later destructive veto; LEARNED routes an eligible non-catastrophic action through the quorum. |
| [`06-file-patterns.lua`](fields/06-file-patterns.lua) | `blocked_file_patterns`, `hidden_file_patterns` (OverlayFS hides), `max_payload_size`. |
| [`07-llm-and-coherence.lua`](fields/07-llm-and-coherence.lua) | `llm` budget + model allowlist; `coherence` envelopes with `direction` and `hard_cap`. |

## Ladder B — `expressiveness/` (Lua-as-DSL)

One rung per Lua pattern unavailable in JSON. The point isn't field coverage — it's showing what the file becomes once you treat it as a Lua module instead of a static schema.

| File | Shows |
|---|---|
| [`01-shared-list.lua`](expressiveness/01-shared-list.lua) | One `local PROD_DBS = {...}` shared between `blocked_capabilities`, `blocked_domains`, and `blocked_file_patterns`. Single source of truth. |
| [`02-loop-allowlist.lua`](expressiveness/02-loop-allowlist.lua) | A loop-generated allowlist: per-subcommand action rules from one list. Permits read-only git, lets the rest DEFER. |
| [`03-helper-functions.lua`](expressiveness/03-helper-functions.lua) | Local helper functions (`permit`, `deny`, `local_permit`, `rate`) — declarative DSL in ~12 lines. |
| [`04-data-driven.lua`](expressiveness/04-data-driven.lua) | A single `CAPS` data spec drives both `actions` and `coherence` in lockstep. Adding a capability is a one-row edit. |
| [`05-base-plus-overrides.lua`](expressiveness/05-base-plus-overrides.lua) | `BASE` + `OVERRIDES` tables, deep-merged at load time. The org-baseline + per-team-override pattern. |
| [`06-config-environment.lua`](expressiveness/06-config-environment.lua) | Branches `allowed_models` + budget on `isonapse.config.get("environment")`. One file ships fleet-wide; prod locks down, dev stays permissive. Keys are allowlisted in `config.toml`'s `[lua.config_allowlist]`. |
| [`07-check-action-runtime.lua`](expressiveness/07-check-action-runtime.lua) | A top-level `check_action(ctx)` function decides **per action** at evaluation time: deny edits under `/etc`, restrict `git push` to the CI agent by `ctx.agent_id`. The runtime counterpart to load-time branching. |

## What's NOT here

- **CE/EE bundles** — policy format is identical across hook / CE / EE, so the differences live in
  deployment (Postgres, OIDC, federation, signed policy packs). Those deployment bundles will be
  published with the corresponding products.

## Tests

Release validation loads every file through the real policy engine and rejects
examples without paired regression coverage.
