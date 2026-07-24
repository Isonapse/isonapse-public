-- 06-config-environment.lua — branch on the deployment environment at
-- LOAD time via the mediated `isonapse.config` API.
--
-- A single policy file ships to the whole fleet, but the rules differ by
-- environment: production locks the model list and tightens the budget;
-- development stays permissive so engineers aren't slowed down. JSON
-- can't read its surroundings, and the Lua sandbox deliberately nils
-- `os`/`io` are unavailable, so a policy CANNOT `os.getenv("ENVIRONMENT")`.
--
-- Instead, the operator allowlists keys in `config.toml`:
--
--   [lua.config_allowlist]
--   keys = ["environment", "region", "fleet_tier"]
--
-- and the trusted controlplane resolves ONLY those keys, exposing them
-- through `isonapse.config.get`. A key that isn't allowlisted returns
-- `nil` — indistinguishable from an allowlisted-but-unset key, so the
-- surface never leaks which keys exist. Every key read at load time is
-- recorded in the witness chain (`policy.config_reads`).

local env = isonapse.config.get("environment") or "dev"

-- Production: a single audited model, a tight per-task budget.
-- Anything else (dev / staging / unset): the broader default set.
local allowed_models
local budget_usd
if env == "prod" then
  allowed_models = { "claude-sonnet-4-6" }
  budget_usd = 2.00
else
  allowed_models = {
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
    "gpt-4o-mini",
  }
  budget_usd = 10.00
end

return {
  policy_version = "fleet-by-environment:" .. env,
  llm = {
    allowed_models = allowed_models,
    budget_per_task_usd = budget_usd,
  },
}
