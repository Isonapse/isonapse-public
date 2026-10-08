import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {open, lstat, readlink} from "node:fs/promises";

export const MAX_BYTES = 1024 * 1024;
const MAX_DIAGNOSTICS = 64 * 1024;
const MAX_TIMEOUT = 50_000;
const MAX_BINARY = 1024 * 1024 * 1024;
const MAX_LINKS = 8;
const boundaries = new WeakMap();
/**
 * No usable decision. `code` names the cause class when the Hook could not be
 * consulted: `hook-identity:<cause>`, `hook-transport` or `hook-protocol`.
 */
export class Unavailable extends Error {
  constructor(message, options) {
    super(message);
    if (typeof options?.code === "string") this.code = options.code;
  }
}
export class Refused extends Error {}
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
function jsonValue(value,depth=0) {
  if (depth > 256) throw Error();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {if (!Number.isFinite(value)) throw Error(); return value;}
  if (typeof value === "string") {if (!value.isWellFormed()) throw Error(); return value;}
  if (!object(value) && !Array.isArray(value)) throw Error();
  const array=Array.isArray(value), prototype=Object.getPrototypeOf(value);
  if (!array && prototype !== Object.prototype && prototype !== null) throw Error();
  const result=array ? [] : {};
  const keys=Reflect.ownKeys(value).filter(key=>!(array && key === "length"));
  if (array && keys.length !== value.length) throw Error();
  for (const key of keys) {
    if (typeof key !== "string" || !key.isWellFormed()) throw Error();
    if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || +key >= value.length)) throw Error();
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw Error();
    Object.defineProperty(result,key,{value:jsonValue(descriptor.value,depth+1), enumerable:true,writable:true,configurable:true});
  }
  return result;
}

export function snapshot(value) {
  try {
    const encoded=JSON.stringify(jsonValue(value));
    if (Buffer.byteLength(encoded)>MAX_BYTES) throw Error();
    return JSON.parse(encoded);
  } catch {throw new Unavailable("Host event is not bounded plain JSON");}
}

// JSON.parse validates syntax first; this second bounded pass rejects duplicate
// keys rather than permitting a last-key-wins decision or rewrite ambiguity.
function uniqueKeys(text) {
  const stack = [];
  for (let i=0;i<text.length;i++) {
    const char = text[i];
    if (char === '"') {
      const start = i++;
      while (i<text.length && text[i] !== '"') { if (text[i] === "\\") i++; i++; }
      const top = stack.at(-1);
      if (top?.keys && top.key) {
        const key = JSON.parse(text.slice(start,i+1));
        if (top.keys.has(key)) throw Error();
        top.keys.add(key); top.key=false;
      }
    } else if (char === "{" || char === "[") {
      if (stack.length >= 256) throw Error();
      stack.push(char === "{" ? {keys:new Set(),key:true} : {});
    } else if (char === "}" || char === "]") stack.pop();
    else if (char === "," && stack.at(-1)?.keys) stack.at(-1).key=true;
  }
}

// One native host event delivered as bytes (a hook-command host's stdin). The
// same bounded, duplicate-key-rejecting rules as a Hook response: a host event
// with an ambiguous key must not become an unambiguous tool input.
export function decodeHostEvent(raw) {
  try {
    if (Buffer.byteLength(raw) > MAX_BYTES) throw Error();
    const text = new TextDecoder("utf-8", {fatal:true}).decode(Buffer.from(raw));
    const value = JSON.parse(text);
    if (!object(value)) throw Error();
    jsonValue(value);
    uniqueKeys(text);
    return value;
  } catch {
    throw new Unavailable("Host event is not bounded plain JSON");
  }
}

