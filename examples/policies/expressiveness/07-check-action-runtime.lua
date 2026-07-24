-- 07-check-action-runtime.lua — per-action runtime decisions via
-- check_action(ctx).
--
-- The earlier rungs decide the policy ONCE, when the file loads
-- (table-build time). check_action runs PER ACTION, at evaluation time,
-- so it can branch on the runtime context of the *specific* action:
-- which agent, which capability, which file path, which domain.
--
-- Precedence: a static DENY always wins; otherwise check_action gets the
-- last word over a static PERMIT or the default-allow. It returns
--   { decision = "DENY", reason = "..." }  -- override to deny
--   { decision = "PERMIT" }                -- override to allow
--   nil                                    -- fall through to the static decision
-- It runs in the same sandbox as load time — no io, no os; reaching for
-- them fails closed.
--
-- ctx fields on the enforce gate path: agent_id, capability, domain,
-- and path (the edited/written file_path) are populated. payload_size
-- and metadata are filled only by callers that supply them (e.g. the
-- LLM / filesystem proxy). Always nil-guard optional fields, as below.
--
-- NOTE: in Lua a chunk's `return` must be its LAST statement, so the
-- function is defined first and the policy table is returned at the end.

function check_action(ctx)
  -- 1. Never edit/write under /etc, whatever the static rules say.
  if (ctx.capability == "tool:Edit" or ctx.capability == "tool:Write")
     and ctx.path and ctx.path:find("^/etc/") then
    return { decision = "DENY", reason = "edits under /etc are blocked at runtime" }
  end

  -- 2. The SAME git push is trusted for the CI agent, denied for others
  --    (a per-agent decision a static rule can't express).
  if ctx.capability == "tool:Bash:git:push" and ctx.agent_id ~= "agent:ci" then
    return { decision = "DENY", reason = "git push is restricted to the CI agent" }
  end

  -- 3. Everything else: fall through to the static decision / default.
  return nil
end

return {
  policy_version = "runtime-check-action-v1",
  -- The static surface still applies first; a static DENY here could not
  -- be undone by check_action above. This one just records an explicit
  -- PERMIT for read-only git status.
  actions = {
    ["tool:Bash:git:status"] = { decision = "PERMIT" },
  },
}
