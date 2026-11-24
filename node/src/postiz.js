// Postiz-compatible client (the `@postiz/node` package's class and its five methods), served by Hermoso.
//
//   - import Postiz from '@postiz/node';
//   + import Postiz from '@hermoso/compat/postiz';
//     const postiz = new Postiz(process.env.HERMOSO_API_KEY);
//
// Shapes follow Postiz's public API (/public/v1): an "integration" is a connected account, and its id here is
// Hermoso's account id (`x`, or `facebook:<pageId>` where a channel holds several). Errors come back the way the
// original surfaces them: the parsed error body, not a thrown exception. A post type this layer cannot serve
// (`draft`) throws HermosoUnsupportedError naming the Hermoso tool to use.
//
// Unofficial: written by Hermoso, not affiliated with or endorsed by Postiz.

import { HermosoClient, HermosoApiError, HermosoUnsupportedError, toChannel, splitAccountId } from './core.js';

// Postiz provider identifiers ↔ Hermoso channels.
const FROM_POSTIZ = { x: 'x', 'linkedin-page': 'linkedin', 'instagram-standalone': 'instagram', gmb: 'google_business', 'google-my-business': 'google_business' };
const TO_POSTIZ = { x: 'x', google_business: 'gmb' };
const pChannel = (id) => FROM_POSTIZ[String(id || '').toLowerCase()] || toChannel(id);
const pIdent = (ch) => TO_POSTIZ[ch] || ch;

function errBody(e) {
  if (e instanceof HermosoUnsupportedError) throw e;
  const he = e instanceof HermosoApiError ? e : null;
  return { statusCode: he?.status || 500, message: he?.message || String(e?.message || e), error: he?.code || 'error', ...(he?.connector ? { connector: he.connector } : {}) };
}

function settingsToHermoso(ch, s = {}, body) {
  const o = body.options;
  if (!s || typeof s !== 'object') return;
  if (s.title && !body.title) body.title = s.title;
  if (ch === 'youtube') {
    if (s.type) (body.visibility_by_channel ||= {}).youtube = String(s.type).toLowerCase();
    if (Array.isArray(s.tags)) o.tags = s.tags.map((t) => t.value ?? t.label ?? t);
    if (s.thumbnail?.path) o.thumbnailUrl = s.thumbnail.path;
  }
  if (ch === 'tiktok') {
    if (s.privacy_level) o.privacyLevel = s.privacy_level;
    if (s.duet !== undefined) o.disableDuet = !s.duet;
    if (s.stitch !== undefined) o.disableStitch = !s.stitch;
    if (s.comment !== undefined) o.disableComment = !s.comment;
    if (s.brand_content_toggle !== undefined) o.brandedContent = s.brand_content_toggle;
    if (s.brand_organic_toggle !== undefined) o.yourBrand = s.brand_organic_toggle;
    if (s.content_posting_method === 'UPLOAD') (body.visibility_by_channel ||= {}).tiktok = 'draft';
  }
  if (ch === 'pinterest') {
    if (s.link && !body.link) body.link = s.link;
    if (s.board) body.targets.boardId = s.board;
  }
  if (ch === 'x' && s.who_can_reply_post && s.who_can_reply_post !== 'everyone') o.replySettings = s.who_can_reply_post;
  if (ch === 'instagram') {
    if (s.post_type === 'story') o.story = true;
    if (Array.isArray(s.collaborators)) o.collaborators = s.collaborators.map((c) => c.label ?? c.value ?? c);
  }
}

export class Postiz {
  /**
   * @param {string} apiKey  your Hermoso API key (hmk_...)
   * @param {string} [path]  ignored unless it is a Hermoso URL (Postiz's second argument is its own API host)
   * @param {object} [options]  { waitForPublish (default false: Postiz answers before publishing), fetch }
   */
  constructor(apiKey, path, options = {}) {
    const baseUrl = path && /hermoso|127\.0\.0\.1|localhost/.test(path) ? path : options.baseUrl;
    this.hermoso = new HermosoClient({ apiKey, baseUrl, fetch: options.fetch, client: 'postiz' });
    this._apiKey = this.hermoso.apiKey;
    this._path = this.hermoso.baseUrl;
    this.rehostMedia = options.rehostMedia !== false;
  }

  /** Escape hatch: any Hermoso tool, `{ text, data }`. */
  callTool(name, args) { return this.hermoso.callTool(name, args); }

