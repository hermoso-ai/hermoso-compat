// Shared plumbing for the compatibility layers: one small client for Hermoso's REST API (/v1), the error types,
// and the platform-name tables the Ayrshare and Zernio shapes both need. Nothing in here knows either vendor's
// method names; those live in ayrshare.js and zernio.js.

export const VERSION = '0.1.0';
export const DEFAULT_BASE_URL = 'https://app.hermoso.ai';
const DOCS = 'https://hermoso.ai/docs/api/';

/** An error Hermoso answered. `code` is Hermoso's own (log it), `type` the coarse family. */
export class HermosoApiError extends Error {
  constructor(message, { status = 0, type, code, param, connector, body, requestId } = {}) {
    super(message);
    this.name = 'HermosoApiError';
    this.status = status;
    this.statusCode = status;
    this.type = type;
    this.code = code;
    this.param = param;
    this.connector = connector;
    this.body = body;
    this.requestId = requestId;
  }
}

/**
 * Thrown by a method this layer does not serve. The message names the Hermoso tool that does the job instead,
 * so the fix is one call away: `client.callTool(tool, args)`, or `POST /v1/tools/{tool}`.
 */
export class HermosoUnsupportedError extends Error {
  constructor(method, { tool = null, hint = '' } = {}) {
    const via = tool
      ? ` Use the Hermoso tool \`${tool}\` instead: client.callTool('${tool}', {...}) or POST ${DEFAULT_BASE_URL}/v1/tools/${tool} (its arguments: GET /v1/tools/${tool}).`
      : ` Search Hermoso's tools for it: GET ${DEFAULT_BASE_URL}/v1/tools?search=${encodeURIComponent(words(method))}.`;
    super(`${method} is not supported by Hermoso's compatibility layer.${via}${hint ? ` ${hint}` : ''}`);
    this.name = 'HermosoUnsupportedError';
    this.code = 'unsupported';
    this.method = method;
    this.tool = tool;
  }
}

