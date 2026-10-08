#!/usr/bin/env node
// Isonapse reference adapter for OpenAI Codex CLI hooks (proven on codex-cli 0.155.1).
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
// without `updatedInput` all let the tool run. Every path below therefore ends
// in an explicit answer, and everything (including the package import) runs
// inside one try/catch whose fallback is exit 2 with a non-empty stderr, which
// Codex treats as a block for PreToolUse and a withheld result for PostToolUse.
//
// Registered capability boundary (declare the profile with --input-replacement
// only): Bash, apply_patch and MCP inputs can be replaced exactly; a tool
// result can only be withheld (Codex has no exact output replacement); nothing
// can ask a human, so an `ask` is a refusal; no prompt boundary.
import {resolve} from "node:path";

// Codex `apply_patch` carries the whole patch as `command`. A single Add/Update
// target becomes canonical Write/Edit with an absolute `file_path`, so policy
// and protected-path self-protection see the file. Anything else is refused.
function mapApplyPatch(input, cwd, Refused) {
  if (Object.keys(input).length !== 1 || typeof input.command !== "string") throw new Refused("apply_patch input is not a single patch text");
  const headers = [...input.command.matchAll(/^\*\*\* (Add File|Update File|Delete File|Move to): (.*)$/gm)];
  if (headers.length !== 1) throw new Refused("apply_patch must name exactly one Add File or Update File target; split the patch");
  const [, kind, target] = headers[0];
  if (kind !== "Add File" && kind !== "Update File") throw new Refused(`apply_patch ${kind} is not mapped`);
  if (typeof cwd !== "string" || !cwd) throw new Refused("apply_patch needs the turn cwd to resolve its target");
  return {tool_name: kind === "Add File" ? "Write" : "Edit", tool_input: {file_path: resolve(cwd, target.trim()), patch: input.command}};
}

function mapTool(payload, Refused) {
  const {tool_name, tool_input, cwd} = payload;
  if (typeof tool_name !== "string" || tool_input === null || typeof tool_input !== "object" || Array.isArray(tool_input)) {
    throw new Refused("tool call without a tool name and input object");
  }
  if (tool_name === "apply_patch") return mapApplyPatch(tool_input, cwd, Refused);
  // Bash `{command}` and `mcp__<server>__<tool>` are already canonical; other
  // Codex tools pass through under their own name (capability `tool:<name>`).
  return {tool_name, tool_input};
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

// hooks.json gives SessionStart, PreToolUse and PostToolUse 60 s each. A tool
// event is ONE Hook exchange under the package's 50 s transport deadline.
// SessionStart is TWO (the version probe, then the decision), so each gets
// 25 s: the whole event ends below Codex's timeout and the adapter, not Codex,
// is the one that answers on a hung daemon. SessionEnd keeps the package
// deadline; Codex caps that event at 3 s and it is advisory either way.
const SESSION_START_EXCHANGE_MS = 25_000;
const json = value => JSON.stringify(value);
const sentence = text => String(text).trim().replace(/\.$/, "");
// Only a Hook `deny` can be the cold-start check, so only a `deny` carries the
// retry note. An identity, transport or protocol refusal never proceeds on a
// retry, and neither does an unapproved `ask` or an `unavailable` decision.
const RETRY_NOTE = " If this was the first action of the session or the first after an Isonapse restart, the cold-start check denied it and retrying the same action once proceeds when policy permits it; a policy denial stays denied.";
const retryNote = outcome => outcome.decision?.decision === "deny" ? RETRY_NOTE : "";
// The Hook gave no decision (outcome.cause): tell the operator, not only the model.
const operatorText = outcome => outcome.cause ? `Isonapse: ${outcome.reason}` : outcome.operatorMessage;
const preDeny = (reason, systemMessage) => json({hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason}, ...(systemMessage ? {systemMessage} : {})});
const postBlock = (reason, systemMessage) => json({decision: "block", reason, ...(systemMessage ? {systemMessage} : {})});

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
    if (outcome.kind === "proceed") return {stdout: "", stderr: note, exitCode: 0};
    if (outcome.kind === "rewrite") {
      try {
        const replacement = updatedInput(payload.tool_name, mapped, outcome.input, payload.cwd, Refused);
        return {stdout: json({hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: replacement}, ...(outcome.operatorMessage ? {systemMessage: outcome.operatorMessage} : {})}), stderr: note, exitCode: 0};
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        return {stdout: preDeny(`Isonapse: ${error.message}`, outcome.operatorMessage), stderr: note, exitCode: 0};
      }
    }
    return {stdout: preDeny(`Isonapse: ${sentence(outcome.reason)}.${retryNote(outcome)}`, operatorText(outcome)), stderr: note, exitCode: 0};
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
    // Codex 0.155.1 cannot replace a result exactly, only withhold it. A deny
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
  // stderr is an explicit block/withhold for every blockable Codex event.
  const kind = error?.constructor?.name ?? "Error";
  process.stderr.write(`Isonapse: no usable authorization (${kind}); the action was not authorized\n`);
  process.exitCode = 2;
}
