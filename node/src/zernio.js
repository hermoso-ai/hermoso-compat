// Zernio-compatible client (the `@zernio/node` package's class, namespaces and method names), served by Hermoso.
//
//   - import Zernio from '@zernio/node';
//   + import Zernio from '@hermoso/compat/zernio';
//     const zernio = new Zernio({ apiKey: process.env.HERMOSO_API_KEY });
//
// Every method takes Zernio's options object ({ path, query, body, headers }) and resolves with `{ data }`, like the
// original. An API error rejects with ZernioApiError (or RateLimitError / ValidationError). A method this layer does
// not serve rejects with HermosoUnsupportedError, whose message names the Hermoso tool that does the job.
//
// Unofficial: written by Hermoso, not affiliated with or endorsed by Zernio.

import { HermosoClient, HermosoApiError, HermosoUnsupportedError } from './core.js';
import { zernioRoute, unsupported } from './zernio-rest.js';

export class ZernioApiError extends Error {
  constructor(message, statusCode, code, details, body) {
    super(message);
    this.name = 'ZernioApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.type = body?.type;
    this.param = body?.param;
    this.body = body;
  }
  isRateLimited() { return this.statusCode === 429; }
  isAuthError() { return this.statusCode === 401; }
  isForbidden() { return this.statusCode === 403; }
  isNotFound() { return this.statusCode === 404; }
  isValidationError() { return this.statusCode === 400; }
  isPaymentRequired() { return this.statusCode === 402; }
}
export const LateApiError = ZernioApiError;
export class RateLimitError extends ZernioApiError {
  constructor(message, retryAfterSeconds, body) {
    super(message, 429, 'rate_limited', undefined, body);
    this.name = 'RateLimitError';
    this.resetAt = retryAfterSeconds ? new Date(Date.now() + retryAfterSeconds * 1000) : undefined;
  }
  getSecondsUntilReset() { return this.resetAt ? Math.max(0, Math.ceil((this.resetAt - Date.now()) / 1000)) : 0; }
}
export class ValidationError extends ZernioApiError {
  constructor(message, fields, body) {
    super(message, 400, body?.code || 'validation_error', undefined, body);
    this.name = 'ValidationError';
    this.fields = fields || {};
  }
}

function toZernioError(e) {
  if (e instanceof HermosoUnsupportedError || e instanceof ZernioApiError) return e;
  if (!(e instanceof HermosoApiError)) return e;
  const body = { error: e.message, message: e.message, code: e.code, type: e.type, param: e.param, ...(e.connector ? { platform: e.connector } : {}), hermoso: e.body, requestId: e.requestId };
  if (e.status === 429) return new RateLimitError(e.message, undefined, body);
  if (e.status === 400 && e.param) return new ValidationError(e.message, { [e.param]: [e.message] }, body);
  return new ZernioApiError(e.message, e.status, e.code, undefined, body);
}

