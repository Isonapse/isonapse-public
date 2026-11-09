-- 06-file-patterns.lua — file-path matching, OverlayFS hides, payload caps.
--
-- Three filesystem-shaped fields:
--
-- 1) `blocked_file_patterns[<cap>]` — DENY if the path the capability
--    targets matches any pattern. A rule under `tool:Read` or
--    `cap:file-read` governs every file read (Read, NotebookRead); one
--    under `tool:Write`, `tool:Edit` or `cap:file-write` governs every
--    file write (Write, Edit, MultiEdit, NotebookEdit, Codex apply_patch,
--    and the writes Isonapse reads in a shell command). A matching pattern
--    denies even when an action rule permits the tool.
--
-- 2) `hidden_file_patterns` — FLAT list (not capability-keyed). At
--    container deploy time, the platform populates OverlayFS whiteouts
--    so matched paths return ENOENT (not EACCES) to the agent. The
--    agent literally cannot see they exist. A folder pattern (ending in
--    `/`) hides the folder itself; a name pattern hides files only.
--    Enforcement is `[proxy] fs_overlay_enabled = true` in the SAC
--    manifest. A policy that declares hidden_file_patterns without the
--    manifest switch parses without error but the deploy logs a WARN.
--
-- 3) `max_payload_size[<cap>]` — DENY if the capability's payload (the
--    body bytes about to be written, posted, etc.) exceeds the cap.
--    Useful for blocking accidental megabyte-scale writes from agents
--    that thought they were appending a line.
--
-- The matcher is intentionally NARROW (no full glob). It compares whole
-- path components, ignoring letter case, against every spelling of the
-- target (as written, with `.`/`..` resolved, and through symbolic links):
--
--   name, *.pem, credentials*, *secret*
--                    — the file name, in any folder (also after `**/`).
--   **/.kube/config  — a path ending with these folders and file name
--                      (also `**/invoices/*.lock`).
--   **/.ssh/         — a folder of that name anywhere, and everything in it.
--   secrets/         — a folder of that name at any depth, or a path
--   config/prod.yml    ending in these components (also `secrets/*.pem`:
--                      files directly in such a folder). In
--                      hidden_file_patterns: below the workspace root.
--   /etc/shadow      — the same, absolute; `/etc/ssl/private/` a folder.
--
-- A folder may also be written `dir/**`; `*` may appear only at the start
-- or the end of the final file name. A pattern of any other shape
-- (`secrets/*`, `src/**/key.pem`, `~/.ssh/`, `**/*`) never matches; the
-- engine logs it when the policy loads, and `isonapse hook policy import`
-- refuses it. See 08-folder-rules.lua for folder rules.

return {
  policy_version = "file-patterns-v1",

  blocked_file_patterns = {
    -- Reads: block secrets-ish files anywhere in the tree.
    ["cap:file-read"] = {
      "**/.env",
      "**/.env.local",
      "**/.env.*",
      "**/.aws/credentials",
      "**/*.pem",
      "**/credentials*",
    },
    -- Writes: block writes to policy / managed-settings files so an
    -- agent can't self-protection-bypass.
    ["cap:file-write"] = {
      "**/isonapse*",          -- isonapse-* binaries and configs
      "**/managed-settings*",  -- Claude Code managed settings
      "/etc/sudoers",
    },
    -- The cap:file-write rule above already governs the Hook's Write and
    -- Edit; tool-level keys add rules for those tools (each one governs
    -- every file write too).
    ["tool:Write"] = {
      "**/.env",
      "**/.env.*",
      "**/*.pem",
    },
    ["tool:Edit"] = {
      "**/.env",
      "**/.env.*",
      "**/*.pem",
    },
  },

  -- Hidden via OverlayFS whiteout. Same matcher; flat list, not keyed.
  -- Effective at container deploy time. The agent's `ls -la` does not
  -- show these paths at all.
  hidden_file_patterns = {
    "**/.ssh/",
    "**/.gnupg/",
    "**/.aws/",
    "/etc/shadow",
  },

  -- Payload size limits. A tool:Write of 5 MiB into the workspace is
  -- almost certainly an accident.
  max_payload_size = {
    ["tool:Write"] = 1048576,        -- 1 MiB
    ["cap:file-write"] = 1048576,    -- match the Write cap above
    ["cap:http-request"] = 524288,   -- 512 KiB — HTTP request bodies
  },
}
