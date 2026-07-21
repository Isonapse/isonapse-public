-- 05-action-rules.lua — explicit PERMIT/DENY + trust zones + PII/secret
-- allowlists + secret injection.
--
-- The `actions` map is the most powerful per-capability surface and the
-- ONE place that can override the destructive veto (an explicit PERMIT
-- for, say, `tool:Bash:git` waves through `git reset --hard` despite the
-- shell registry classifying it as destructive). It carries five
-- sub-fields:
--
--   decision         — "PERMIT" | "DENY". Required. Mirrors ActionDecision.
--   reason           — free-form text. Surfaces in the denial message and
--                      the witness chain. Operators read this when
--                      debugging "why was X blocked?"
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
--
-- Trust zones in 30 seconds:
--   - "local" — Bash, Read, Edit, Write — runs on YOUR host, can see
--     plaintext PII (detokenised before the tool runs).
--   - "external" — WebFetch, MCP, any HTTP egress — runs on someone
--     else's host, MUST NOT see plaintext (PII flows as `[PII_…]`
--     tokens; secrets aren't injected).
--
-- Action rules short-circuit the rest of policy evaluation. DENY here
-- beats every other layer; PERMIT here beats the destructive veto.

return {
  policy_version = "action-rules-v1",

  actions = {
    -- Explicit PERMIT that overrides the destructive veto. Operators
    -- declare this when they intentionally want `git reset --hard` and
    -- friends to flow without the "ask the human" gate.
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
        "^postgres://[^@]+@(localhost|127%.0%.0%.1|dev%-db).*$",
      },
      secret_allowlist = {
        "email",
      },
      allowed_secrets = {
        "DEV_DB_URL", -- {{ secret.DEV_DB_URL }} in commands gets injected
      },
    },

    -- A third-party MCP capability. trust = "external" (the default,
    -- explicit here for clarity) means tokens flow through unchanged —
    -- the remote server only ever sees `[PII_…]` placeholders, never
    -- raw values. No allowed_secrets — never inject local secret values
    -- into external requests.
    ["tool:mcp:third-party:lookup"] = {
      decision = "PERMIT",
      reason = "external MCP, tokens stay tokenised",
      trust = "external",
    },
  },
}
