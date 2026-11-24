export declare const VERSION: string;
export declare class HermosoApiError extends Error {
  status: number; statusCode: number; type?: string; code?: string; param?: string; connector?: string; body?: unknown; requestId?: string;
}
/** Thrown by a method this layer does not serve. `tool` names the Hermoso tool that does the job. */
export declare class HermosoUnsupportedError extends Error { code: 'unsupported'; method: string; tool: string | null; }
export interface HermosoClientOptions { apiKey?: string; baseUrl?: string; brand?: string; fetch?: typeof fetch; timeout?: number; client?: string; defaultHeaders?: Record<string, string>; }
export interface ToolResult { object: 'tool_result'; tool: string; text: string; data: any; }
export declare class HermosoClient {
  constructor(options?: HermosoClientOptions);
  apiKey: string; baseUrl: string; brand: string | null; owner: string | null;
  setBrand(key: string | null): this;
  forBrand(key: string): HermosoClient;
  request<T = any>(method: string, path: string, opts?: { query?: Record<string, unknown>; body?: unknown; headers?: Record<string, string>; bytes?: unknown; contentType?: string }): Promise<T>;
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
}
