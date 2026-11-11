#!/usr/bin/env node
// Isonapse reference adapter for OpenAI Codex CLI hooks (codex-cli 0.159.0 or
// newer; contract-tested on the versions supported-versions.json qualifies).
//
// Codex starts ONE fresh process per hook event through `$SHELL -lc "<command>"`,
// writes one JSON event to its stdin and reads the decision from stdout and the
// exit status. Nothing survives between events except what the Isonapse Hook
// and daemon persist themselves. The transport, decoder and decision
// application come from the shipped `@isonapse/hook-adk` package; this file
// only maps Codex's vocabulary and renders Codex's wire format.
//
// Codex FAILS OPEN on every hook infrastructure failure: a crash, a timeout, a
// missing interpreter, invalid JSON, `permissionDecision:"ask"`, or an `allow`
// without `updatedInput` all let the tool run (and a PermissionRequest without
// a decision goes to Codex's own approval prompt). Every path below therefore
// ends in an explicit answer, and everything (including the package import)
// runs inside one try/catch whose fallback is exit 2 with a non-empty stderr,
// which Codex treats as a block for PreToolUse and UserPromptSubmit, a deny for
// PermissionRequest and a withheld result for PostToolUse.
//
// Registered capability boundary (declare the profile with --input-replacement
// --prompt-boundary): Bash, apply_patch and MCP inputs can be replaced exactly;
// a tool result can only be withheld (Codex has no exact output replacement);
// nothing can ask a human, so an `ask` is a refusal; a submitted prompt can be
// vetoed (UserPromptSubmit), not rewritten.
//
// PermissionRequest is Codex's OWN approval request for an escalation: a
// command outside its sandbox, network access, input to an elevated session, a
// file change or MCP call that needs approval, wider permissions. This adapter
// denies every one. It never answers allow (a hook allow is final and
// skips the person) and never abstains (no decision hands the request to
// Codex's own unreceipted prompt or reviewer). It still asks the Hook, under
// the reserved tool name below, so the control plane writes the witnessed
// DENY: it denies every host permission request in every gate mode.
import {randomUUID} from "node:crypto";
import {resolve} from "node:path";

// The canonical tool name for a host's own permission request
// (`isonapse_hook::host::HOST_PERMISSION_REQUEST_TOOL`).
const HOST_PERMISSION_REQUEST_TOOL = "HostPermissionRequest";
// The model-callable tool has a separate native approval path on 0.164.0.
const CODEX_REQUEST_PERMISSIONS_TOOL = "CodexRequestPermissions";