// method name → [HTTP method, Zernio path]. Anything not here is a HermosoUnsupportedError.
const METHODS = {
  posts: {
    listPosts: ['GET', '/v1/posts'], createPost: ['POST', '/v1/posts'], getPost: ['GET', '/v1/posts/{postId}'],
    updatePost: ['PUT', '/v1/posts/{postId}'], deletePost: ['DELETE', '/v1/posts/{postId}'], retryPost: ['POST', '/v1/posts/{postId}/retry'],
  },
  profiles: {
    listProfiles: ['GET', '/v1/profiles'], createProfile: ['POST', '/v1/profiles'], getProfile: ['GET', '/v1/profiles/{profileId}'], updateProfile: ['PUT', '/v1/profiles/{profileId}'],
  },
  accounts: {
    listAccounts: ['GET', '/v1/accounts'], getAccount: ['GET', '/v1/accounts/{accountId}'], deleteAccount: ['DELETE', '/v1/accounts/{accountId}'],
    getAllAccountsHealth: ['GET', '/v1/accounts/health'], getAccountHealth: ['GET', '/v1/accounts/{accountId}/health'],
    getFollowerStats: ['GET', '/v1/accounts/follower-stats'], getAccountPosts: ['GET', '/v1/accounts/{accountId}/posts'],
    getGoogleBusinessReviews: ['GET', '/v1/accounts/{accountId}/gmb-reviews'],
    replyToGoogleBusinessReview: ['POST', '/v1/accounts/{accountId}/gmb-reviews/{reviewId}/reply'],
    deleteGoogleBusinessReviewReply: ['DELETE', '/v1/accounts/{accountId}/gmb-reviews/{reviewId}/reply'],
  },
  media: { getMediaPresignedUrl: ['POST', '/v1/media/presign'] },
  queue: {
    listQueueSlots: ['GET', '/v1/queue/slots'], createQueueSlot: ['POST', '/v1/queue/slots'], updateQueueSlot: ['PUT', '/v1/queue/slots'], deleteQueueSlot: ['DELETE', '/v1/queue/slots'],
  },
  webhooks: {
    getWebhookSettings: ['GET', '/v1/webhooks/settings'], createWebhookSettings: ['POST', '/v1/webhooks/settings'], updateWebhookSettings: ['PUT', '/v1/webhooks/settings'],
    deleteWebhookSettings: ['DELETE', '/v1/webhooks/settings'], testWebhook: ['POST', '/v1/webhooks/test'], getWebhookLogs: ['GET', '/v1/webhooks/logs'],
    redeliverWebhookEvent: ['POST', '/v1/webhooks/logs/redeliver'],
  },
  connect: { getConnectUrl: ['GET', '/v1/connect/{platform}'], createPlatformInvite: ['POST', '/v1/platform-invites'] },
  analytics: {
    getAnalytics: ['GET', '/v1/analytics'], getBestTimeToPost: ['GET', '/v1/analytics/best-time'], getContentDecay: ['GET', '/v1/analytics/content-decay'],
    getPostingFrequency: ['GET', '/v1/analytics/posting-frequency'], getInstagramFollowerHistory: ['GET', '/v1/analytics/instagram/follower-history'],
  },
  users: { getCurrentUser: ['GET', '/v1/users/me'] },
  usage: { getUsageStats: ['GET', '/v1/usage-stats'], getUsage: ['GET', '/v1/usage'] },
  comments: {
    getInboxPostComments: ['GET', '/v1/inbox/comments/{postId}'], replyToInboxPost: ['POST', '/v1/inbox/comments/{postId}'],
    deleteInboxComment: ['DELETE', '/v1/inbox/comments/{postId}'], hideInboxComment: ['POST', '/v1/inbox/comments/{postId}/{commentId}/hide'],
    unhideInboxComment: ['DELETE', '/v1/inbox/comments/{postId}/{commentId}/hide'], sendPrivateReplyToComment: ['POST', '/v1/inbox/comments/{postId}/{commentId}/private-reply'],
  },
  reviews: {
    listInboxReviews: ['GET', '/v1/inbox/reviews'], replyToInboxReview: ['POST', '/v1/inbox/reviews/{reviewId}/reply'], deleteInboxReviewReply: ['DELETE', '/v1/inbox/reviews/{reviewId}/reply'],
  },
  validate: { validatePostLength: ['POST', '/v1/tools/validate/post-length'], validatePost: ['POST', '/v1/tools/validate/post'] },
};
// Short names the Zernio docs also use.
const ALIASES = { posts: { list: 'listPosts', create: 'createPost', get: 'getPost', update: 'updatePost', delete: 'deletePost', retry: 'retryPost' } };

/** The served method table, for the README's coverage table and the tests. */
export const SERVED_METHODS = Object.fromEntries(Object.entries(METHODS).map(([ns, m]) => [ns, Object.keys(m)]));

function fill(tpl, path = {}) {
  return tpl.replace(/\{(\w+)\}/g, (_, n) => {
    const v = path[n];
    if (v === undefined || v === null || ['', '.', '..'].includes(String(v))) throw new ValidationError(`Path parameter "${n}" is required and cannot be empty, "." or "..".`, { [n]: ['required'] }, { code: 'invalid_path_parameter', param: n });
    return encodeURIComponent(String(v));
  });
}

