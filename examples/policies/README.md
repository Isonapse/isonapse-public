# Lua Policy Examples

> **Status — Shipped:** These policies exercise the Lua surface available in
> the Isonapse Agent Hook public beta.

Two tutorial ladders covering the Isonapse Lua policy surface that landed in #36.

Every `.lua` file in this directory is **loadable as-is** by the engine — copy any one to your `policy_path` and restart the controlplane (`isonapse hook stop && isonapse hook start`) to pick it up. Each file is heavily commented; read it as a tutorial, not as terse code.

## Ladder A — `fields/` (coverage)

One rung per shipped `PolicyDefinition` field cluster, cumulative complexity. Reading from top to bottom teaches you the full operator-facing surface, including the half no built-in template exercises.

| File | Shows |
|---|---|
| [`01-permissive.lua`](fields/01-permissive.lua) | The minimum loadable policy. `policy_version` label. |
| [`02-blocked-capabilities.lua`](fields/02-blocked-capabilities.lua) | `blocked_capabilities` — agent-pattern wildcards, exact denials. The deterministic floor. |
| [`03-domain-rules.lua`](fields/03-domain-rules.lua) | `allowed_domains` + `blocked_domains` for HTTP egress; blocked beats allowed. |
| [`04-rate-limits.lua`](fields/04-rate-limits.lua) | Per-capability sliding-window counters (minute / hour / day). |
| [`05-action-rules.lua`](fields/05-action-rules.lua) | `actions` — PERMIT/DENY, trust zones, PII allowlists, secret allowlists, secret injection. Overrides the destructive veto. |
| [`06-file-patterns.lua`](fields/06-file-patterns.lua) | `blocked_file_patterns`, `hidden_file_patterns` (OverlayFS hides), `max_payload_size`. |
| [`07-llm-and-coherence.lua`](fields/07-llm-and-coherence.lua) | `llm` budget + model allowlist; `coherence` envelopes with `direction` and `hard_cap`. |

## Ladder B — `expressiveness/` (Lua-as-DSL)

One rung per Lua pattern unavailable in JSON. The point isn't field coverage — it's showing what the file becomes once you treat it as a Lua module instead of a static schema.

| File | Shows |
|---|---|
| [`01-shared-list.lua`](expressiveness/01-shared-list.lua) | One `local PROD_DBS = {...}` shared between `blocked_capabilities`, `blocked_domains`, and `blocked_file_patterns`. Single source of truth. |
| [`02-loop-allowlist.lua`](expressiveness/02-loop-allowlist.lua) | The ticket example: a for-loop generates per-subcommand action rules from a list. Permits read-only git, lets the rest DEFER. |
| [`03-helper-functions.lua`](expressiveness/03-helper-functions.lua) | Local helper functions (`permit`, `deny`, `local_permit`, `rate`) — declarative DSL in ~12 lines. |
| [`04-data-driven.lua`](expressiveness/04-data-driven.lua) | A single `CAPS` data spec drives both `actions` and `coherence` in lockstep. Adding a capability is a one-row edit. |
| [`05-base-plus-overrides.lua`](expressiveness/05-base-plus-overrides.lua) | `BASE` + `OVERRIDES` tables, deep-merged at load time. The org-baseline + per-team-override pattern. |
| [`06-config-environment.lua`](expressiveness/06-config-environment.lua) | Branches `allowed_models` + budget on `isonapse.config.get("environment")`. One file ships fleet-wide; prod locks down, dev stays permissive. Keys are allowlisted in `config.toml`'s `[lua.config_allowlist]`. |
| [`07-check-action-runtime.lua`](expressiveness/07-check-action-runtime.lua) | A top-level `check_action(ctx)` function decides **per action** at evaluation time: deny edits under `/etc`, restrict `git push` to the CI agent by `ctx.agent_id`. The runtime counterpart to load-time branching. |

## What's NOT here

- **CE/EE bundles** — policy format is identical across hook / CE / EE, so the differences live in deployment (Postgres, OIDC, federation, signed policy packs). CE/EE example bundles get authored once #127 (signed policy packs) ships; tracked at #143.

## Tests

Every file is exercised by
`code-ref:crates/isonapse-tests/tests/policy_examples.rs#every_example_file_loads_via_the_engine`.
Run with:

```
cargo test -p isonapse-tests --test policy_examples
```

A meta-test walks `examples/policies/**/*.lua` and rejects any file that doesn't have a paired assertion, so new examples can't be added without a regression bar.