// Codex reads a patch with its own parser (codex-rs/apply-patch parser.rs and
// streaming_parser.rs, identical at rust-v0.155.1, 0.159.0 and 0.164.0). Its
// reading is restated here exactly, so the adapter counts the files Codex
// will touch, not the ones a simpler reading sees: lines end only at "\n"
// (one "\r" before it is dropped), and a header line is trimmed of Rust's
// Unicode whitespace (which includes U+0085 and not U+FEFF) between hunks and
// inside Add and Delete File hunks, but only at its end inside an Update File
// hunk. Returns null where Codex refuses the patch.
const RUST_WHITESPACE = new Set("\t\n\u000b\u000c\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000");
function rustTrimEnd(text) {
  let end = text.length;
  while (end > 0 && RUST_WHITESPACE.has(text[end - 1])) end--;
  return text.slice(0, end);
}
function rustTrim(text) {
  let start = 0;
  while (start < text.length && RUST_WHITESPACE.has(text[start])) start++;
  return rustTrimEnd(text.slice(start));
}
// Rust `str::lines`: only a line that ended in "\n" loses one "\r".
function rustLines(text) {
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines.map((line, index) => (index < lines.length - 1 || text.endsWith("\n")) && line.endsWith("\r") ? line.slice(0, -1) : line);
}
const PATCH_MARKERS = [["add", "*** Add File: "], ["delete", "*** Delete File: "], ["update", "*** Update File: "]];
function codexPatch(text) {
  const bounded = lines => lines.length > 0 && rustTrim(lines[0]) === "*** Begin Patch" && rustTrim(lines[lines.length - 1]) === "*** End Patch";
  let lines = rustLines(rustTrim(text));
  if (!bounded(lines)) {
    // Lenient mode: a patch wrapped in its own `<<EOF ... EOF` heredoc.
    if (!(lines.length >= 4 && ["<<EOF", "<<'EOF'", "<<\"EOF\""].includes(lines[0]) && lines[lines.length - 1].endsWith("EOF"))) return null;
    lines = lines.slice(1, -1);
    if (!bounded(lines)) return null;
  }
  const hunks = [];
  let mode = "start";
  let environment = null;
  const lastChunkEmpty = hunk => hunk.chunks.length > 0 && hunk.chunks[hunk.chunks.length - 1].old === 0 && hunk.chunks[hunk.chunks.length - 1].new === 0;
  const updateIsEmpty = () => {
    const hunk = hunks[hunks.length - 1];
    return hunk?.kind === "update" && ((hunk.chunks.length === 0 && mode === "update") || lastChunkEmpty(hunk));
  };
  // A header or `*** End Patch`: true when consumed; throws where Codex errs.
  const header = trimmed => {
    if (mode === "started" && trimmed.startsWith("*** Environment ID:")) {
      if (environment !== null || rustTrim(trimmed.slice(19)) === "") throw new Error("environment");
      environment = rustTrim(trimmed.slice(19));
      return true;
    }
    if (trimmed === "*** End Patch") {
      if (updateIsEmpty()) throw new Error("empty update");
      mode = "ended";
      return true;
    }
    for (const [kind, marker] of PATCH_MARKERS) {
      if (!trimmed.startsWith(marker)) continue;
      if (updateIsEmpty()) throw new Error("empty update");
      hunks.push({kind, path: trimmed.slice(marker.length), move: null, chunks: []});
      mode = kind;
      return true;
    }
    return false;
  };
  const line = raw => {
    const trimmed = rustTrim(raw);
    if (mode === "start") {
      if (trimmed !== "*** Begin Patch") throw new Error("begin");
      mode = "started";
    } else if (mode === "started" || mode === "delete") {
      if (!header(trimmed)) throw new Error("header");
    } else if (mode === "add") {
      if (!header(trimmed) && !raw.startsWith("+")) throw new Error("add line");
    } else if (mode === "update") {
      const updateLine = rustTrimEnd(raw);
      if (header(updateLine)) return;
      const hunk = hunks[hunks.length - 1];
      const chunk = hunk.chunks[hunk.chunks.length - 1];
      const context = updateLine === "@@" || updateLine.startsWith("@@ ");
      if (chunk?.eof) {
        if (updateLine === "") return;
        if (!context) throw new Error("context marker");
      }
      if (hunk.chunks.length === 0 && hunk.move === null && updateLine.startsWith("*** Move to: ")) {
        hunk.move = updateLine.slice(13);
      } else if (context) {
        if (lastChunkEmpty(hunk)) throw new Error("empty chunk");
        hunk.chunks.push({old: 0, new: 0, eof: false});
      } else if (updateLine === "*** End of File") {
        if (lastChunkEmpty(hunk)) throw new Error("empty chunk");
        if (chunk) chunk.eof = true;
      } else if (raw === "" || raw.startsWith(" ") || raw.startsWith("+") || raw.startsWith("-")) {
        if (hunk.chunks.length === 0) hunk.chunks.push({old: 0, new: 0, eof: false});
        const last = hunk.chunks[hunk.chunks.length - 1];
        if (!raw.startsWith("+")) last.old++;
        if (!raw.startsWith("-")) last.new++;
      } else {
        throw new Error("update line");
      }
    } else if (trimmed !== "") {
      throw new Error("after end");
    }
  };
  try {
    // The streaming parser: every "\n"-ended line loses one more "\r"; the
    // last line is `*** End Patch` itself or is read as it stands.
    const pieces = lines.join("\n").split("\n");
    const tail = pieces.pop();
    for (const piece of pieces) line(piece.endsWith("\r") ? piece.slice(0, -1) : piece);
    if (tail !== "") {
      if (rustTrim(tail) === "*** End Patch") {
        if (updateIsEmpty()) throw new Error("empty update");
        mode = "ended";
      } else {
        line(tail);
      }
    }
    if (mode !== "ended") return null;
  } catch {
    return null;
  }
  return {hunks: hunks.map(({kind, path, move}) => ({kind, path, move})), environment};
}
// A deliberately loose reading of the same text: lines end at every line
// break, and whitespace, format and control characters are ignored around a
// header. A line it takes for a file header that Codex's reading does not
// count makes the two readings disagree, and the patch is refused.
const LOOSE_IGNORED = "[\\s\\u0000-\\u001f\\u007f-\\u009f\\u180e\\u200b-\\u200d\\u2060\\ufeff]*";
const LOOSE_BREAK = /\r\n|[\n\r\u000b\u000c\u001c-\u001e\u0085\u2028\u2029]/;
const LOOSE_HEADER = new RegExp(`^${LOOSE_IGNORED}\\*\\*\\*${LOOSE_IGNORED}(?:add file|delete file|update file|move to)${LOOSE_IGNORED}:`, "i");
const looseHeaders = text => text.split(LOOSE_BREAK).filter(piece => LOOSE_HEADER.test(piece)).length;
// A target that starts with whitespace or holds a control character or line
// separator could be placed differently by Codex and by Node; it is refused.
const PLAIN_TARGET = /^[^\s\u0000-\u001f\u007f-\u009f\u180e\u200b-\u200d\u2060\ufeff][^\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]*$/;

