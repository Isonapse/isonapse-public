-- 05-action-rules.lua — explicit PERMIT/DENY/DEFER/LEARNED + trust zones +
-- PII/secret allowlists + secret injection.
--
-- The `actions` map is the most powerful per-capability surface and the
-- place for explicit operator decisions. A PERMIT for, say, `tool:Bash:git`
-- means a destructive use such as `git reset --hard` no longer asks just for
-- being destructive, once your other rules and Isonapse's own checks allow
-- it; in Enforce, work Isonapse does not know yet can still ask. LEARNED is
-- the cautious alternative: in Enforce it lets the action pass only when it
-- matches work you approved before; in Normal it allows the action. It
-- supports these fields:
--
--   decision         — "PERMIT" | "DENY" | "DEFER" | "LEARNED". Required.
--                      DENY blocks; PERMIT is direct operator trust; DEFER
--                      always asks; LEARNED explicitly routes to the learned
--                      gate (and cannot unlock a catastrophic verb). A
--                      catastrophic verb (sudo, dd, mkfs, reboot, ...) stays
--                      hard-denied in Enforce unless the rule names it: a
--                      PERMIT on the standalone command, or a DEFER on each
--                      catastrophic command of a chain. A DEFER on another
--                      command of the chain, or on `tool:Bash:%compound`,
--                      does not relax it.
--   reason           — free-form text. Surfaces in the denial message and
--                      the witness chain. Operators read this when
--                      debugging "why was X blocked?"
--   defer_unless_local_bin
--                    — true on DEFER for npx, bunx or npm exec. The
--                      conditional ask is skipped only for a verified local
--                      node_modules/.bin program in a known working directory.
--   trust            — "local" | "external". Drives the PII data
--                      perimeter. Defaults to "external" for unmapped
--                      capabilities (fail-safe).
--   pii_allowlist    — regex patterns. A PII detection whose literal
--                      text matches any pattern here is allowlisted for
--                      THIS capability — the value flows through unmasked,
--                      witnessed as `pii.allowlist:<cap>`.
--   secret_allowlist — PiiEntityType strings (snake_case: "email",
--                      "db_connection_string", "credit_card", etc.). A
--                      detection of any listed TYPE is allowlisted for
--                      this capability. Coarser than pii_allowlist (any
--                      email, not a specific email).
--   allowed_secrets  — secret NAMES the capability may receive via
--                      `{{ secret.NAME }}` placeholders. Empty/absent =
--                      no secret injection (fail-closed). The secret
--                      values themselves live in ~/.isonapse/secrets/.
--   domains          — optional host globs that scope a PERMIT.
--                      A missing or non-matching host fails closed with DENY;
--                      a blocked domain still wins.
--
-- Trust zones in 30 seconds:
--   - "local" — Bash, Read, Edit, Write — runs on YOUR host, can see
--     plaintext PII (detokenised before the tool runs).
--   - "external" — WebFetch, MCP, any HTTP egress — runs on someone
--     else's host: existing `[PII_…]` vault tokens stay tokens (never
--     detokenised for it). Plaintext the agent writes into WebFetch or MCP
--     input is not scanned or tokenised, so the zone does not keep it from
--     reaching the host. Secret placeholders (`{{ secret.NAME }}`) resolve
--     only in Bash commands, outside Profile, and only for the secrets the
--     rule's `allowed_secrets` lists, in either zone.
-- Data grants descend only from a literal program/server key such as
-- `tool:Bash:psql`, never from a whole-tool or wildcard key. A more-specific
-- rule replaces rather than accumulates its ancestor's grants.
--
-- How a rule here decides, in Normal and Enforce (in Profile, rules are only
-- recorded): DENY refuses and DEFER asks. PERMIT allows, unless something
-- else refuses: a file or folder rule, a site rule when the PERMIT lists
-- `domains`, `check_action`, or Isonapse's own safety floor. A rule written
-- for exactly this action skips your blocked actions, rate and size limits;
-- a rule for a broader kind, such as `tool:Bash:git` for `git reset`, keeps
-- them. The most specific rule wins, so a PERMIT on `tool:Bash:echo` carves
-- an exception out of a DENY on `tool:Bash`. LEARNED is described above.

return {
  policy_version = "action-rules-v1",

  actions = {
    -- An allow rule for git: see what a PERMIT means at the top. Declare it
    -- only when you intend that.
    ["tool:Bash:git"] = {
      decision = "PERMIT",
      reason = "operator-trusted git workflows",
      trust = "local", -- git runs on this host; PII tokens detokenise
    },

    -- Explicit DENY that beats everything else. Even an operator
    -- accidentally adding `tool:Bash:rm` to allowed_secrets won't
    -- override this.
    ["tool:Bash:rm"] = {
      decision = "DENY",
      reason = "destructive — use trash-cli or a scoped script",
    },

    -- Package launchers can fetch and run code. The three Node launchers
    -- skip this ask only when the Hook proves the plain command is local.
    ["tool:Bash:bunx"] = {
      decision = "DEFER",
      reason = "Download-and-run launcher requires operator approval.",
      defer_unless_local_bin = true,
    },
    ["tool:Bash:npm:exec"] = {
      decision = "DEFER",
      reason = "Download-and-run launcher requires operator approval.",
      defer_unless_local_bin = true,
    },
    ["tool:Bash:npx"] = {
      decision = "DEFER",
      reason = "Download-and-run launcher requires operator approval.",
      defer_unless_local_bin = true,
    },
    ["tool:Bash:pipx:run"] = {
      decision = "DEFER",
      reason = "Download-and-run launcher requires operator approval.",
    },
    ["tool:Bash:pnpm:dlx"] = {
      decision = "DEFER",
      reason = "Download-and-run launcher requires operator approval.",
    },
    ["tool:Bash:uv:tool-run"] = {
      decision = "DEFER",
      reason = "Download-and-run launcher requires operator approval.",
    },
    ["tool:Bash:uvx"] = {
      decision = "DEFER",
      reason = "Download-and-run launcher requires operator approval.",
    },
    ["tool:Bash:yarn:dlx"] = {
      decision = "DEFER",
      reason = "Download-and-run launcher requires operator approval.",
    },

    -- Database client. PII allowlist permits a specific connection
    -- string pattern through unmasked (it would otherwise be tokenised
    -- as a db_connection_string PII entity and break the query). The
    -- regex matches `postgres://...@localhost...` and similar.
    -- secret_allowlist allows ANY email through unmasked — useful for
    -- queries against user-table dumps where the email IS the value
    -- being inspected.
    ["tool:Bash:psql"] = {
      decision = "PERMIT",
      reason = "trusted database client",
      trust = "local",
      pii_allowlist = {
        [[^postgres://[^@]+@(localhost|127\.0\.0\.1|dev-db)(:[0-9]+)?(/.*)?$]],
      },
      secret_allowlist = {
        "email",
      },
      allowed_secrets = {
        "DEV_DB_URL", -- {{ secret.DEV_DB_URL }} in commands gets injected
      },
    },

    -- A third-party MCP capability. trust = "external" (the default,
    -- explicit here for clarity) means existing `[PII_…]` tokens in its
    -- input stay tokens, never detokenised for it. Plaintext the agent
    -- writes into the call is not tokenised and reaches the server as
    -- written. No allowed_secrets: it needs no secret values.
    ["tool:mcp:third-party:lookup"] = {
      decision = "PERMIT",
      reason = "external MCP, tokens stay tokenised",
      trust = "external",
    },
  },
}
