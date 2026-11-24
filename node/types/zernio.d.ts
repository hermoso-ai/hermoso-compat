import { HermosoClient, HermosoApiError, HermosoUnsupportedError, ToolResult } from './core';
export { HermosoApiError, HermosoUnsupportedError };
export interface ClientOptions { apiKey?: string; baseURL?: string | null; timeout?: number; defaultHeaders?: Record<string, string>; fetch?: typeof fetch; waitForPublish?: boolean; publishTimeoutMs?: number; rehostMedia?: boolean; }
export interface CallOptions { path?: Record<string, string>; query?: Record<string, any>; body?: Record<string, any>; headers?: Record<string, string>; signal?: AbortSignal; }
export interface CallResult<T = any> { data: T; error: undefined; request: undefined; response: undefined; }
type Method = (options?: CallOptions) => Promise<CallResult>;
type Namespace = Record<string, Method>;
export declare class ZernioApiError extends Error {
  statusCode: number; code?: string; details?: Record<string, unknown>; type?: string; param?: string; body?: any;
  isRateLimited(): boolean; isAuthError(): boolean; isForbidden(): boolean; isNotFound(): boolean; isValidationError(): boolean; isPaymentRequired(): boolean;
}
export declare const LateApiError: typeof ZernioApiError;
export declare class RateLimitError extends ZernioApiError { resetAt?: Date; getSecondsUntilReset(): number; }
export declare class ValidationError extends ZernioApiError { fields: Record<string, string[]>; }
export declare const SERVED_METHODS: Record<string, string[]>;
/** Unofficial Zernio `@zernio/node` compatible client, served by Hermoso. Not affiliated with Zernio. */
export declare class Zernio {
  constructor(opts?: ClientOptions);
  hermoso: HermosoClient; apiKey: string; baseURL: string;
  callTool(name: string, args?: Record<string, any>): Promise<ToolResult>;
  request(method: string, path: string, opts?: { query?: Record<string, any>; body?: Record<string, any>; headers?: Record<string, string> }): Promise<any>;
  posts: Namespace; profiles: Namespace; accounts: Namespace; media: Namespace; queue: Namespace; webhooks: Namespace; connect: Namespace;
  analytics: Namespace; users: Namespace; usage: Namespace; comments: Namespace; reviews: Namespace; validate: Namespace;
  [namespace: string]: any;
}
export declare const Late: typeof Zernio;
export default Zernio;