// Codex `apply_patch` carries the whole patch as `command`. A single Add/Update
// target, read exactly as Codex reads it, becomes canonical Write/Edit with an
// absolute `file_path`, so policy and protected-path self-protection see the
// file. Anything else is refused before the Hook, including a patch whose
// header count a looser reading of the same text disagrees with.
function mapApplyPatch(input, cwd, Refused) {
  if (Object.keys(input).length !== 1 || typeof input.command !== "string") throw new Refused("apply_patch input is not a single patch text");
  const patch = codexPatch(input.command);
  if (patch === null) throw new Refused("apply_patch is not a patch Codex can apply; send one well-formed patch");
  const targets = patch.hunks.length + patch.hunks.filter(hunk => hunk.move !== null).length;
  if (looseHeaders(input.command) !== targets) throw new Refused("apply_patch has a line that can be read as another file header; start every header line at its beginning and end every line with a plain newline");
  if (patch.environment !== null) throw new Refused("apply_patch names an environment, which is not mapped");
  if (targets !== 1) throw new Refused("apply_patch must name exactly one Add File or Update File target; split the patch");
  const [{kind, path}] = patch.hunks;
  if (kind === "delete") throw new Refused("apply_patch Delete File is not mapped");
  if (!PLAIN_TARGET.test(path)) throw new Refused("apply_patch target starts with whitespace or holds a control character or line separator");
  if (typeof cwd !== "string" || !cwd) throw new Refused("apply_patch needs the turn cwd to resolve its target");
  return {tool_name: kind === "add" ? "Write" : "Edit", tool_input: {file_path: resolve(cwd, path), patch: input.command}};
}

