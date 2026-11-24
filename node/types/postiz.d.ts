import { HermosoClient, HermosoApiError, HermosoUnsupportedError, ToolResult } from './core';
export { HermosoApiError, HermosoUnsupportedError };
/** Unofficial Postiz `@postiz/node` compatible client, served by Hermoso. Not affiliated with Postiz. */
export declare class Postiz {
  constructor(apiKey?: string, path?: string, options?: { baseUrl?: string; fetch?: typeof fetch; rehostMedia?: boolean });
  hermoso: HermosoClient;
  callTool(name: string, args?: Record<string, any>): Promise<ToolResult>;
  post(body: Record<string, any>): Promise<any>;
  postList(query?: Record<string, any>): Promise<any>;
  upload(file: Uint8Array | ArrayBuffer, extension?: string): Promise<any>;
  integrations(): Promise<any>;
  deletePost(id: string): Promise<{ ok: boolean; status: number; statusText: string; json(): Promise<any>; text(): Promise<string> }>;
}
export default Postiz;
