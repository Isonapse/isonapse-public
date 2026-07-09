-- 03-runtime-rules.lua — per-action decisions with check_action(ctx).
--
-- The fields in the returned table are decided once, when the policy
-- loads. check_action runs PER ACTION, at evaluation time, so it can
-- branch on the context of the specific action: which agent, which
-- capability, which file path, which domain.
--
-- Precedence: a static DENY always wins; otherwise check_action gets the
-- last word over a static PERMIT or the default. It returns
--   { decision = "DENY", reason = "..." }  -- override to deny
--   { decision = "PERMIT" }                -- override to allow
--   nil                                    -- fall through to the static decision
--
-- The sandbox has no io, no os, no network — a policy can only decide.
-- Optional ctx fields may be nil; always guard them, as below.
--
-- Note: in Lua a chunk's `return` must be its last statement, so the
-- function is defined first and the policy table is returned at the end.

function check_action(ctx)
  -- Never edit or write under /etc, whatever the static rules say.
  if (ctx.capability == "tool:Edit" or ctx.capability == "tool:Write")
     and ctx.path and ctx.path:find("^/etc/") then
    return { decision = "DENY", reason = "edits under /etc are blocked" }
  end

  -- The same git push is trusted for one agent and denied for the rest —
  -- a per-agent decision a static rule cannot express.
  if ctx.capability == "tool:Bash:git:push" and ctx.agent_id ~= "agent:ci" then
    return { decision = "DENY", reason = "git push is restricted to the CI agent" }
  end

  -- Everything else falls through to the static decision.
  return nil
end

return {
  policy_version = "runtime-rules-v1",

  -- Static surface: read-only git commands are always fine.
  actions = {
    ["tool:Bash:git:status"] = { decision = "PERMIT" },
    ["tool:Bash:git:log"] = { decision = "PERMIT" },
  },
}