function mapTool(payload, Refused) {
  const {tool_name, tool_input, cwd} = payload;
  if (typeof tool_name !== "string" || tool_input === null || typeof tool_input !== "object" || Array.isArray(tool_input)) {
    throw new Refused("tool call without a tool name and input object");
  }
  if (tool_name === HOST_PERMISSION_REQUEST_TOOL) throw new Refused(`${HOST_PERMISSION_REQUEST_TOOL} is reserved for Codex's own permission requests`);
  if (tool_name === CODEX_REQUEST_PERMISSIONS_TOOL) throw new Refused(`${CODEX_REQUEST_PERMISSIONS_TOOL} is reserved for Codex's request_permissions tool`);
  if (tool_name === "request_permissions") return {tool_name: CODEX_REQUEST_PERMISSIONS_TOOL, tool_input};
  if (tool_name === "apply_patch") return mapApplyPatch(tool_input, cwd, Refused);
  // Bash `{command}` and `mcp__<server>__<tool>` are already canonical; other
  // Codex tools pass through under their own name (capability `tool:<name>`).
  return {tool_name, tool_input};
}

// A Codex PermissionRequest becomes one pre-action of the reserved host
// permission request tool, carrying the native tool name and input unchanged
// so the receipt binds exactly what Codex asked for. Codex sends no
// `tool_use_id` with it, so the action gets a fresh one of its own: nothing
// correlates it with a later result, because a denied request never runs.
function mapPermissionRequest(payload, Refused) {
  const {tool_name, tool_input} = payload;
  if (typeof tool_name !== "string" || !tool_name || tool_input === null || typeof tool_input !== "object" || Array.isArray(tool_input)) {
    throw new Refused("permission request without a tool name and input object");
  }
  return {hook_event_name: "PreToolUse", tool_name: HOST_PERMISSION_REQUEST_TOOL, tool_input: {tool_name, tool_input}, tool_use_id: `permission-request-${randomUUID()}`};
}

// Render an authorized replacement in the shape Codex can apply exactly, or refuse.
function updatedInput(tool, mapped, selected, cwd, Refused) {
  if (tool === "Bash") {
    if (Object.keys(selected).length === 1 && typeof selected.command === "string") return selected;
    throw new Refused("rewritten Bash input is not a single command string");
  }
  if (tool.startsWith("mcp__")) return selected;
  if (tool === "apply_patch") {
    // Codex replaces the patch text; it is exact only if the rewritten patch
    // still maps to the same canonical tool and the same absolute file.
    const keys = Object.keys(selected).sort();
    if (keys.join(",") === "file_path,patch" && typeof selected.patch === "string") {
      let again;
      try {
        again = mapApplyPatch({command: selected.patch}, cwd, Refused);
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
      }
      if (again && again.tool_name === mapped.tool_name && again.tool_input.file_path === selected.file_path && selected.file_path === mapped.tool_input.file_path) return {command: selected.patch};
    }
    throw new Refused("rewritten apply_patch input cannot be applied exactly");
  }
  throw new Refused(`this host cannot apply a rewritten input for ${tool}`);
}