export function decode(raw, boundary) {
  try {
    if (Buffer.byteLength(raw) > MAX_BYTES || !["pre","post","lifecycle"].includes(boundary)) throw Error();
    const text = new TextDecoder("utf-8", {fatal:true}).decode(Buffer.from(raw));
    const value = JSON.parse(text);
    jsonValue(value);
    uniqueKeys(text);
    if (!object(value) || value.protocolVersion !== 1 || !["allow","deny","ask","unavailable"].includes(value.decision)) throw Error();
    for (const field of ["reason","operatorMessage"]) if (field in value && typeof value[field] !== "string") throw Error();
    if ("retryable" in value && typeof value.retryable !== "boolean") throw Error();
    if ("effectiveInput" in value && !object(value.effectiveInput)) throw Error();
    if (value.decision === "allow" && ("reason" in value || "retryable" in value)) throw Error();
    if (value.decision !== "allow" && !value.reason?.trim()) throw Error();
    if (value.decision !== "unavailable" && "retryable" in value) throw Error();
    if (value.decision === "unavailable" && (!("retryable" in value) || "effectiveInput" in value || "updatedOutput" in value)) throw Error();
    if ("effectiveInput" in value && (boundary !== "pre" || !["allow","ask"].includes(value.decision))) throw Error();
    if ("updatedOutput" in value && (boundary !== "post" || !["allow","deny"].includes(value.decision))) throw Error();
    if (value.decision === "ask" && boundary !== "pre") throw Error();
    // Return only known fields: extension fields never grant authority.
    const result = {protocolVersion:1, decision:value.decision};
    for (const field of ["reason","effectiveInput","updatedOutput","operatorMessage","retryable"]) {
      if (field in value) result[field] = value[field];
    }
    boundaries.set(result,boundary);
    const freeze = item => {
      if (item && typeof item === "object") {Object.values(item).forEach(freeze); Object.freeze(item);}
      return item;
    };
    return freeze(result);
  } catch {
    throw new Unavailable("Invalid or incompatible Hook Protocol v1 response", {code:"hook-protocol"});
  }
}

// Installed Hook identity (#929). The texts never name a path: they reach the
// model as a deny reason. Keep them identical to the Python package.
const IDENTITY = "Installed Hook identity could not be verified";
// The trust-rule texts, for the Hook path and for a pin file's path.
const rules = (subject, leaf) => Object.freeze({
  owner: `an entry on the ${subject} path is not owned by you or root`,
  "world-writable": `a directory on the ${subject} path is world-writable and not a root-owned sticky directory`,
  "group-writable": `a directory on the ${subject} path is group-writable by a group other than macOS admin or your private Linux group`,
  links: `the ${subject} path has more than ${MAX_LINKS} symbolic links`,
  "not-a-directory": `a component of the ${subject} path is not a directory`,
  file: leaf,
});
const UNTRUSTED = rules("Hook", "the Hook is not a regular file of at most 1 GiB owned by you or root and writable only by its owner");
const PIN_UNTRUSTED = rules("pin file", "the pin file is not a regular file owned by you or root and writable only by its owner");
const PIN_FIX = "Run isonapse hook adk-pin and use the pin file it names.";
const IDENTITY_TEXT = Object.freeze({
  "pin-mismatch": `${IDENTITY} (pin mismatch): the Hook binary does not match the configured SHA-256 pin. After an Isonapse upgrade, recompute the pin from hook_binary_path, update the hook definition and re-trust it.`,
  missing: `${IDENTITY} (Hook missing): nothing exists at the configured Hook path; check hook_binary_path in the Isonapse configuration.`,
  changed: `${IDENTITY} (changed during verification): the Hook path or file changed while it was being verified, for example during an upgrade.`,
  "invalid-configuration": `${IDENTITY} (invalid configuration): the Hook path must be absolute and the pin must be 64 lowercase hexadecimal characters.`,
  "pin-file-missing": `${IDENTITY} (pin file missing): nothing exists at the configured pin file path. ${PIN_FIX}`,
  "pin-file-invalid": `${IDENTITY} (pin file invalid): the pin file path must be absolute and the file must hold exactly one SHA-256 as 64 lowercase hexadecimal characters. ${PIN_FIX}`,
});
// A stale pin FILE is fixed by re-pinning, never by editing the hook
// definition: that edit is what makes a host such as Codex un-trust it.
const PIN_FILE_MISMATCH = `${IDENTITY} (pin mismatch): the Hook binary does not match the SHA-256 in the pin file. After an Isonapse upgrade, run isonapse hook adk-pin; the hook definition does not change.`;
const refusal = cause => new Unavailable(IDENTITY_TEXT[cause], {code:`hook-identity:${cause}`});
// What a walk refuses with: the Hook path, or the path of a pin file.
const HOOK = Object.freeze({
  untrusted: rule => new Unavailable(`${IDENTITY} (untrusted path): ${UNTRUSTED[rule]}.`, {code:"hook-identity:untrusted-path"}),
  missing: () => refusal("missing"),
  followLeaf: true,
  leaf: item => item.isFile() && item.size <= BigInt(MAX_BINARY),
});
const PIN_FILE = Object.freeze({
  untrusted: rule => new Unavailable(`${IDENTITY} (pin file untrusted): ${PIN_UNTRUSTED[rule]}. ${PIN_FIX}`, {code:"hook-identity:pin-file-untrusted"}),
  missing: () => refusal("pin-file-missing"),
  // The pin file itself is never a link: only its directories may be.
  followLeaf: false,
  leaf: item => item.isFile(),
});
// A pin file holds 64 lowercase hex characters and at most one trailing "\n".
const MAX_PIN_FILE = 65;
const pinBytes = bytes => (bytes.length === 64 || (bytes.length === 65 && bytes[64] === 0x0a))
  && [...bytes.subarray(0, 64)].every(byte => (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66));
