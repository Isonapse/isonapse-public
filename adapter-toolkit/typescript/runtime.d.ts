import type {Client, Json} from "./index.js";
export class Runtime {
  constructor(client:Client, sessionId:string, cwd:string, options:{notify:(message:string)=>void|Promise<void>;approve?:(reason:string)=>boolean|Promise<boolean>});
  start():Promise<void>;
  end():Promise<void>;
  tool(callId:string, name:string, args:Record<string,Json>, effect:(input:Record<string,Json>)=>Json|Promise<Json>):Promise<Json>;
}
