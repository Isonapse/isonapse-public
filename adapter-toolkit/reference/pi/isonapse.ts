/**
 * Isonapse governance extension for the pi coding agent (https://pi.dev).
 *
 * pi runs tools with the permissions of the account that started it and, in
 * its own security guide's words, "does not ask for approval before every tool
 * call"; this supplies a governed decision at pi's action boundary.
 *
 * Glue only: hands each event to `isonapse-pi-adapter`, which speaks Host
 * Adapter Protocol v1 to the hook binary, then installs the result into pi's
 * own execution path. Policy, tool names and event names live in the daemon
 * and the `pi` HostProfile.
 *
 * There is no fail-open switch, nothing parses `reason`, and `input` replaces
 * the contents of `event.input` in place — the same object pi executes.
 *
 * The rewrite and confirmation guarantees hold only for the pi releases the
 * installing Isonapse release qualified. On any other running pi, or when the
 * running version cannot be read or verified, every tool call is refused
 * here, before the adapter is asked: an unreceipted host-local refusal, not a
 * gate decision.
 */

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionCompactEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

// `isonapse hook init --host pi` replaces this exact absolute fail-closed
// placeholder with the adapter from the installed hook cohort. Runtime env
// and PATH never select governance bytes.
const INSTALLED_ADAPTER_BIN = "/__ISONAPSE_PI_ADAPTER_PATH_MUST_BE_RENDERED__/isonapse-pi-adapter";
const MAX_ADAPTER_BYTES = 1024 * 1024;
// This is deliberately not shortened by ISONAPSE_ADAPTER_TIMEOUT_MS. That
// variable belongs to the Rust adapter's 50s inner deadline; the outer pi
// wrapper keeps a five-second margin for process-group teardown and refusal.
const ADAPTER_TIMEOUT_MS = 55_000;
const SAFE_RESULT = "Isonapse withheld this tool result because governance did not return a usable decision.";
// `isonapse hook init --host pi` replaces this exactly-once placeholder string
// with the JSON array of pi releases the installing Isonapse release
// qualified. An unrendered copy, such as the public reference file, keeps a
// string here, never an array: its qualified set is empty and every tool call
// is refused.
const RENDERED_QUALIFIED_PI_VERSIONS: unknown = "__ISONAPSE_PI_QUALIFIED_VERSIONS_MUST_BE_RENDERED__";
// The npm package whose exact `@<version>` pins the code pi runs.
const PI_NPM_PACKAGE = "@earendil-works/pi-coding-agent";
const LOCAL_REFUSAL = "isonapse: refused locally before any gate decision, so no receipt exists for this call";

type Instruction = {
	block?: boolean;
	ask?: boolean;
	reason?: string;
	warning?: string;
	input?: Record<string, unknown>;
	output?: unknown;
};

function sessionId(ctx: ExtensionContext): string | undefined {
	const id: unknown = ctx?.sessionManager?.getSessionId?.();
	return typeof id === "string" && id.trim() ? id : undefined;
}

function workingDirectory(ctx: ExtensionContext): string | undefined {
	const supplied: unknown = (ctx as ExtensionContext & { cwd?: unknown })?.cwd;
	if (typeof supplied === "string" && supplied.trim()) return supplied;
	try {
		return process.cwd();
	} catch {
		return undefined;
	}
}

const missingSession = (): Instruction & { block: true; reason: string } => ({
	block: true,
	reason: "isonapse: pi did not provide a stable non-empty session id; refusing rather than sharing global fallback state",
});

const plainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []) => {
	const allowed = new Set([...required, ...optional]);
	const keys = Object.keys(value);
	return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
};