// A plain split, identical in both packages: "" and "." are dropped, ".." is
// resolved against the verified real directory (never lexically up front).
const components = path => path.split("/").filter(part => part !== "" && part !== ".");
const joined = parts => "/" + parts.join("/");
// ignoreBOM: a leading U+FEFF is part of the link target, exactly as the
// kernel and Python's strict codec read it; never strip it.
const strictUtf8 = new TextDecoder("utf-8", {fatal:true, ignoreBOM:true});
const owned = item => item.uid === 0n || item.uid === BigInt(process.geteuid());
const absolute = value => typeof value === "string" && value.startsWith("/") && !value.includes("\0") && value.isWellFormed();
const same = (left, right, fields) => fields.every(field => left[field] === right[field]);

// The one group whose write permission a Hook directory may carry: macOS
// `admin` (Homebrew's Cellar, bin and opt), or on Linux the caller's own
// private group on a directory the caller owns.
function trustedWriterGroup(item) {
  if (process.platform === "darwin") return item.gid === 80n;
  if (process.platform === "linux") {
    const uid = BigInt(process.geteuid());
    return item.uid === uid && item.gid === uid && item.gid === BigInt(process.getegid());
  }
  return false;
}

function trustedDirectory(item, subject) {
  if (!item.isDirectory()) throw subject.untrusted("not-a-directory");
  if (!owned(item)) throw subject.untrusted("owner");
  const rootSticky = item.uid === 0n && (item.mode & 0o1000n) !== 0n;
  if ((item.mode & 0o002n) !== 0n && !rootSticky) throw subject.untrusted("world-writable");
  if ((item.mode & 0o020n) !== 0n && !rootSticky && !trustedWriterGroup(item)) throw subject.untrusted("group-writable");
}

async function entry(path, subject) {
  try { return await lstat(path, {bigint:true}); }
  catch { throw subject.missing(); }
}

// Resolve from `/` one component at a time. A link is followed only when its
// own inode is owned by root or the caller and the directory holding it has
// already passed; every directory reached must pass before anything inside it
// is examined. Returns the real path of a file that passes the leaf rule.
// The same walk serves the Hook and a pin file (`subject`).
async function resolveTrusted(path, subject = HOOK) {
  trustedDirectory(await entry("/", subject), subject);
  let directory = [], queue = components(path), links = 0;
  while (queue.length) {
    const part = queue.shift();
    if (part === "..") {
      if (!queue.length) throw subject.untrusted("file");
      directory.pop();
      continue;
    }
    const candidate = joined([...directory, part]);
    const item = await entry(candidate, subject);
    if (item.isSymbolicLink()) {
      if (!queue.length && !subject.followLeaf) throw subject.untrusted("file");
      if (++links > MAX_LINKS) throw subject.untrusted("links");
      if (!owned(item)) throw subject.untrusted("owner");
      let target;
      // A target that is not UTF-8 cannot be named losslessly by a string
      // path, so it is refused exactly as in the Python package.
      try { target = strictUtf8.decode(await readlink(candidate, {encoding:"buffer"})); }
      catch { throw subject.missing(); }
      if (target.startsWith("/")) directory = [];
      queue = [...components(target), ...queue];
      continue;
    }
    if (queue.length) { trustedDirectory(item, subject); directory.push(part); continue; }
    if (!subject.leaf(item) || (item.mode & 0o022n) !== 0n || !owned(item)) throw subject.untrusted("file");
    return {path: candidate, item};
  }
  throw subject.untrusted("file");
}

