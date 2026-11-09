-- 08-folder-rules.lua — keep agents out of folders.
--
-- A folder rule is a `blocked_file_patterns` entry that ends in `/` (or
-- `/**`). It covers the folder itself and every file below it, however the
-- agent spells the path: relative or absolute, through `.` or `..`, in
-- another letter case, or through a symbolic link that points into it. A
-- file merely named like the folder (`company-secrets.txt`,
-- `company-secrets-old/`) is outside it.
--
--   company-secrets/      — a folder of that name at any depth: at the
--                           repository root, deeper in it, or outside any
--                           repository (no working directory or `.git`
--                           entry changes that). A repository inside such a
--                           folder is covered as a whole: pick a
--                           distinctive name.
--   docs/internal/        — a folder `internal` directly in a folder `docs`,
--                           at any depth.
--   **/.ssh/              — the same as `.ssh/`: a folder of that name
--                           anywhere, the home folder's included.
--   /srv/payroll/         — an absolute folder.
--
-- One rule under `tool:Read` covers Read, NotebookRead, search roots and path
-- globs, native image paths, visible shell read operands and copy sources;
-- one under `tool:Write` covers every file write (Write, Edit, MultiEdit,
-- NotebookEdit, Codex apply_patch, and the shell writes Isonapse reads in a
-- command: redirections, tee, cp, mv, ln, link, install, rsync, touch,
-- truncate, rm, rmdir, unlink, sed -i, dd of=, rename, git mv and Git's
-- other file writes, rsync --delete, pax and cpio). Moving a folder on the
-- way to a rule's folder (`mv docs x` under `docs/internal/`) or
-- hard-linking a covered file (`ln`, `cp -l`) is refused too, by read rules
-- as well; a symbolic link resolves on every use. Removing a folder that
-- holds a rule's folder (`rm -rf docs`, `git clean -fd`) is refused, and so,
-- while a folder rule is in force, is a write whose files cannot be listed
-- in advance: switching Git branches, `git pull`, `stash`, a Git restore of
-- a folder, `cpio -p`.
-- A folder needs its trailing `/`: `company-secrets` alone is a file name.
-- The rule denies even when an action rule permits the tool. Normal and
-- Enforce deny; Profile reports what it would deny. Claude Code and pi report
-- the folder a tool runs in; on Codex, Hermes and other hosts a relative path,
-- and a shell copy of a relative folder or wildcard, is denied by these rules
-- (write the absolute path).
--
-- An unknown read (opaque interpreters, sed programs, sourced scripts,
-- dynamic operands or search metadata beyond the bounded check) is refused
-- with a Read rule in Normal/Enforce; Profile records would-deny. This can
-- refuse ordinary interpreter commands too. Codex relative reads have no
-- known tool folder; use absolute paths. Its write_stdin bypasses PreToolUse.
-- Unknown programs, changes after authorization and hard links already
-- outside the folder remain uncovered. Host confinement is the durable
-- route. On the write side, unmodelled programs (an archive extractor,
-- find -delete) remain outside the projected file writes.
return {
  policy_version = "folder-rules-v1",

  blocked_file_patterns = {
    ["tool:Read"] = {
      "company-secrets/",
      "docs/internal/",
      "**/.ssh/",
      "/srv/payroll/",
    },
    ["tool:Write"] = {
      "company-secrets/",
      "docs/internal/",
      "**/.ssh/",
      "/srv/payroll/",
      -- The hardened self-protection lines every template carries.
      "**/isonapse*",
      "**/managed-settings*",
    },
  },
}
