-- 03-domain-rules.lua — domain allowlist + blocklist for HTTP egress.
--
-- Two fields, evaluated in this order:
--
--   1. `blocked_domains[<cap>]`  — if the target domain matches any
--      pattern here, DENY immediately. Blocked beats allowed.
--   2. `allowed_domains[<cap>]`  — if the list is non-empty for this
--      capability, the target must match at least one entry, otherwise
--      DENY. An empty/absent allowlist means "no allowlist restriction
--      for this capability" — the action falls through.
--
-- Glob shapes the matcher understands:
--
--   - `example.com`           — exact match on the domain
--   - `*.example.com`         — any subdomain (and `example.com` itself)
--   - Anything else is a literal exact-match.
--
-- A common pattern (security-audit) is to set `["*"]` as the allowlist
-- meaning "no domain is allowed anywhere" then carve exceptions per
-- capability.
--
-- Try it:
--   * tool:WebFetch -> https://api.example.com/x   -> PERMIT (matches allowlist)
--   * tool:WebFetch -> https://docs.example.com/y  -> PERMIT (*.example.com)
--   * tool:WebFetch -> https://evil.example.com/z  -> DENY (blocklist hits first)
--   * tool:WebFetch -> https://other.com/w         -> DENY (allowlist excludes)

return {
  policy_version = "domain-rules-v1",

  -- Blocked first. Even though *.example.com is allowed below, the
  -- evil.example.com subdomain is denied because blocked > allowed.
  blocked_domains = {
    ["tool:WebFetch"] = {
      "evil.example.com",
      "*.malware.test",
    },
  },

  -- Then allowed. Non-empty list = whitelist mode for this capability.
  -- A capability with NO entry here is unrestricted (use blocked_domains
  -- alone, or combine with blocked_capabilities for a hard floor).
  allowed_domains = {
    ["tool:WebFetch"] = {
      "*.example.com",
      "api.internal",
      "docs.internal",
    },
  },
}