export class Zernio {
  /**
   * @param {object} [opts]
   * @param {string} [opts.apiKey]   your Hermoso API key (hmk_...). Defaults to HERMOSO_API_KEY (ZERNIO_API_KEY is read only when it holds an hmk_ key).
   * @param {string} [opts.baseURL]  Hermoso's API base. A zernio.com URL is ignored. Defaults to https://app.hermoso.ai
   * @param {number} [opts.timeout]  ms per request, default 300000
   * @param {Record<string,string>} [opts.defaultHeaders]
   * @param {typeof fetch} [opts.fetch]
   * @param {boolean} [opts.waitForPublish]  publishNow waits for the outcome (default true), like Zernio's synchronous publish
   */
  constructor(opts = {}) {
    const env = typeof process !== 'undefined' ? process.env : {};
    const zKey = env.ZERNIO_API_KEY || env.LATE_API_KEY || '';
    const apiKey = opts.apiKey || env.HERMOSO_API_KEY || (/^hmk_/.test(zKey) ? zKey : '');
    if (!apiKey) throw new Error('A Hermoso API key is required. Pass apiKey or set HERMOSO_API_KEY. Create one at https://app.hermoso.ai on the API, MCP & CLI tab.');
    const baseUrl = opts.baseURL && !/zernio\.com|getlate\.dev/.test(opts.baseURL) ? opts.baseURL.replace(/\/api\/?$/, '') : undefined;
    this.hermoso = new HermosoClient({ apiKey, baseUrl, fetch: opts.fetch, timeout: opts.timeout ?? 300000, defaultHeaders: opts.defaultHeaders, client: 'zernio' });
    this.hermoso.waitForPublish = opts.waitForPublish !== false;
    this.hermoso.publishTimeoutMs = opts.publishTimeoutMs ?? 300000;
    this.hermoso.rehostMedia = opts.rehostMedia !== false;
    this.apiKey = apiKey;
    this.baseURL = this.hermoso.baseUrl;
    const self = this;
    for (const ns of Object.keys(METHODS)) this[ns] = this._namespace(ns);
    // Any other namespace (adcampaigns, whatsapp, sms, ...) exists, and each of its methods rejects with a clear
    // HermosoUnsupportedError naming the Hermoso tool to use.
    return new Proxy(this, {
      get(target, prop, recv) {
        if (prop in target || typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return Reflect.get(target, prop, recv);
        return self._namespace(String(prop));
      },
    });
  }

  /** Escape hatch: call any Hermoso tool. Resolves with `{ text, data }`. */
  callTool(name, args) { return this.hermoso.callTool(name, args); }

  /** Run any Zernio REST call (method + Zernio path) against Hermoso. Resolves with the response body. */
  async request(method, path, { query, body, headers } = {}) {
    try { return await zernioRoute(this.hermoso, method, path, { query, body, headers }); } catch (e) { throw toZernioError(e); }
  }

  _namespace(ns) {
    const table = METHODS[ns] || {};
    const aliases = ALIASES[ns] || {};
    const call = (name) => async (options = {}) => {
      const def = table[name];
      if (!def) throw unsupported(ns, name);
      const [method, tpl] = def;
      try {
        const data = await zernioRoute(this.hermoso, method, fill(tpl, options.path), { query: options.query || {}, body: options.body || {}, headers: options.headers || {} });
        return { data, error: undefined, request: undefined, response: undefined };
      } catch (e) { throw toZernioError(e); }
    };
    const obj = {};
    for (const name of Object.keys(table)) obj[name] = call(name);
    for (const [alias, name] of Object.entries(aliases)) obj[alias] = call(name);
    return new Proxy(obj, {
      get(target, prop) {
        if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return target[prop];
        if (prop in target) return target[prop];
        return call(String(prop));
      },
    });
  }
}

export const Late = Zernio;
export { HermosoApiError, HermosoUnsupportedError };
export default Zernio;
