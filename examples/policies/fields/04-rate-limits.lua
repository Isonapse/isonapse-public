-- 04-rate-limits.lua — per-capability sliding-window counters.
--
-- `rate_limits[<cap>]` declares a counter on the (agent, policy key) pair.
-- The key governs its whole capability subtree, so `tool:Bash` is ONE
-- shared budget across every sub-command (`tool:Bash:git`,
-- `tool:Bash:curl`, …) rather than a separate budget for each. Where a
-- broad and a narrow key both govern a call, both budgets are charged —
-- a narrow key tightens the broad one instead of escaping it.
--
-- Three independent sliding windows are tracked; you can use any
-- combination of the three.
--
--   per_minute  — required.  Resets after 60s of wall clock.
--   per_hour    — optional. Resets after 3600s.
--   per_day     — optional. Resets after 86400s.
--
-- Windows are independent: hitting any cap denies the call until that
-- window expires. The denial reason names which window was breached.
--
-- The engine attaches a `warnings` field to a PERMIT result when a
-- counter has 5 or fewer invocations remaining in the minute window —
-- visible in the dashboard / hook output, useful for spotting a
-- runaway-loop before it hits the wall.
--
-- These are HARD counters (deterministic), not energy-graded checks.
-- They live in memory in the controlplane process; a controlplane
-- restart resets the per-minute window. (Spend/budget counters are
-- different — those persist to disk via SqliteDeploymentState; see
-- 07-llm-and-coherence.lua.)
--
-- Try it:
--   * 30 successive tool:Bash invocations -> all PERMIT
--   * the 31st -> DENY: "Rate limit exceeded for tool:Bash: 30/30 per minute"
--   * wait 60s, the counter rolls -> next call PERMIT again

return {
  policy_version = "rate-limits-v1",

  rate_limits = {
    -- Shell calls: 30/min is generous for an interactive agent, but the
    -- 200/hour cap stops a runaway loop from eating the day's budget in
    -- 7 minutes.
    ["tool:Bash"] = {
      per_minute = 30,
      per_hour = 200,
      per_day = 1000,
    },

    -- Web egress is the most expensive externally-visible action; lower
    -- limit. Operators often pair this with allowed_domains (see
    -- 03-domain-rules.lua) so the rate limit applies only to traffic
    -- that's already been authorized.
    ["tool:WebFetch"] = {
      per_minute = 10,
      per_hour = 60,
    },

    -- LLM invocations: tight per-minute (sustained-rate protection) but
    -- no daily cap — that's what the LLM budget field handles
    -- (see 07-llm-and-coherence.lua), persistently and across restarts.
    ["cap:llm-invoke"] = {
      per_minute = 20,
    },
  },
}