// hooks.json gives SessionStart, UserPromptSubmit, PreToolUse,
// PermissionRequest and PostToolUse 60 s each. A prompt, tool or permission
// event is ONE Hook exchange under the package's 50 s transport deadline.
// SessionStart is TWO (the version probe, then the decision), so each gets
// 25 s: the whole event ends below Codex's timeout and the adapter, not Codex,
// is the one that answers on a hung daemon. SessionEnd keeps the package
// deadline; Codex caps that event at 3 s and it is advisory either way.
const SESSION_START_EXCHANGE_MS = 25_000;
// The longest native tool name a permission-request denial repeats.
const MAX_NAMED_TOOL = 128;
// Set only after the package import inside the fail-closed try/catch. A plain
// JSON.stringify would either reject bigint or round a numeric replacement.
let json = () => { throw new Error("Lossless ADK serializer unavailable"); };
const sentence = text => String(text).trim().replace(/\.$/, "");
// ADK v1 has no structured receipt field on a deny. Match the Hook renderer's
// complete durable gate-authorization Evidence line, including its typed action
// and sequence, so an unreceipted local deny never promises a cold-start retry.
const DURABLE_GATE_DENIAL = /^Evidence: durable gate authorization DENY acknowledged by control plane; action [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}; sequence [1-9][0-9]*\. Inspect recent records with `isonapse hook witness query --limit 100` and verify with `isonapse hook witness verify`\.$/m;
// Only the cold-start check itself (Enforce mode) passes on a retry. Its DENY
// keeps the fixed cause and renders this class; any other DENY, a folder rule
// or any policy rule, is refused the same way again, so it gets no note.
const COLD_START_DENIAL = /^Reason \[learned-cold-start\]: /m;
const RETRY_NOTE = " This was the session's first action, or the first since Isonapse restarted, and the cold-start check denied it because Codex cannot ask; retrying the same action once proceeds when policy permits it.";
const retryNote = outcome => outcome.decision?.decision === "deny" && DURABLE_GATE_DENIAL.test(outcome.decision.reason) && COLD_START_DENIAL.test(outcome.decision.reason) ? RETRY_NOTE : "";
// The Hook gave no decision (outcome.cause): tell the operator, not only the model.
const operatorText = outcome => outcome.cause ? `Isonapse: ${outcome.reason}` : outcome.operatorMessage;
const preDeny = (reason, systemMessage) => json({hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason}, ...(systemMessage ? {systemMessage} : {})});
const postBlock = (reason, systemMessage) => json({decision: "block", reason, ...(systemMessage ? {systemMessage} : {})});
// UserPromptSubmit takes the same top-level block; any other top-level key
// would make Codex drop the answer and send the prompt.
const promptBlock = postBlock;
// PermissionRequest: `behavior:"deny"` with its message. Codex rejects
// `continue`, `stopReason`, `suppressOutput`, `updatedInput`,
// `updatedPermissions` and `interrupt` here, and a rejected answer is no
// decision: the request would go to Codex's own prompt. Never add them.
const permissionDeny = (message, systemMessage) => json({hookSpecificOutput: {hookEventName: "PermissionRequest", decision: {behavior: "deny", message}}, ...(systemMessage ? {systemMessage} : {})});
// The Hook did not deny a host permission request (an Isonapse older than this
// adapter): this adapter never approves one, so it is denied anyway.
const NOT_DENIED = "Isonapse: Codex's permission request is denied; this adapter never approves one, and the Hook did not deny it, so no Isonapse denial receipt names it (check that Isonapse and this adapter come from the same release)";