  /** POST /public/v1/posts → one Hermoso post per entry in `posts[]` (each integration keeps its own content). */
  async post(body = {}) {
    if (body.type === 'draft') throw new HermosoUnsupportedError('postiz.post({ type: "draft" })', { tool: 'schedule_post', hint: 'Hermoso has no unscheduled draft post: schedule it with type "schedule" and edit or delete it before it fires.' });
    try {
      const out = [];
      const when = body.type === 'now' || !body.date || Date.parse(body.date) <= Date.now() + 60_000 ? null : new Date(body.date).toISOString();
      for (const item of body.posts || []) {
        const { channel, ref } = splitAccountId(item.integration?.id, item.settings?.__type ? pChannel(item.settings.__type) : undefined);
        const ch = item.settings?.__type ? pChannel(item.settings.__type) : channel;
        const values = item.value || [];
        const first = values[0] || {};
        const hb = { channels: [ch], caption: first.content ?? '', options: {}, targets: {} };
        const imgs = (first.image || []).map((m) => m.path || m.url).filter(Boolean);
        if (imgs.length) hb.media = this.rehostMedia ? await Promise.all(imgs.map((u) => this.hermoso.rehost(u))) : imgs;
        if (values.length > 1) {
          if (ch === 'x') hb.options.thread = values.map((v) => v.content ?? '');
          else hb.first_comment = values[1].content;
        }
        if (when) hb.scheduled_at = when;
        if (ref) {
          const sel = await this.hermoso.accountSelector(ch, ref);
          if (sel?.kind === 'target') hb.targets[sel.field] = sel.value;
          else if (sel?.kind === 'accounts') hb.options.accounts = { [ch]: [sel.value] };
        }
        settingsToHermoso(ch, item.settings, hb);
        if (!Object.keys(hb.options).length) delete hb.options;
        if (!Object.keys(hb.targets).length) delete hb.targets;
        const p = await this.hermoso.request('POST', '/v1/posts', { body: hb });
        out.push({ postId: p.id, integration: item.integration?.id, status: p.status });
      }
      return out;
    } catch (e) { return errBody(e); }
  }

  /** GET /public/v1/posts → the posts in a date window (startDate/endDate, or Postiz's display/week/day/month/year). */
  async postList(query = {}) {
    try {
      let from = query.startDate ? Date.parse(query.startDate) : null;
      let to = query.endDate ? Date.parse(query.endDate) : null;
      if (from === null && query.year) {
        const y = Number(query.year);
        if (query.display === 'month' && query.month) { from = Date.UTC(y, Number(query.month) - 1, 1); to = Date.UTC(y, Number(query.month), 1); }
        else if (query.display === 'week' && query.week) { const jan4 = Date.UTC(y, 0, 4); const d = (new Date(jan4).getUTCDay() + 6) % 7; from = jan4 - d * 864e5 + (Number(query.week) - 1) * 7 * 864e5; to = from + 7 * 864e5; }
      }
      const posts = await this.hermoso.listPosts({ max: 1000 });
      const rows = [];
      for (const p of posts) {
        const t = Date.parse(p.scheduled_at || p.created_at || 0);
        if (from !== null && t < from) continue;
        if (to !== null && t >= to) continue;
        for (const ch of p.channels || []) {
          const r = (p.results || []).find((x) => x.channel === ch);
          rows.push({
            id: p.id, group: p.id, content: p.captions_by_channel?.[ch] ?? p.caption ?? '', publishDate: p.scheduled_at,
            releaseURL: r?.url || null, releaseId: r?.id || null,
            state: r ? (r.ok ? 'PUBLISHED' : 'ERROR') : p.status === 'scheduled' ? 'QUEUE' : p.status === 'processing' ? 'QUEUE' : 'ERROR',
            ...(r && !r.ok ? { error: r.error } : {}),
            integration: { id: ch, providerIdentifier: pIdent(ch), name: ch },
            image: (p.media || []).map((m) => ({ id: m.url, path: m.url })),
          });
        }
      }
      return { posts: rows };
    } catch (e) { return errBody(e); }
  }

  /** POST /public/v1/upload. `file` is a Buffer/Uint8Array; `extension` is png | jpg | gif (or any extension). */
  async upload(file, extension = 'jpg') {
    try {
      const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime' };
      const m = await this.hermoso.uploadBytes(file, { fileName: `upload.${extension}`, contentType: types[String(extension).toLowerCase()] || 'application/octet-stream' });
      return { id: m.url, name: m.name || `upload.${extension}`, path: m.url, organizationId: this.hermoso.brand || 'default', createdAt: new Date().toISOString(), type: m.type };
    } catch (e) { return errBody(e); }
  }

  /** GET /public/v1/integrations → the connected accounts. */
  async integrations() {
    try {
      return (await this.hermoso.accountRows()).map((r) => ({
        id: r.accountId, name: r.label || r.handle || r.name, identifier: pIdent(r.channel), providerIdentifier: pIdent(r.channel),
        picture: null, disabled: !!r.needsReconnect, refreshNeeded: !!r.needsReconnect, profile: r.handle || r.label || null, customer: null,
      }));
    } catch (e) { return errBody(e); }
  }

  /** DELETE /public/v1/posts/:id. Like the original, resolves with the HTTP response (call .json() for the body). */
  async deletePost(id) {
    let status = 200;
    let body;
    try {
      await this.hermoso.request('DELETE', `/v1/posts/${encodeURIComponent(id)}`);
      body = { id, deleted: true };
    } catch (e) { body = errBody(e); status = body.statusCode; }
    return { ok: status < 400, status, statusText: status < 400 ? 'OK' : 'Error', json: async () => body, text: async () => JSON.stringify(body) };
  }
}

export { HermosoApiError, HermosoUnsupportedError };
export default Postiz;
