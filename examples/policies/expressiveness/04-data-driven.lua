-- 04-data-driven.lua — one data spec, multiple policy fields derived.
--
-- A single table-of-tables describes EACH capability the policy cares
-- about: its decision, its reason, AND the coherence envelope that
-- backs it. Two helper functions walk the spec to derive `actions` and
-- `coherence` in lockstep, so adding a new capability is a single row
-- edit and the two fields can never drift out of sync.
--
-- This is the shape a real-world policy converges on once it has more
-- than ~10 capabilities. The data spec doubles as documentation — an
-- operator reading the file sees the WHOLE governance posture in one
-- table.

-- Each row: cap (string), decision ("PERMIT"|"DENY"), reason, and a
-- coherence baseline + tolerance on the per-tool call rate.
local CAPS = {
  { cap = "tool:Read",         decision = "PERMIT", reason = "read-only",     baseline = 60.0, tolerance = 3.0 },
  { cap = "tool:Edit",         decision = "PERMIT", reason = "scoped writes", baseline = 20.0, tolerance = 3.0 },
  { cap = "tool:Write",        decision = "PERMIT", reason = "scoped writes", baseline = 10.0, tolerance = 3.0 },
  { cap = "tool:Bash:git",     decision = "PERMIT", reason = "git workflows", baseline = 20.0, tolerance = 4.0 },
  { cap = "tool:Bash:rm",      decision = "DENY",   reason = "destructive",   baseline =  0.0, tolerance = 1.0 },
  { cap = "tool:Bash:sudo",    decision = "DENY",   reason = "escalation",    baseline =  0.0, tolerance = 1.0 },
}

local function derive_actions(spec)
  local actions = {}
  for _, row in ipairs(spec) do
    actions[row.cap] = {
      decision = row.decision,
      reason   = row.reason,
    }
  end
  return actions
end

local function derive_coherence(spec)
  local coherence = {}
  for _, row in ipairs(spec) do
    -- Only emit envelopes for capabilities we PERMIT — there's no point
    -- envelope-modeling a never-firing path. (DENYs short-circuit before
    -- any envelope is checked.)
    if row.decision == "PERMIT" then
      coherence[#coherence + 1] = {
        type      = "scalar_baseline",
        metric    = "calls_per_min:" .. row.cap,
        baseline  = row.baseline,
        tolerance = row.tolerance,
        weight    = 1.0,
        direction = "above",
        hard_cap  = false,  -- soft contribution to the aggregator
      }
    end
  end
  return coherence
end

return {
  policy_version = "data-driven-v1",
  actions   = derive_actions(CAPS),
  coherence = derive_coherence(CAPS),
}
