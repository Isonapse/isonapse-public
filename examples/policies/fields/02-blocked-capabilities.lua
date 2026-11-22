-- 02-blocked-capabilities.lua — the simplest deny.
--
-- `blocked_capabilities` is a map from AGENT pattern to a list of
-- CAPABILITY strings the gate must DENY for that agent. An exact agent
-- string matches one agent only; `"agent:*"` matches every agent whose ID
-- starts with `agent:`; `"*"` matches every agent.
--
-- Capabilities are the identifiers the gate sees on a `propose_action`
-- request:
--
--   - `tool:Bash`               — any Bash invocation
--   - `tool:Bash:git`           — git specifically (after subcommand split)
--   - `tool:Bash:rm`, `tool:Bash:sudo`, `tool:Bash:dd` — destructive defaults
--   - `tool:Read`, `tool:Write`, `tool:Edit`
--   - `tool:WebFetch`
--   - `tool:mcp:<encoded-server>:<encoded-tool>` — MCP capabilities (server-scoped)
--   - `cap:shell-exec`, `cap:file-write`, `cap:http-request` — internal capabilities
--
-- A DENY here wins over every rule except an `actions` rule that names the
-- exact capability: only such a rule can allow it again.
--
-- Try it:
--   * `agent:untrusted` proposing `cap:shell-exec` -> DENIED
--   * `agent:audit` proposing `cap:shell-exec` -> falls through (allowed)
--   * Any agent proposing `tool:Bash:sudo` -> DENIED (wildcard pattern)

return {
  policy_version = "blocked-capabilities-v1",

  blocked_capabilities = {
    -- Exact agent ID: untrusted shells are off-limits.
    ["agent:untrusted"] = {
      "cap:shell-exec",
      "cap:file-write",
    },

    -- Wildcard pattern: NO agent is allowed to escalate via sudo / dd,
    -- regardless of trust level. A broader `actions` rule, such as one on
    -- `tool:Bash`, cannot allow them again; only a rule that names
    -- `tool:Bash:sudo` itself can (see 05-action-rules.lua).
    ["*"] = {
      "tool:Bash:sudo",
      "tool:Bash:dd",
    },
  },
}
