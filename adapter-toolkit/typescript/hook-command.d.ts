import type {Boundary, Client, Decision, Json, UnavailableCode} from "./index.js";
export type HookCommandEventName = "SessionStart" | "SessionEnd" | "PreToolUse" | "PostToolUse";
export const HOOK_COMMAND_EVENTS: Readonly<Record<HookCommandEventName, {readonly event:string; readonly boundary:Boundary}>>;
/** Read one bounded, strictly decoded host event from a byte stream (stdin by default). */
export function readHostEvent(stream?:AsyncIterable<Uint8Array|string>, options?:{maxBytes?:number}):Promise<Record<string,Json>>;
export type HookCommandKind = "acknowledged" | "proceed" | "rewrite" | "refuse" | "deliver" | "replace" | "withhold";
export interface HookCommandOutcome {
  readonly event:string;
  readonly boundary:Boundary;
  /** The only field to branch on. */
  readonly kind:HookCommandKind;
  /** Display text for refuse/withhold; never parse it. */
  readonly reason?:string;
  /** Present only when the Hook gave no decision: identity, transport or protocol. */
  readonly cause?:UnavailableCode;
  readonly operatorMessage?:string;
  readonly decision?:Decision;
  /** Exact input to run for `proceed`/`rewrite`. */
  readonly input?:Record<string,Json>;
  /** Exact result to show for `deliver`/`replace`. */
  readonly output?:Json;
}
export function hookCommand(client:Client, payload:unknown, options?:{approve?:(reason:string)=>boolean|Promise<boolean>; checkVersion?:boolean; signal?:AbortSignal}):Promise<HookCommandOutcome>;
