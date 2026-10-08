export type Boundary = "pre" | "post" | "lifecycle";
export type Json = null | boolean | number | string | Json[] | {[key:string]:Json};
export interface Decision {
  protocolVersion: 1;
  decision: "allow" | "deny" | "ask" | "unavailable";
  reason?: string;
  effectiveInput?: Record<string,Json>;
  updatedOutput?: Json;
  operatorMessage?: string;
  retryable?: boolean;
}
/** Why the Hook gave no decision. Absent for host-side input errors. */
export type UnavailableCode =
  | "hook-identity:pin-mismatch" | "hook-identity:untrusted-path" | "hook-identity:missing"
  | "hook-identity:changed" | "hook-identity:invalid-configuration"
  | "hook-identity:pin-file-missing" | "hook-identity:pin-file-untrusted" | "hook-identity:pin-file-invalid"
  | "hook-transport" | "hook-protocol";
export class Unavailable extends Error {
  constructor(message?:string, options?:{code?:UnavailableCode});
  readonly code?:UnavailableCode;
}
export class Refused extends Error {}
export const MAX_BYTES: number;
export function snapshot(value:unknown):Json;
export function decode(raw: Uint8Array | string, boundary: Boundary): Decision;
/** Strictly decode one native host event (bounded, UTF-8, no duplicate keys, object). */
export function decodeHostEvent(raw: Uint8Array | string): Record<string,Json>;
export class InstalledHook {
  /**
   * `sha256` is the inline pin. With `options.sha256File` instead (and no
   * inline pin), the pin is read from that file on every verification.
   */
  constructor(path:string, sha256?:string, options?:{sha256File?:string});
  /**
   * A Hook whose pin is read from `sha256File` on every verification: an
   * absolute path to a regular file (never a link) owned by you or root,
   * writable only by its owner, under directories that pass the Hook path
   * rule, holding 64 lowercase hex characters and at most one trailing
   * newline. `isonapse hook adk-pin` writes it after verifying the Hook.
   */
  static fromPinFile(path:string, sha256File:string):InstalledHook;
  readonly path:string;
  readonly sha256?:string;
  readonly sha256File?:string;
  /**
   * Read the pin (inline or from the pin file), resolve the path from `/`
   * under the trusted-ownership rule, hash the file against the pin, resolve
   * again and return the resolved real path, which `Client` executes. Rejects
   * with `Unavailable` (`hook-identity:*`).
   */
  verify():Promise<string>;
}
export class Client {
  constructor(installed:InstalledHook, host:string, options?:{timeoutMs?:number});
  checkVersion():Promise<string>;
  decide(event:string, request:Record<string,Json>, options:{boundary:Boundary;signal?:AbortSignal}):Promise<Decision>;
}
export function execute<T>(decision:Decision, original:Record<string,Json>, effect:(input:Record<string,Json>)=>T|Promise<T>, options?:{approve?:(reason:string)=>boolean|Promise<boolean>}):Promise<T>;
export function deliver(decision:Decision, original:Json):Json;
