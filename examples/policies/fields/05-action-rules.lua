-- 05-action-rules.lua — explicit PERMIT/DENY/DEFER/LEARNED + trust zones +
-- PII/secret allowlists + secret injection.
--
-- The `actions` map is the most powerful per-capability surface and the
-- place for explicit operator decisions. An applicable PERMIT for, say,
-- `tool:Bash:git` waives the later destructive veto and learned lookup for a
-- standalone `git reset --hard`, but only after the policy, rate, structural,
-- shift, and evidence gate permits it. LEARNED is the cautious alternative: it
-- skips that veto but still requires the learned gate's capability/safety scope
-- and two-of-three quorum. It supports these fields:
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
--     else's host, MUST NOT see plaintext (PII flows as `[PII_…]`
--     tokens; secrets aren't injected).
-- Data grants descend only from a literal program/server key such as
-- `tool:Bash:psql`, never from a whole-tool or wildcard key. A more-specific
-- rule replaces rather than accumulates its ancestor's grants.
--
-- Action decisions follow the documented precedence. DENY is terminal;
-- an applicable PERMIT that survives the policy, rate, and coherence filters
-- plus non-bypassable pattern/command-shape checks skips the later destructive
-- veto and learned gate; DEFER asks; LEARNED routes to the learned gate and can
-- skip only the destructive veto.

return {
  policy_version = "action-rules-v1",

  actions = {
    -- Explicit PERMIT that overrides the post-gate destructive veto. Operators
    -- declare this when they intentionally want `git reset --hard` and friends
    -- to flow once the earlier policy/rate/coherence gate is satisfied.
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
