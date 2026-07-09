-- 02-domain-allowlist.lua — allowlist network egress for web fetches.
--
-- Two fields, evaluated in this order:
--
--   1. blocked_domains[<capability>] — a match here denies immediately.
--      Blocked beats allowed.
--   2. allowed_domains[<capability>] — if the list is non-empty for a
--      capability, the target must match at least one entry, otherwise it
--      is denied. An absent or empty allowlist means "no allowlist
--      restriction for this capability".
--
-- Patterns: `example.com` matches exactly; `*.example.com` matches any
-- subdomain (and `example.com` itself). Anything else is a literal match.

return {
  policy_version = "domain-allowlist-v1",

  -- Denied even though *.example.com is allowed below — blocked wins.
  blocked_domains = {
    ["tool:WebFetch"] = {
      "tracking.example.com",
    },
  },

  -- Non-empty list = allowlist mode: only these domains may be fetched.
  allowed_domains = {
    ["tool:WebFetch"] = {
      "*.example.com",
      "docs.rs",
      "developer.mozilla.org",
    },
  },
}