function words(name) {
  return String(name).replace(/^.*\./, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase().trim();
}

// ── PLATFORM NAMES ────────────────────────────────────────────────────────────────────────────────────────────
// Ayrshare and Zernio name a few platforms differently from Hermoso's channel ids. Anything not listed passes
// through lowercased: Hermoso's channel list grows, and an id this table has never seen is still a valid ask
// (Hermoso refuses an unknown channel by name, which is the right place for that answer).
const TO_CHANNEL = {
  twitter: 'x', x: 'x',
  gmb: 'google_business', googlebusiness: 'google_business', google_business: 'google_business', google: 'google_business',
};
export function toChannel(platform) {
  const p = String(platform || '').trim().toLowerCase();
  return TO_CHANNEL[p] || p;
}
export function fromChannel(channel, dialect) {
  const c = String(channel || '').toLowerCase();
  if (c === 'x') return 'twitter';
  if (c === 'google_business') return dialect === 'ayrshare' ? 'gmb' : 'googlebusiness';
  return c;
}

// Which per-channel tools serve comments. A channel missing here has no comment tools in Hermoso.
export const COMMENT_TOOLS = {
  facebook: { list: 'list_meta_comments', comment: 'comment_on_meta_post', reply: 'reply_to_meta_comment', moderate: 'moderate_meta_comment' },
  instagram: { list: 'list_meta_comments', comment: 'comment_on_meta_post', reply: 'reply_to_meta_comment', moderate: 'moderate_meta_comment' },
  youtube: { list: 'list_youtube_comments', reply: 'reply_to_youtube_comment', moderate: 'moderate_youtube_comment' },
  tiktok: { list: 'list_tiktok_comments', comment: 'comment_on_tiktok_video', reply: 'reply_to_tiktok_comment', moderate: 'moderate_tiktok_comment' },
  linkedin: { list: 'list_linkedin_comments', comment: 'reply_to_linkedin_comment', reply: 'reply_to_linkedin_comment', moderate: 'delete_linkedin_comment' },
  threads: { list: 'list_threads_replies', comment: 'reply_to_thread', reply: 'reply_to_thread', moderate: 'hide_thread_reply' },
};

// Deleting a post that has ALREADY published is each channel's own delete.
export const PUBLISHED_DELETE_TOOLS = {
  facebook: 'manage_meta_post', instagram: 'manage_meta_post', threads: 'manage_meta_post', x: 'delete_x_post',
  youtube: 'delete_youtube_video', pinterest: 'delete_pinterest_pin', linkedin: 'manage_linkedin_post',
  google_business: 'delete_google_business_post', bluesky: 'delete_bluesky_post', wordpress: 'delete_wordpress_post', wix: 'delete_wix_post',
};

// Hermoso's post statuses are a set that may grow; these are the ones a vendor shape distinguishes.
export const TERMINAL = new Set(['published', 'partially_published', 'failed', 'indeterminate']);

function isHermosoHosted(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'assets.hermoso.ai' || h.endsWith('.hermoso.ai') || h === 'hermoso.ai';
  } catch { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A brand (Hermoso's word for what Ayrshare calls a profile and Zernio a profile) is selected with the
 * `X-Hermoso-User` header; a brand another account shared with you also needs `X-Hermoso-Owner`. The compat layers
 * carry both in one string, `<brandId>` or `<brandId>:<ownerAccountId>`, so a profile key round-trips.
 */
export function parseBrandKey(key) {
  const s = String(key || '').trim();
  if (!s) return { brand: null, owner: null };
  const i = s.indexOf(':');
  return i < 0 ? { brand: s, owner: null } : { brand: s.slice(0, i), owner: s.slice(i + 1) || null };
}
export function brandKeyOf(b) {
  return b?.owner_account_id ? `${b.id}:${b.owner_account_id}` : String(b?.id ?? '');
}

export class HermosoClient {
  /**
   * @param {object} o
   * @param {string} [o.apiKey]   a Hermoso API key (hmk_...). Defaults to process.env.HERMOSO_API_KEY.
   * @param {string} [o.baseUrl]  defaults to process.env.HERMOSO_BASE_URL or https://app.hermoso.ai
   * @param {string} [o.brand]    a brand key (see parseBrandKey); defaults to the brand the key is pinned to
   * @param {typeof fetch} [o.fetch]
   * @param {number} [o.timeout]  ms per request, default 120000
   * @param {string} [o.client]   a short name for the calling layer, sent in User-Agent
   */
  constructor(o = {}) {
    const env = typeof process !== 'undefined' ? process.env : {};
    this.apiKey = o.apiKey || env.HERMOSO_API_KEY || '';
    this.baseUrl = String(o.baseUrl || env.HERMOSO_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetch = o.fetch || globalThis.fetch;
    this.timeout = o.timeout ?? 120000;
    this.client = o.client || 'compat';
    this.defaultHeaders = o.defaultHeaders || {};
    this.brand = null;
    this.owner = null;
    if (o.brand) this.setBrand(o.brand);
    this._channels = null;
  }

  setBrand(key) {
    const { brand, owner } = parseBrandKey(key);
    this.brand = brand;
    this.owner = owner;
    this._channels = null;
    return this;
  }

  /** The same client acting on another brand (a new object; this one is unchanged). */
  forBrand(key) {
    const c = Object.create(this);
    c._channels = null;
    const { brand, owner } = parseBrandKey(key);
    c.brand = brand;
    c.owner = owner;
    return c;
  }

  headers(extra = {}) {
    if (!this.apiKey) {
      throw new HermosoApiError('No Hermoso API key. Pass it to the constructor or set HERMOSO_API_KEY. Create one at https://app.hermoso.ai on the API, MCP & CLI tab.', { status: 401, type: 'authentication_error', code: 'missing_api_key' });
    }
    const h = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      'User-Agent': `hermoso-compat/${VERSION} (${this.client})`,
      ...this.defaultHeaders,
    };
    if (this.brand) h['X-Hermoso-User'] = this.brand;
    if (this.owner) h['X-Hermoso-Owner'] = this.owner;
    return { ...h, ...extra };
  }

  /** One REST call. Resolves with the parsed JSON; rejects with HermosoApiError. */
  async request(method, path, { query, body, headers, bytes, contentType } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
    const h = this.headers(headers);
    let payload;
    if (bytes) { payload = bytes; h['Content-Type'] = contentType || 'application/octet-stream'; }
    else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    const ctl = this.timeout ? AbortSignal.timeout(this.timeout) : undefined;
    let res;
    try {
      res = await this.fetch(url, { method, headers: h, body: payload, signal: ctl });
    } catch (e) {
      throw new HermosoApiError(`Could not reach Hermoso (${e?.name === 'TimeoutError' ? 'timed out' : e?.message || e}).`, { status: 0, type: 'api_error', code: 'network_error' });
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch { json = null; }
    if (!res.ok) {
      const err = json?.error && typeof json.error === 'object' ? json.error : {};
      throw new HermosoApiError(err.message || (typeof json?.error === 'string' ? json.error : '') || `Hermoso answered HTTP ${res.status}.`, {
        status: res.status, type: err.type, code: err.code || `http_${res.status}`, param: err.param,
        connector: err.connector, body: json ?? text, requestId: json?.request_id || res.headers.get('x-request-id') || undefined,
      });
    }
    if (json === null) throw new HermosoApiError('Hermoso answered something that is not JSON.', { status: res.status, type: 'api_error', code: 'bad_response', body: text });
    return json;
  }

  /** Call any Hermoso tool. Resolves with the tool result: `{ text, data }`. */
  callTool(name, args = {}) {
    return this.request('POST', `/v1/tools/${encodeURIComponent(name)}`, { body: args || {} });
  }

  /** Every channel Hermoso publishes to, with `connected` per this brand. Cached for a minute. */
  async channels() {
    if (this._channels && Date.now() - this._channels.at < 60000) return this._channels.data;
    const r = await this.request('GET', '/v1/channels');
    this._channels = { at: Date.now(), data: r.data || [] };
    return this._channels.data;
  }

  async connections() {
    const r = await this.request('GET', '/v1/connections');
    return r.data || [];
  }

  async brands() {
    const r = await this.request('GET', '/v1/brands');
    return r.data || [];
  }

  /** A public URL becomes a durable Hermoso-hosted one (POST /v1/media). Already-hosted URLs pass through. */
  async rehost(url) {
    if (!url || isHermosoHosted(url)) return url;
    const r = await this.request('POST', '/v1/media', { query: { url } });
    return r.url || url;
  }

  /** Upload bytes. `data` may be a Buffer/Uint8Array, a base64 string or a data: URI. */
  async uploadBytes(data, { fileName, contentType } = {}) {
    let bytes = data;
    let type = contentType;
    if (typeof data === 'string') {
      const m = data.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
      if (m) { type = type || m[1]; bytes = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3])); }
      else bytes = Buffer.from(data, 'base64');
    }
    return this.request('POST', '/v1/media', { bytes, contentType: type || 'application/octet-stream', headers: fileName ? { 'X-File-Name': fileName } : {} });
  }

  async getPost(id) {
    return this.request('GET', `/v1/posts/${encodeURIComponent(id)}`);
  }

  /** Every post (newest first), following cursors, up to `max`. */
  async listPosts({ status, channel, max = 100 } = {}) {
    const out = [];
    let after;
    while (out.length < max) {
      const r = await this.request('GET', '/v1/posts', { query: { limit: Math.min(100, max - out.length), status, channel, starting_after: after } });
      out.push(...(r.data || []));
      if (!r.has_more || !r.next_cursor) break;
      after = r.next_cursor;
    }
    return out;
  }

  /** Poll a post until it is no longer scheduled/processing, or `timeoutMs` passes. Returns the last read. */
  async waitForPost(id, timeoutMs = 120000, intervalMs = 2000) {
    const until = Date.now() + timeoutMs;
    let p = await this.getPost(id);
    while (!TERMINAL.has(p.status) && Date.now() < until) {
      await sleep(intervalMs);
      p = await this.getPost(id);
    }
    return p;
  }

  /** How a channel picks WHICH account: `targets[field]` or `options.accounts[channel]`. */
  async accountSelector(channel, accountRef) {
    if (!accountRef) return null;
    const ch = (await this.channels()).find((c) => c.id === channel);
    let conns = [];
    try { conns = await this.connections(); } catch { conns = []; }
    const conn = conns.find((c) => c.provider === (ch?.connector || channel));
    const many = (conn?.accounts || []).length > 1;
    const known = (conn?.accounts || []).some((a) => [a.id, a.handle, a.label].map(String).includes(String(accountRef)));
    if (many && known) return { kind: 'accounts', value: String(accountRef) };
    if (ch?.target_field) return { kind: 'target', field: ch.target_field, value: String(accountRef) };
    if (conn?.accounts?.length) return { kind: 'accounts', value: String(accountRef) };
    return null;
  }

  /** The connected accounts as one flat list: one row per (channel, account). */
  async accountRows() {
    const [chs, conns] = await Promise.all([this.channels(), this.connections().catch(() => [])]);
    const rows = [];
    for (const ch of chs) {
      if (!ch.connected && !ch.needs_reconnect) continue;
      const conn = conns.find((c) => c.provider === ch.connector);
      const accts = conn?.accounts?.length ? conn.accounts : [{ id: null, label: ch.account || conn?.account || null, handle: null }];
      for (const a of accts) {
        rows.push({ channel: ch.id, connector: ch.connector, accountId: a.id ? `${ch.id}:${a.id}` : ch.id, ref: a.id || null,
          label: a.label || ch.account || conn?.account || null, handle: a.handle || null, needsReconnect: !!ch.needs_reconnect, name: ch.name });
      }
    }
    return rows;
  }
}

/** "@x:123" → { channel: 'x', ref: '123' }; "x" → { channel: 'x', ref: null }. Also accepts a bare platform. */
export function splitAccountId(accountId, platform) {
  const s = String(accountId || '');
  const i = s.indexOf(':');
  if (i > 0) return { channel: toChannel(s.slice(0, i)), ref: s.slice(i + 1) };
  if (s && toChannel(s) === toChannel(platform || s)) return { channel: toChannel(s), ref: null };
  return { channel: toChannel(platform || s), ref: s && platform ? s : null };
}

export { DOCS, sleep, isHermosoHosted };