function validatedInstruction(event: string, value: unknown, processFailed: boolean): Instruction | undefined {
	if (!plainObject(value) || typeof value.block !== "boolean" || value.block !== processFailed) return undefined;

	if (value.block) {
		return hasExactKeys(value, ["block", "reason"]) && typeof value.reason === "string" && value.reason.length > 0
			? (value as Instruction)
			: undefined;
	}
	if (value.warning !== undefined && (typeof value.warning !== "string" || value.warning.length === 0)) return undefined;

	switch (event) {
		case "tool_call": {
			if (!hasExactKeys(value, ["block"], ["ask", "reason", "warning", "input"])) return undefined;
			if (value.input !== undefined && !plainObject(value.input)) return undefined;
			if (value.ask === undefined) {
				return value.reason === undefined ? (value as Instruction) : undefined;
			}
			return value.ask === true && typeof value.reason === "string" && value.reason.length > 0
				? (value as Instruction)
				: undefined;
		}
		case "tool_result":
			return hasExactKeys(value, ["block"], ["output", "warning"]) &&
				(value.output === undefined || Array.isArray(value.output))
				? (value as Instruction)
				: undefined;
		case "input":
		case "session_start":
		case "session_shutdown":
		case "agent_end":
		case "session_compact":
			return hasExactKeys(value, ["block"], ["warning"]) ? (value as Instruction) : undefined;
		default:
			return undefined;
	}
}

import { replaceExecutableInput } from "@isonapse/hook-adk/input";

/**
 * Ask the adapter for an instruction. The adapter pairs exit 0 with an allow
 * (`block: false`) and a non-zero exit with a refusal (`block: true`); an
 * answer outside that pairing, a non-object answer, a missing or non-boolean
 * `block`, or a non-object `input` returns a blocking instruction. pi does
 * not fail open on a throwing extension.
 */
export const _internals = {
	adapterBin(): string {
		return INSTALLED_ADAPTER_BIN;
	},
	ask(event: string, body: Record<string, unknown>): Instruction {
		const encoded = JSON.stringify(body);
		if (Buffer.byteLength(encoded, "utf8") > MAX_ADAPTER_BYTES) {
			return { block: true, reason: "isonapse: host event exceeded the adapter protocol ceiling" };
		}
		const proc = spawnSync(_internals.adapterBin(), [event], {
			input: encoded,
			encoding: "utf8",
			timeout: ADAPTER_TIMEOUT_MS,
			maxBuffer: MAX_ADAPTER_BYTES + 1,
		});
		try {
			const parsed: unknown = JSON.parse(proc.stdout);
			const instruction = validatedInstruction(event, parsed, proc.status !== 0);
			if (instruction) return instruction;
		} catch {
			/* fall through to the refusal below */
		}
		return { block: true, reason: `isonapse: no usable decision (${(proc.stderr || "").trim() || "no output"})` };
	},
	/** The qualified pi set as `isonapse hook init --host pi` rendered it. */
	renderedQualifiedVersions(): unknown {
		return RENDERED_QUALIFIED_PI_VERSIONS;
	},
	/**
	 * The running pi's own `VERSION`. pi's extension loader resolves this
	 * module to the pi that is running: a jiti alias in unbundled Node builds,
	 * a virtual module in the bundled 1.x CLI. The import is dynamic and
	 * guarded because a failed static import would stop this extension from
	 * loading at all, leaving pi ungoverned; a failed dynamic import instead
	 * refuses every tool call.
	 */
	async piRuntimeVersion(): Promise<unknown> {
		const runtime = (await import("@earendil-works/pi-coding-agent")) as unknown as { VERSION?: unknown };
		return runtime.VERSION;
	},
	/**
	 * pi's `PI_PACKAGE_DIR`. When it is set, pi reads the version it reports,
	 * including `VERSION`, from that directory's `package.json` instead of its
	 * own. Empty counts as unset, as in pi.
	 */
	piPackageDirOverride(): string | undefined {
		const value = process.env.PI_PACKAGE_DIR;
		return typeof value === "string" && value.length > 0 ? value : undefined;
	},
	/** The script pi was started from, which locates its own package directory. */
	piEntryScript(): string | undefined {
		const entry = process.argv[1];
		return typeof entry === "string" && entry.length > 0 ? entry : undefined;
	},
};

// Indirection so tests can stub the subprocess. Called through the object so
// a stub is observed by the code under test.
const ask = (event: string, body: Record<string, unknown>) => _internals.ask(event, body);