// Read the pin from a pin file under the same trust walk as the Hook. Read on
// every verification, so re-pinning takes effect without touching the host's
// hook definition.
async function readPinFile(path) {
  const walked = await resolveTrusted(path, PIN_FILE);
  let file;
  try { file = await open(walked.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { throw refusal(["ENOENT","ELOOP"].includes(error?.code) ? "changed" : "pin-file-missing"); }
  try {
    const buffer = Buffer.alloc(MAX_PIN_FILE + 1);
    let length = 0;
    try {
      const opened = await file.stat({bigint:true});
      if (!opened.isFile() || !same(walked.item, opened, ["dev","ino"])) throw refusal("changed");
      for (;;) {
        const {bytesRead} = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
        if (length === buffer.length) break;
      }
    } catch (error) { throw error instanceof Unavailable ? error : refusal("pin-file-missing"); }
    const bytes = buffer.subarray(0, length);
    if (!pinBytes(bytes)) throw refusal("pin-file-invalid");
    return bytes.subarray(0, 64).toString("latin1");
  } finally { await file.close(); }
}

export class InstalledHook {
  /**
   * `sha256` is the inline pin. With `options.sha256File` (and no inline pin)
   * the pin is read from that owner-only file on every verification instead;
   * see `InstalledHook.fromPinFile`.
   */
  constructor(path, sha256, options) {
    this.path = path; this.sha256 = sha256; this.sha256File = options?.sha256File;
    Object.freeze(this);
  }
  /** A Hook whose pin is read from `sha256File` (written by `isonapse hook adk-pin`). */
  static fromPinFile(path, sha256File) { return new InstalledHook(path, undefined, {sha256File}); }
  /**
   * Verify the operator-selected Hook and return the resolved real path the
   * Client executes. Refusals are `Unavailable` with a `hook-identity:*` code.
   */
  async verify() {
    const {path, sha256, sha256File} = this;
    if (!absolute(path)) throw refusal("invalid-configuration");
    const fromFile = sha256File !== undefined && sha256File !== null;
    let pin;
    if (!fromFile) {
      if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) throw refusal("invalid-configuration");
      pin = sha256;
    } else {
      // Exactly one pin source: an inline pin beside a pin file is ambiguous.
      if (sha256 !== undefined && sha256 !== null) throw refusal("invalid-configuration");
      if (!absolute(sha256File)) throw refusal("pin-file-invalid");
      pin = await readPinFile(sha256File);
    }
    const first = await resolveTrusted(path);
    let file;
    // O_NONBLOCK: a FIFO swapped in after the walk cannot stall the open.
    try { file = await open(first.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { throw refusal(["ENOENT","ELOOP"].includes(error?.code) ? "changed" : "missing"); }
    try {
      let opened, after, digest;
      try {
        opened = await file.stat({bigint:true});
        if (!opened.isFile() || !same(first.item, opened, ["dev","ino"])) throw refusal("changed");
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of file.createReadStream({autoClose:false})) {
          bytes += chunk.length;
          if (bytes > MAX_BINARY) throw refusal("changed");
          hash.update(chunk);
        }
        after = await file.stat({bigint:true});
        digest = hash.digest("hex");
      } catch (error) { throw error instanceof Unavailable ? error : refusal("missing"); }
      if (!same(first.item, after, ["dev","ino","size","mtimeNs"])) throw refusal("changed");
      // The path must still name the hashed file once hashing is done.
      let second;
      try { second = await resolveTrusted(path); } catch { throw refusal("changed"); }
      if (second.path !== first.path || !same(second.item, after, ["dev","ino"])) throw refusal("changed");
      if (digest !== pin) {
        throw fromFile ? new Unavailable(PIN_FILE_MISMATCH, {code:"hook-identity:pin-mismatch"}) : refusal("pin-mismatch");
      }
      return first.path;
    } finally { await file.close(); }
  }
}

function exchange(argv, payload, timeout, signal) {
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT || payload.length > MAX_BYTES || signal?.aborted) {
    return Promise.reject(new Unavailable("Hook transport budget invalid or operation cancelled", {code:"hook-transport"}));
  }
  return new Promise((resolve,reject) => {
    let child;
    // Version probing has no request body. Do not create/write a stdin pipe:
    // a native --version child may close it before Node's queued empty write,
    // producing Linux EPIPE despite a valid successful version response.
    try { child = spawn(argv[0], argv.slice(1), {stdio:[payload.length ? "pipe" : "ignore","pipe","pipe"], detached:true, shell:false}); }
    catch { reject(new Unavailable("Verified Hook could not be started", {code:"hook-transport"})); return; }
    const chunks = [];
    let bytes = 0, diagnostics = 0, failed = false, settled = false;
    const kill = () => {
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    };
    const fail = () => { failed = true; kill(); finish(null); };
    const finish = (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", fail); kill();
      child.stdin?.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (failed || code !== 0) reject(new Unavailable("Hook transport failed, cancelled or exceeded its budget", {code:"hook-transport"}));
      else resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(fail, timeout);
    signal?.addEventListener("abort", fail, {once:true});
    child.stdout.on("data", value => { bytes += value.length; if (bytes > MAX_BYTES) fail(); else chunks.push(value); });
    child.stderr.on("data", value => { diagnostics += value.length; if (diagnostics > MAX_DIAGNOSTICS) fail(); });
    child.stdin?.on("error", fail);
    child.stdout.on("error", fail); child.stderr.on("error", fail);
    child.on("error", () => { failed = true; finish(null); });
    child.on("close", finish);
    child.stdin?.end(payload);
    if (signal?.aborted) fail();
  });
}

export class Client {
  constructor(installed, host, {timeoutMs = MAX_TIMEOUT} = {}) {
    if (!["darwin","linux"].includes(process.platform)) throw new Unavailable("ADK v1 transport supports macOS and Linux process groups");
    if (!/^[a-z][a-z0-9-]{0,92}$/.test(host)) throw new TypeError("Host identity must come from operator registration");
    // A private frozen copy that keeps the pin source (inline or file).
    this.installed = new InstalledHook(installed.path,installed.sha256,{sha256File:installed.sha256File});
    this.host = host; this.timeoutMs = timeoutMs; Object.freeze(this);
  }
  async checkVersion() {
    // Execute the verified real path, never the configured link (#929).
    const executable = await this.installed.verify();
    const raw = await exchange([executable,"--version"],Buffer.alloc(0),this.timeoutMs);
    const value = new TextDecoder("utf-8",{fatal:true}).decode(raw).trim();
    const match = /^isonapse-hook (\d+)\.(\d+)\.(\d+)(?:[-+][A-Za-z0-9.+-]+)?$/.exec(value);
    if (!match || (+match[1] === 0 && +match[2] < 3)) throw new Unavailable("Installed Hook version is incompatible with ADK v1", {code:"hook-protocol"});
    return value;
  }
  async decide(event, request, {boundary,signal} = {}) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(event)) throw new TypeError("Invalid native event");
    if (!object(request) || typeof request.session_id !== "string" || !request.session_id) throw new TypeError("Stable native session identity required");
    if (["pre","post"].includes(boundary) && (typeof request.tool_use_id !== "string" || !request.tool_use_id)) throw new TypeError("Stable native tool-call identity required");
    let payload;
    try {
      payload = Buffer.from(JSON.stringify(snapshot(request)));
    } catch { throw new Unavailable("Host event is not JSON"); }
    const executable = await this.installed.verify();
    const raw = await exchange([executable,event,"--host",this.host,"--adapter-protocol","1"],payload,this.timeoutMs,signal);
    return decode(raw,boundary);
  }
}

export async function execute(decision, original, effect, {approve} = {}) {
  if (boundaries.get(decision) !== "pre") throw new Refused("A decoded pre-action decision is required");
  boundaries.delete(decision);
  const selected = snapshot("effectiveInput" in decision ? decision.effectiveInput : original);
  if (decision.decision === "ask") {
    if (!approve || await approve(decision.reason) !== true) throw new Refused("Host approval was not granted");
  } else if (decision.decision !== "allow") throw new Refused("Isonapse did not permit this effect");
  return effect(selected);
}

export function deliver(decision, original) {
  if (boundaries.get(decision) !== "post") throw new Refused("A decoded post-action decision is required");
  boundaries.delete(decision);
  if (decision.decision === "allow" || (decision.decision === "deny" && "updatedOutput" in decision)) {
    return "updatedOutput" in decision ? decision.updatedOutput : original;
  }
  throw new Refused("Tool output must be withheld");
}
