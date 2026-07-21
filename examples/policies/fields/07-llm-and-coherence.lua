-- 07-llm-and-coherence.lua — LLM model/cost gating + coherence envelopes.
--
-- Two surfaces working together to bound agent spend and behaviour at the
-- LLM-invocation boundary.
--
-- The `llm` block applies to every `cap:llm-invoke`:
--
--   allowed_models      — string list. Empty/absent = any model allowed.
--                         Non-empty = whitelist (exact match in v1; glob
--                         is a future extension).
--   max_input_tokens    — optional cap on the deterministic per-invocation
--                         estimate (exact final canonical request bytes / 4).
--                         DENY if that estimate exceeds this value. The
--                         economic reservation independently uses the full
--                         pinned model context ceiling.
--   budget_per_task_usd — optional cumulative USD cap for a single task.
--                         DENY if `cumulative + estimated > cap`. Equality
--                         at the cap is still permitted; only crossing
--                         denies. The cumulative spend is DURABLE
--                         (SqliteDeploymentState) and survives controlplane
--                         restart end-to-end.
--
-- The `coherence` list declares envelopes around rate-window metrics. Preflight
-- evaluates the current durable projection; after a provider response, exact
-- usage reconciliation (or its durable outbox replay) publishes spend/token
-- rates. Ordinary tool-call rates advance with their committed authorization:
--
--   spend_usd_per_min       — cumulative USD spend (rolling 60s window)
--   tokens_per_min          — total input+output tokens (rolling 60s)
--   calls_per_min:tool:<X>  — per-tool call rate (one per tool)
--
-- Each declaration:
--   type      — "scalar_baseline" (only kind in v1)
--   metric    — one of the keys above
--   baseline  — the "normal" value
--   tolerance — multiplier; the threshold is baseline * tolerance
--   weight    — multiplier on the residual^2 fed to the soft aggregator
--   direction — "above" | "below" | "either".
--                "above" — fires when the metric exceeds threshold (cost
--                          / token spikes — the usual case).
--                "below" — fires when the metric falls below threshold
--                          (a stalled job that should be making progress).
--                "either"— either side fires.
--                Default: "above".
--   hard_cap  — true = fail-closed pre-PERMIT enforcement. The gate
--               denies the invocation BEFORE minting a permit token,
--               and the witness chain shows EXACTLY one decision
--               (a DENY naming the breached dimension).
--               false = soft contribution to the post-PERMIT aggregator
--                       (the envelope pattern is recorded but doesn't
--                       block a single call).
--               Default: false. Set to true on budget/token-ceiling
--               dimensions where eventual pattern detection isn't enough.

return {
  policy_version = "llm-and-coherence-v1",

  llm = {
    allowed_models = {
      "claude-sonnet-4-6",
      "gpt-4o-mini",
    },
    max_input_tokens = 16384,
    budget_per_task_usd = 2.00,
  },

  coherence = {
    -- Hard cap on per-minute spend. A sudden spike to $5/min on a $0.10
    -- baseline is almost always a runaway loop; deny immediately.
    {
      type = "scalar_baseline",
      metric = "spend_usd_per_min",
      baseline = 0.10,
      tolerance = 3.0,    -- threshold = 0.30
      weight = 1.0,
      direction = "above",
      hard_cap = true,
    },

    -- Hard cap on per-minute tokens. Same logic — runaway loop protection.
    {
      type = "scalar_baseline",
      metric = "tokens_per_min",
      baseline = 1000.0,
      tolerance = 5.0,    -- threshold = 5000
      weight = 1.0,
      direction = "above",
      hard_cap = true,
    },

    -- SOFT envelope on Bash call rate. Below-or-equal baseline is normal;
    -- 3x baseline is a sustained pattern worth surfacing post-PERMIT
    -- but not worth refusing a single call over. The aggregator picks
    -- this up over a 10-step window.
    {
      type = "scalar_baseline",
      metric = "calls_per_min:tool:Bash",
      baseline = 5.0,
      tolerance = 3.0,
      weight = 0.5,
      direction = "above",
      hard_cap = false,
    },
  },
}