/** One Codex hook response: `{stdout, stderr, exitCode}`. */
async function handle(adk, hookCommand, client, payload) {
  const {Refused} = adk;
  const name = payload.hook_event_name;
  if (name === "SessionStart" || name === "SessionEnd") {
    // SessionEnd has a 1-3 s budget in Codex: no version probe there. The
    // SessionStart probe and decision each run under SESSION_START_EXCHANGE_MS.
    const outcome = await hookCommand(client, payload, {checkVersion: name === "SessionStart"});
    const notes = [outcome.operatorMessage, outcome.kind === "refuse" ? `Isonapse: ${outcome.reason}` : null].filter(Boolean);
    return {stdout: "", stderr: notes.map(note => `isonapse-codex: ${note}\n`).join(""), exitCode: 0};
  }
  if (name === "PreToolUse") {
    let mapped;
    try {
      mapped = mapTool(payload, Refused);
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      return {stdout: preDeny(`Isonapse: ${error.message}`), stderr: "", exitCode: 0};
    }
    // No `approve`: Codex has no hook-reachable approval surface, so `ask` refuses.
    const outcome = await hookCommand(client, {...payload, ...mapped});
    const note = outcome.operatorMessage ? `isonapse-codex: ${outcome.operatorMessage}\n` : "";
    const permissionTool = mapped.tool_name === CODEX_REQUEST_PERMISSIONS_TOOL;
    if (permissionTool && outcome.kind !== "refuse") {
      const reason = "Isonapse: Codex's request_permissions tool is denied before execution. This Hook did not deny it, so no Isonapse denial receipt names it. Check that Isonapse and this adapter come from the same release.";
      return {stdout: preDeny(reason, reason), stderr: `${note}isonapse-codex: ${reason}\n`, exitCode: 0};
    }
    const context = outcome.decision?.additionalContext;
    const additional = context ? {additionalContext: context} : {};
    if (outcome.kind === "proceed") return {stdout: context ? json({hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow", ...additional}, ...(outcome.operatorMessage ? {systemMessage: outcome.operatorMessage} : {})}) : "", stderr: note, exitCode: 0};
    if (outcome.kind === "rewrite") {
      try {
        const replacement = updatedInput(payload.tool_name, mapped, outcome.input, payload.cwd, Refused);
        return {stdout: json({hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: replacement, ...additional}, ...(outcome.operatorMessage ? {systemMessage: outcome.operatorMessage} : {})}), stderr: note, exitCode: 0};
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        return {stdout: preDeny(`Isonapse: ${error.message}`, outcome.operatorMessage), stderr: note, exitCode: 0};
      }
    }
    return {stdout: preDeny(`Isonapse: ${sentence(outcome.reason)}.${permissionTool ? "" : retryNote(outcome)}`, operatorText(outcome)), stderr: note, exitCode: 0};
  }
  if (name === "PermissionRequest") {
    // Every path answers deny: a refused mapping, any Hook outcome, and (in the
    // outer catch) a crash. No retry note: asking again is denied the same way.
    let mapped;
    try {
      mapped = mapPermissionRequest(payload, Refused);
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      return {stdout: permissionDeny(`Isonapse: ${error.message}`), stderr: "", exitCode: 0};
    }
    const asked = payload.tool_name.slice(0, MAX_NAMED_TOOL);
    const outcome = await hookCommand(client, {...payload, ...mapped});
    const note = outcome.operatorMessage ? `isonapse-codex: ${outcome.operatorMessage}\n` : "";
    if (outcome.kind !== "refuse") return {stdout: permissionDeny(NOT_DENIED, NOT_DENIED), stderr: `${note}isonapse-codex: ${NOT_DENIED}\n`, exitCode: 0};
    return {stdout: permissionDeny(`Isonapse: Codex's permission request for ${asked} is denied: ${sentence(outcome.reason)}.`, operatorText(outcome)), stderr: note, exitCode: 0};
  }
  if (name === "UserPromptSubmit") {
    // The prompt boundary: a Hook `deny` vetoes the prompt (a block); a prompt
    // is never rewritten. A Hook `allow` lets it proceed, with any warning the
    // Hook attaches: that includes the Hook's own posture for a prompt it
    // cannot check (its control plane unreachable, the PII check
    // unavailable), which it answers as an allow with a warning. When the
    // adapter gets NO usable decision (identity, transport or protocol; or an
    // `unavailable`), the prompt is blocked: no usable authorization is a
    // refusal (PROTOCOL.md rule 3), as for every other event. `codex exec`
    // shows nothing for a blocked prompt (codex-cli 0.164.0).
    if (typeof payload.prompt !== "string") return {stdout: promptBlock("Isonapse: prompt event without prompt text"), stderr: "", exitCode: 0};
    const request = {};
    for (const field of ["session_id", "cwd", "hook_event_name", "prompt", "agent_id", "agent_type"]) {
      if (field in payload) request[field] = payload[field];
    }
    const unchecked = cause => {
      const reason = `Isonapse: ${sentence(cause)}. The prompt was not checked, so it was not sent.`;
      return {stdout: promptBlock(reason), stderr: `isonapse-codex: ${reason}\n`, exitCode: 0};
    };
    let decision;
    try {
      decision = await client.decide("user-prompt-submit", request, {boundary: "lifecycle"});
    } catch (error) {
      if (!(error instanceof adk.Unavailable || error instanceof Refused)) throw error;
      return unchecked(error.message);
    }
    const note = decision.operatorMessage ? `isonapse-codex: ${decision.operatorMessage}\n` : "";
    if (decision.decision === "allow") {
      // A warning (for example PII the host cannot rewrite) reaches the user as
      // `systemMessage`; the prompt itself proceeds unchanged.
      return {stdout: decision.operatorMessage ? json({systemMessage: decision.operatorMessage}) : "", stderr: note, exitCode: 0};
    }
    if (decision.decision === "unavailable") return unchecked(decision.reason);
    return {stdout: promptBlock(`Isonapse: ${sentence(decision.reason)}.`, decision.operatorMessage), stderr: note, exitCode: 0};
  }
  if (name === "PostToolUse") {
    let mapped;
    try {
      mapped = mapTool(payload, Refused);
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      return {stdout: postBlock(`Isonapse: tool result withheld (${error.message})`), stderr: "", exitCode: 0};
    }
    const outcome = await hookCommand(client, {...payload, ...mapped});
    const note = outcome.operatorMessage ? `isonapse-codex: ${outcome.operatorMessage}\n` : "";
    if (outcome.kind === "deliver") return {stdout: "", stderr: note, exitCode: 0};
    // Codex cannot replace a result exactly, only withhold it. A deny
    // that carries a replacement also carries the Hook's reason: keep it.
    const why = outcome.kind === "replace"
      ? `Isonapse: tool result withheld (an exact replacement is required and this host cannot apply it)${outcome.decision?.reason ? `: ${sentence(outcome.decision.reason)}` : ""}`
      : `Isonapse: ${outcome.reason}`;
    return {stdout: postBlock(why, operatorText(outcome)), stderr: note, exitCode: 0};
  }
  throw new Refused(`unsupported Codex hook event ${typeof name === "string" ? name : "(missing)"}`);
}

try {
  const {parseArgs} = await import("node:util");
  // The pin is either inline (--hook-sha256) or read on every event from an
  // owner-only pin file (--hook-sha256-file) that `isonapse hook adk-pin`
  // rewrites after an upgrade, so this hook definition never has to change.
  const {values} = parseArgs({options: {hook: {type: "string"}, "hook-sha256": {type: "string"}, "hook-sha256-file": {type: "string"}, host: {type: "string"}}, strict: true});
  for (const setting of ["hook", "host"]) if (!values[setting]) throw new Error(`missing operator setting --${setting}`);
  if (!values["hook-sha256"] === !values["hook-sha256-file"]) throw new Error("exactly one of --hook-sha256 and --hook-sha256-file is required");
  const adk = await import("@isonapse/hook-adk");
  if (typeof adk.stringifyJson !== "function") throw new Error("Lossless ADK serializer unavailable");
  json = adk.stringifyJson;
  const {hookCommand, readHostEvent} = await import("@isonapse/hook-adk/hook-command");
  const payload = await readHostEvent(process.stdin);
  const timeoutMs = payload.hook_event_name === "SessionStart" ? SESSION_START_EXCHANGE_MS : undefined;
  const installed = values["hook-sha256-file"]
    ? adk.InstalledHook.fromPinFile(values.hook, values["hook-sha256-file"])
    : new adk.InstalledHook(values.hook, values["hook-sha256"]);
  const client = new adk.Client(installed, values.host, {timeoutMs});
  const response = await handle(adk, hookCommand, client, payload);
  if (response.stderr) process.stderr.write(response.stderr);
  process.stdout.write(response.stdout);
  process.exitCode = response.exitCode;
} catch (error) {
  // Codex fails OPEN on a crashed or silent hook. Exit 2 with a non-empty
  // stderr is an explicit block, deny or withhold for every event that can
  // carry one (PreToolUse, UserPromptSubmit, PermissionRequest, PostToolUse).
  const kind = error?.constructor?.name ?? "Error";
  process.stderr.write(`Isonapse: no usable authorization (${kind}); the action was not authorized\n`);
  process.exitCode = 2;
}