/** The rendered qualified set; anything but a non-empty array of non-empty strings is the empty set. */
function qualifiedPiVersions(): string[] {
	const rendered = _internals.renderedQualifiedVersions();
	if (!Array.isArray(rendered) || rendered.length === 0) return [];
	return rendered.every((version) => typeof version === "string" && version.length > 0) ? [...rendered] : [];
}

function canonicalPath(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/**
 * The directory pi reads for `PI_PACKAGE_DIR`, canonical: pi expands a
 * leading `~` and a `file://` URL, and resolves a relative path against its
 * working directory.
 */
function packageDirOverrideTarget(value: string): string | undefined {
	let expanded = value;
	if (value === "~") expanded = homedir();
	else if (value.startsWith("~/")) expanded = join(homedir(), value.slice(2));
	else if (value.startsWith("file://")) {
		try {
			expanded = fileURLToPath(value);
		} catch {
			return undefined;
		}
	}
	return canonicalPath(resolve(expanded));
}

/**
 * The package directory the running pi finds for itself without
 * `PI_PACKAGE_DIR` (pi's `findNodePackageDir`): from the real path of the
 * script pi was started from, the nearest ancestor holding a `package.json`,
 * or its parent when that ancestor is a `dist` directory whose parent holds
 * one too.
 */
function runningPiPackageDir(): string | undefined {
	const entry = _internals.piEntryScript();
	const script = entry === undefined ? undefined : canonicalPath(entry);
	if (script === undefined) return undefined;
	let directory = dirname(script);
	while (directory !== dirname(directory)) {
		if (existsSync(join(directory, "package.json"))) {
			const parent = dirname(directory);
			return basename(directory) === "dist" && existsSync(join(parent, "package.json")) ? parent : directory;
		}
		directory = dirname(directory);
	}
	return undefined;
}

/**
 * Why every tool call must be refused on the running pi, or undefined when it
 * is one of the qualified releases. Exact equality with pi's `VERSION`: no
 * prefix, range, or semver comparison. A `PI_PACKAGE_DIR` other than the
 * running pi's own package directory makes `VERSION` unverifiable.
 */
async function piRuntimeRefusal(): Promise<string | undefined> {
	const qualified = qualifiedPiVersions();
	if (qualified.length === 0) {
		return `${LOCAL_REFUSAL}: this copy of the Isonapse pi extension carries no qualified pi release set, so it was not installed by \`isonapse hook init --host pi\`; install it with that command.`;
	}
	const listed = qualified.join(", ");
	const newest = qualified[qualified.length - 1];
	const remedy = `Install a qualified pi release with \`npm install -g --ignore-scripts ${PI_NPM_PACKAGE}@${newest}\`, confirm \`pi --version\` prints ${newest}, then restart pi.`;
	const override = _internals.piPackageDirOverride();
	if (override !== undefined) {
		const running = runningPiPackageDir();
		if (running === undefined || packageDirOverrideTarget(override) !== running) {
			return `${LOCAL_REFUSAL}: PI_PACKAGE_DIR is set to ${JSON.stringify(override.slice(0, 400))}, which is not the running pi's own package directory, so the version pi reports cannot be verified against the pi releases this Isonapse release qualified (${listed}): pi reads that version from the package.json in PI_PACKAGE_DIR. Unset PI_PACKAGE_DIR, or set it to the running pi's own package directory${running === undefined ? "" : ` (${JSON.stringify(running)})`}, then restart pi.`;
		}
	}
	let version: unknown;
	try {
		version = await _internals.piRuntimeVersion();
	} catch {
		version = undefined;
	}
	if (typeof version !== "string" || version.length === 0) {
		return `${LOCAL_REFUSAL}: the running pi's version could not be determined, so it cannot be matched against the pi releases this Isonapse release qualified (${listed}). ${remedy}`;
	}
	if (!qualified.includes(version)) {
		return `${LOCAL_REFUSAL}: the running pi reports version ${JSON.stringify(version.slice(0, 80))}, which is not one of the pi releases this Isonapse release qualified (${listed}). ${remedy}`;
	}
	return undefined;
}

// pi's own event name, never another host's: the `pi` HostProfile owns event
// translation.
const payload = (event: string, sid: string, ctx: ExtensionContext, extra: Record<string, unknown> = {}) => ({
	session_id: sid,
	hook_event_name: event,
	...extra,
	cwd: workingDirectory(ctx),
});

function showWarning(ctx: ExtensionContext, instruction: Instruction): void {
	if (!instruction.warning) return;
	try {
		ctx?.ui?.notify?.(instruction.warning, "warning");
	} catch {
		/* A broken notification surface must not change the typed decision. */
	}
}

function showError(ctx: ExtensionContext, message: string): void {
	try {
		ctx?.ui?.notify?.(message, "error");
	} catch {
		/* Host UI failure must never reverse an already-typed block. */
	}
}

export default function (pi: ExtensionAPI) {
	// Checked once per load: the running pi cannot change under a loaded
	// extension. Never rejects; a failure is itself a refusal.
	const runtimeRefusal: Promise<string | undefined> = Promise.resolve()
		.then(piRuntimeRefusal)
		.catch(() => `${LOCAL_REFUSAL}: the running pi could not be checked against the qualified pi releases.`);
	const notifiedSessions = new Set<string>();
	const notifyRuntimeRefusal = (ctx: ExtensionContext, refusal: string) => {
		const key = sessionId(ctx) ?? "";
		if (notifiedSessions.has(key)) return;
		notifiedSessions.add(key);
		showError(ctx, refusal);
	};

	pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
		try {
			// Before the adapter is asked, in every gate mode: an unqualified or
			// unreadable pi runtime cannot honour the rewrite and confirmation
			// guarantees a gate decision would rely on.
			const refusal = await runtimeRefusal;
			if (refusal !== undefined) {
				notifyRuntimeRefusal(ctx, refusal);
				return { block: true, reason: refusal };
			}
			const sid = sessionId(ctx);
			if (!sid) return missingSession();
			const d = ask(
				"tool_call",
				payload("tool_call", sid, ctx, {
					tool_name: event.toolName,
					tool_input: event.input,
					tool_use_id: event.toolCallId,
				}),
			);
			showWarning(ctx, d);
			if (d.block) return { block: true, reason: d.reason || "blocked by isonapse policy" };
			if (d.ask) {
				if (typeof ctx?.ui?.confirm !== "function") {
					return { block: true, reason: "isonapse: review required but pi exposed no confirmation UI" };
				}
				let approved = false;
				try {
					approved = await ctx.ui.confirm("Isonapse review required", d.reason || "Approve this governed tool call?");
				} catch {
					return { block: true, reason: "isonapse: pi confirmation failed; action was not approved" };
				}
				if (!approved) return { block: true, reason: d.reason || "Isonapse review was declined" };
			}
			// In place, on the object pi is about to execute. Replacement, not
			// merge: a key the effective input dropped must not survive.
			if (d.input) {
				const replacementError = replaceExecutableInput(event.input, d.input);
				if (replacementError) return { block: true, reason: replacementError };
			}
		} catch {
			return { block: true, reason: "isonapse: governance failed before authorizing this tool call" };
		}
	});

	pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext) => {
		try {
			const sid = sessionId(ctx);
			if (!sid) {
				const reason = missingSession().reason || "isonapse: missing session id";
				return { content: [{ type: "text", text: reason }], isError: true };
			}
			const d = ask(
				"tool_result",
				payload("tool_result", sid, ctx, {
					tool_name: event.toolName,
					tool_input: event.input,
					tool_use_id: event.toolCallId,
					tool_response: event.content,
				}),
			);
			showWarning(ctx, d);
			// A post-action refusal cannot un-run the tool; it replaces what the model
			// is shown.
			if (d.block || d.ask) return { content: [{ type: "text", text: d.reason || "blocked by isonapse policy" }], isError: true };
			if (d.output !== undefined) {
				if (!Array.isArray(d.output)) {
					return {
						content: [{ type: "text", text: "isonapse: invalid non-array result replacement" }],
						isError: true,
					};
				}
				return { content: d.output as ToolResultEvent["content"] };
			}
			// pi keeps a tool's `structuredContent` unless a handler replaces
			// `content`, and codemode scripts receive `structuredContent` instead
			// of the text this handler had scanned. Replacing `content` with
			// itself makes pi drop it; pi keeps `isError` and `details`.
			if (event.structuredContent !== undefined) return { content: event.content };
		} catch {
			return { content: [{ type: "text", text: SAFE_RESULT }], isError: true };
		}
	});

	pi.on("input", (event: InputEvent, ctx: ExtensionContext) => {
		try {
			const sid = sessionId(ctx);
			const d = sid ? ask("input", payload("input", sid, ctx, {
				prompt: event.text,
				context_input_source: event.source,
				context_streaming_behavior: event.streamingBehavior,
			})) : missingSession();
			showWarning(ctx, d);
			// A blocked prompt is consumed, never delivered to the agent; the
			// reason surfaces through pi's own notification channel. When the
			// daemon is unreachable the hook passes the prompt with a warning
			// instead of blocking — a user's own words are not a side effect.
			if (d.block) {
				showError(ctx, d.reason || "blocked by isonapse policy");
				return { action: "handled" };
			}
		} catch {
			showError(ctx, "isonapse: governance could not inspect this prompt");
		}
	});

	// These observers carry only explicit host prose. They never flatten tool
	// results or thinking blocks into an apparent user request or success claim.
	pi.on("agent_end", (event: AgentEndEvent, ctx: ExtensionContext) => {
		try {
			const sid = sessionId(ctx);
			if (!sid) return;
			const last = [...event.messages].reverse().find((message) => message.role === "assistant");
			if (!last || last.role !== "assistant") return;
			const text = last.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
			if (!text || Buffer.byteLength(text, "utf8") > 16_384) return;
			showWarning(ctx, ask("agent_end", payload("agent_end", sid, ctx, { last_assistant_message: text })));
		} catch {
			showError(ctx, "isonapse: completion context could not be observed");
		}
	});

	pi.on("session_compact", (event: SessionCompactEvent, ctx: ExtensionContext) => {
		try {
			const sid = sessionId(ctx);
			if (!sid) return;
			const summary = event.compactionEntry.summary;
			if (Buffer.byteLength(summary, "utf8") > 16_384) return;
			showWarning(ctx, ask("session_compact", payload("session_compact", sid, ctx, {
				compact_summary: summary,
				context_message_id: event.compactionEntry.id,
				trigger: event.reason,
			})));
		} catch {
			showError(ctx, "isonapse: compaction context could not be observed");
		}
	});

	pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
		try {
			const sid = sessionId(ctx);
			if (!sid) return ctx?.ui?.notify?.(missingSession().reason, "error");
			const d = ask("session_start", payload("session_start", sid, ctx));
			showWarning(ctx, d);
			if (d.block || d.ask) ctx?.ui?.notify?.(d.reason || "isonapse: session start was not receipted", "error");
			// Say at session start, not only at the first tool call, that this
			// pi runtime will have every tool call refused.
			const refusal = await runtimeRefusal;
			if (refusal !== undefined) notifyRuntimeRefusal(ctx, refusal);
		} catch {
			try {
				ctx?.ui?.notify?.("isonapse: session start was not receipted", "error");
			} catch {
				/* lifecycle remains non-blocking */
			}
		}
	});

	pi.on("session_shutdown", (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
		try {
			const sid = sessionId(ctx);
			if (!sid) return ctx?.ui?.notify?.(missingSession().reason, "error");
			const d = ask("session_shutdown", payload("session_shutdown", sid, ctx));
			showWarning(ctx, d);
			if (d.block || d.ask) ctx?.ui?.notify?.(d.reason || "isonapse: session end was not receipted", "error");
		} catch {
			try {
				ctx?.ui?.notify?.("isonapse: session end was not receipted", "error");
			} catch {
				/* lifecycle remains non-blocking */
			}
		}
	});
}

export const _test = { payload };
