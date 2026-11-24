// Ayrshare-compatible client (the `social-media-api` npm package's class and method names), served by Hermoso.
//
//   - import SocialMediaAPI from 'social-media-api';
//   + import SocialMediaAPI from '@hermoso/compat/ayrshare';
//     const social = new SocialMediaAPI(process.env.HERMOSO_API_KEY);
//
// Like the original, every method resolves with a response object and never rejects on an API error: a refusal
// comes back as `{ status: 'error', code, message, ... }`. The one exception is a method this layer cannot serve,
// which THROWS a HermosoUnsupportedError naming the Hermoso tool to call instead (so it cannot be mistaken for a
// transient failure and retried).
//
// Unofficial: written by Hermoso, not affiliated with or endorsed by Ayrshare.

import { webhookSink, freshSecret } from './zernio-rest.js';
import {
  HermosoClient, HermosoApiError, HermosoUnsupportedError, toChannel, fromChannel, brandKeyOf,
  COMMENT_TOOLS, PUBLISHED_DELETE_TOOLS, TERMINAL,
} from './core.js';

const A = (c) => fromChannel(c, 'ayrshare');
const nowIso = () => new Date().toISOString();

function errorResponse(e, extra = {}) {
  if (e instanceof HermosoUnsupportedError) throw e;
  const he = e instanceof HermosoApiError ? e : null;
  return {
    status: 'error',
    code: he?.code || 'error',
    message: he?.message || String(e?.message || e),
    ...(he?.connector ? { platform: A(he.connector), connector: he.connector } : {}),
    hermoso: he ? { status: he.status, type: he.type, code: he.code, param: he.param, connector: he.connector, requestId: he.requestId } : undefined,
    ...extra,
  };
}

/** A Hermoso post → one Ayrshare history item. */
function historyItem(p) {
  const results = Array.isArray(p.results) ? p.results : [];
  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  const status = p.status === 'published' ? 'success'
    : p.status === 'scheduled' ? 'pending'
    : p.status === 'processing' ? 'processing'
    : TERMINAL.has(p.status) ? 'error' : p.status;
  return {
    id: p.id,
    post: p.caption || '',
    title: p.title || undefined,
    platforms: (p.channels || []).map(A),
    postIds: ok.map((r) => ({ status: 'success', id: r.id, postUrl: r.url || undefined, platform: A(r.channel) })),
    errors: bad.map((r) => ({ action: 'post', status: 'error', code: 'publish_failed', message: r.error || 'This channel did not publish.', platform: A(r.channel) })),
    status,
    type: p.scheduled_at && p.created_at && Date.parse(p.scheduled_at) - Date.parse(p.created_at) > 90_000 ? 'schedule' : 'now',
    created: p.created_at,
    scheduleDate: p.scheduled_at,
    mediaUrls: (p.media || []).map((m) => m.url),
    ...(p.status_detail ? { notes: p.status_detail } : {}),
    hermoso: p,
  };
}

/** A Hermoso post → the response Ayrshare's POST /post answers. */
function postResult(p) {
  const h = historyItem(p);
  const base = { id: p.id, refId: undefined, post: h.post, postIds: h.postIds, errors: h.errors, hermoso: p };
  if (p.status === 'scheduled') return { status: 'scheduled', scheduleDate: p.scheduled_at, ...base };
  if (p.status === 'processing') return { status: 'pending', message: 'Still publishing. Read the outcome with getPost({ id }).', ...base };
  if (p.status === 'published') return { status: 'success', ...base };
  if (p.status === 'indeterminate') return { status: 'error', message: p.status_detail || 'The send was interrupted and Hermoso cannot tell whether it published. Check the channel before posting again.', ...base };
  return { status: 'error', ...base };
}

// Per-platform options Ayrshare takes on POST /post → Hermoso's `options`, `targets`, `title` and visibility.
function mapPlatformOptions(d, body, warnings) {
  const o = body.options;
  const vis = {};
  const take = (from, key, to = key) => { if (from && from[key] !== undefined) o[to] = from[key]; };
  const alt = (from) => { if (from?.altText !== undefined && o.altText === undefined) o.altText = from.altText; };

  const yt = d.youTubeOptions;
  if (yt) {
    if (yt.title && !body.title) body.title = yt.title;
    if (yt.visibility) vis.youtube = String(yt.visibility).toLowerCase();
    take(yt, 'tags'); take(yt, 'categoryId'); take(yt, 'madeForKids'); take(yt, 'notifySubscribers');
    if (yt.thumbNail) o.thumbnailUrl = yt.thumbNail;
    if (yt.description) o.description = yt.description;
  }
  const ig = d.instagramOptions;
  if (ig) {
    if (ig.stories) o.story = true;
    if (ig.shareReelsFeed !== undefined) o.shareToFeed = ig.shareReelsFeed;
    alt(ig); take(ig, 'userTags'); take(ig, 'collaborators'); take(ig, 'coverUrl'); take(ig, 'audioName');
    if (ig.locationId) o.instagramLocationId = ig.locationId;
    if (ig.thumbNailOffset !== undefined) o.thumbOffset = ig.thumbNailOffset;
    if (ig.trialParams || ig.trialReel) o.trialReel = true;
  }
  const fb = d.faceBookOptions;
  if (fb) {
    alt(fb);
    if (fb.stories) o.story = true;
    if (fb.link && !body.link) body.link = fb.link;
    if (fb.pageId) body.targets.pageId = fb.pageId;
  }
  const li = d.linkedInOptions;
  if (li) { alt(li); if (li.organizationId) body.targets.linkedinOrganizationId = li.organizationId; }
  const pin = d.pinterestOptions;
  if (pin) {
    if (pin.title && !body.title) body.title = pin.title;
    if (pin.link && !body.link) body.link = pin.link;
    if (pin.boardId) body.targets.boardId = pin.boardId;
    alt(pin);
    if (pin.thumbNail) o.coverImageUrl = pin.thumbNail;
  }
  const tt = d.tikTokOptions;
  if (tt) {
    if (tt.disableComments !== undefined) o.disableComment = tt.disableComments;
    take(tt, 'disableDuet'); take(tt, 'disableStitch');
    if (tt.isAIGenerated !== undefined) o.aiGenerated = tt.isAIGenerated;
    if (tt.thumbNailOffset !== undefined) o.coverTimestampMs = tt.thumbNailOffset;
    if (tt.draft) vis.tiktok = 'draft';
    else if (tt.visibility) vis.tiktok = String(tt.visibility).toLowerCase() === 'public' ? 'public' : 'private';
    if (tt.brandedContent !== undefined) o.brandedContent = tt.brandedContent;
    if (tt.brandOrganic !== undefined) o.yourBrand = tt.brandOrganic;
  }
  const tw = d.twitterOptions;
  if (tw) {
    if (tw.thread) o.thread = true;
    take(tw, 'poll'); take(tw, 'replySettings');
    if (tw.quoteTweetId) o.xQuotePostId = tw.quoteTweetId;
    alt(tw);
  }
  const gmb = d.gmbOptions;
  if (gmb) {
    if (gmb.callToAction?.actionType) o.actionType = gmb.callToAction.actionType;
    if (gmb.callToAction?.url && !body.link) body.link = gmb.callToAction.url;
    take(gmb, 'event'); take(gmb, 'offer');
    if (gmb.locationId) body.targets.locationId = gmb.locationId;
  }
  const tg = d.telegramOptions;
  if (tg?.chatId) body.targets.chatId = tg.chatId;
  const th = d.threadsOptions;
  if (th) { if (th.topicTag) o.topicTag = th.topicTag; alt(th); }
  const bs = d.blueSkyOptions || d.blueskyOptions;
  if (bs) alt(bs);
  if (Object.keys(vis).length) body.visibility_by_channel = vis;
  for (const k of ['redditOptions', 'snapchatOptions']) if (d[k]) warnings.push(`${k} was not applied: Hermoso does not publish to ${k.replace('Options', '')}.`);
}

export class SocialMediaAPI {
  /**
   * @param {string} apiKey  your Hermoso API key (hmk_...). Defaults to process.env.HERMOSO_API_KEY.
   * @param {object} [options]  { baseUrl, waitForPublish (default true), publishTimeoutMs (default 120000), rehostMedia (default true), fetch }
   */
  constructor(apiKey, options = {}) {
    this.hermoso = new HermosoClient({ apiKey, client: 'ayrshare', ...options });
    this.apiKey = this.hermoso.apiKey;
    this.profileKey = null;
    this.twitterByo = null;
    this.waitForPublish = options.waitForPublish !== false;
    this.publishTimeoutMs = options.publishTimeoutMs ?? 120000;
    this.rehostMedia = options.rehostMedia !== false;
  }

  /** Ayrshare's Profile-Key = a Hermoso brand id (from getProfiles). */
  setProfileKey(profileKey) {
    this.profileKey = profileKey || null;
    this.hermoso.setBrand(profileKey || null);
    return this;
  }

  /** Accepted for compatibility and ignored: Hermoso posts to X through the account the brand connected. */
  setTwitterByo(apiKey, apiSecret) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw new TypeError('setTwitterByo: apiKey must be a non-empty string');
    if (typeof apiSecret !== 'string' || !apiSecret.trim()) throw new TypeError('setTwitterByo: apiSecret must be a non-empty string');
    this.twitterByo = { apiKey, apiSecret };
    return this;
  }

  clearTwitterByo() { this.twitterByo = null; return this; }

  /** Escape hatch: any Hermoso tool, `{ text, data }`. */
  callTool(name, args) { return this.hermoso.callTool(name, args); }

  async _safe(fn) {
    try { return await fn(); } catch (e) { return errorResponse(e); }
  }

  // ── POSTS ──────────────────────────────────────────────────────────────────────────────────────────────────
  async post(data = {}) {
    if (Array.isArray(data.profileKeys) && data.profileKeys.length) {
      const { profileKeys, ...rest } = data;
      const posts = [];
      for (const key of profileKeys) {
        const one = new SocialMediaAPI(this.apiKey, { baseUrl: this.hermoso.baseUrl, fetch: this.hermoso.fetch, waitForPublish: this.waitForPublish, publishTimeoutMs: this.publishTimeoutMs, rehostMedia: this.rehostMedia });
        one.setProfileKey(key);
        posts.push({ profileKey: key, ...(await one.post(rest)) });
      }
      return { status: posts.every((p) => p.status !== 'error') ? 'success' : 'error', posts };
    }
    if (data.requiresApproval) throw new HermosoUnsupportedError('post({ requiresApproval })', { tool: 'set_post_refill', hint: 'Hermoso holds posts for approval in its autopilot review queue (mode "review"), not per API post.' });
    if (data.randomPost || data.randomMediaUrl) throw new HermosoUnsupportedError('post({ randomPost })', { tool: 'generate_text', hint: 'Write the caption with generate_text, then post it.' });
    return this._safe(async () => {
      const warnings = [];
      const platforms = Array.isArray(data.platforms) ? data.platforms : data.platforms ? [data.platforms] : [];
      const body = {
        channels: [...new Set(platforms.map(toChannel))],
        caption: data.post ?? '',
        options: {},
        targets: {},
      };
      if (data.title) body.title = data.title;
      let media = Array.isArray(data.mediaUrls) ? data.mediaUrls : data.mediaUrls ? [data.mediaUrls] : [];
      if (this.rehostMedia) media = await Promise.all(media.map((u) => this.hermoso.rehost(u)));
      if (media.length) body.media = media.map((url) => (data.isVideo && media.length === 1 ? { url, type: 'video' } : url));
      if (data.scheduleDate) body.scheduled_at = new Date(data.scheduleDate).toISOString();
      if (data.autoSchedule?.schedule) {
        body.use_queue = true;
        if (data.autoSchedule.title) body.options.useQueue = data.autoSchedule.title;
      }
      if (data.firstComment?.comment) body.first_comment = data.firstComment.comment;
      if (data.shortenLinks) warnings.push('shortenLinks was not applied: Hermoso posts links as given.');
      mapPlatformOptions(data, body, warnings);
      if (!Object.keys(body.options).length) delete body.options;
      if (!Object.keys(body.targets).length) delete body.targets;
      const headers = data.idempotencyKey ? { 'Idempotency-Key': String(data.idempotencyKey) } : {};
      let p = await this.hermoso.request('POST', '/v1/posts', { body, headers });
      if (!body.scheduled_at && !body.use_queue && this.waitForPublish && !TERMINAL.has(p.status)) {
        p = await this.hermoso.waitForPost(p.id, this.publishTimeoutMs);
      }
      const out = postResult(p);
      if (warnings.length) out.warnings = warnings;
      return out;
    });
  }

  async delete(data = {}) {
    if (data.deleteAllScheduled) {
      return this._safe(async () => {
        const posts = await this.hermoso.listPosts({ status: 'scheduled', max: 1000 });
        const bulk = [];
        for (const p of posts) bulk.push(await this._deleteOne(p.id));
        return { status: bulk.every((b) => b.status === 'success') ? 'success' : 'error', bulk };
      });
    }
    if (Array.isArray(data.bulk)) {
      const bulk = [];
      for (const id of data.bulk) bulk.push(await this._deleteOne(id));
      return { status: bulk.every((b) => b.status === 'success') ? 'success' : 'error', bulk };
    }
    return this._deleteOne(data.id);
  }

  async _deleteOne(id) {
    try {
      await this.hermoso.request('DELETE', `/v1/posts/${encodeURIComponent(id)}`);
      return { status: 'success', id, deleted: true };
    } catch (e) {
      if (e instanceof HermosoApiError && e.code === 'post_not_cancellable') {
        let tools = '';
        try {
          const p = await this.hermoso.getPost(id);
          tools = (p.results || []).filter((r) => r.ok).map((r) => `${A(r.channel)}: ${PUBLISHED_DELETE_TOOLS[r.channel] || 'that channel\'s own app'} (post id ${r.id})`).join('; ');
        } catch { /* the hint is optional */ }
        return errorResponse(e, { id, message: `${e.message}${tools ? ` To remove it from the channel, use the Hermoso tool for each: ${tools}.` : ''}` });
      }
      return errorResponse(e, { id });
    }
  }

  updatePost(data = {}) {
    return this._safe(async () => {
      const patch = {};
      if (data.scheduleDate) patch.scheduled_at = new Date(data.scheduleDate).toISOString();
      if (data.post !== undefined) patch.caption = data.post;
      if (data.mediaUrls) patch.media = this.rehostMedia ? await Promise.all([].concat(data.mediaUrls).map((u) => this.hermoso.rehost(u))) : [].concat(data.mediaUrls);
      if (data.platforms) patch.channels = [].concat(data.platforms).map(toChannel);
      const warnings = [];
      for (const k of ['approved', 'notes', 'disableComments']) if (data[k] !== undefined) warnings.push(`${k} was not applied: Hermoso has no equivalent field on a scheduled post.`);
      const p = await this.hermoso.request('PATCH', `/v1/posts/${encodeURIComponent(data.id)}`, { body: patch });
      return { status: 'success', id: p.id, scheduleDate: p.scheduled_at, post: p.caption, ...(warnings.length ? { warnings } : {}), hermoso: p };
    });
  }

  retryPost(data = {}) {
    return this._safe(async () => {
      const r = await this.hermoso.callTool('retry_scheduled', { id: data.id });
      const d = r.data || {};
      return { status: 'success', id: d.id || d.newId || d.post?.id || data.id, message: r.text, hermoso: d };
    });
  }

  getPost(data = {}) {
    return this._safe(async () => ({ status: 'success', ...historyItem(await this.hermoso.getPost(data.id)) }));
  }

  // ── HISTORY ────────────────────────────────────────────────────────────────────────────────────────────────
  history(params = {}) {
    return this._safe(async () => {
      if (params.id) return { status: 'success', ...historyItem(await this.hermoso.getPost(params.id)) };
      if (params.platform) {
        // Ayrshare's history/:platform lists what is ON the network, including posts not made through the API.
        const channel = toChannel(params.platform);
        const r = await this.hermoso.callTool('list_published_posts', { channel, limit: Math.min(200, Number(params.limit || params.lastRecords) || 50) });
        const posts = (r.data?.posts || []).map((row) => ({
          id: row.postId, post: row.caption || '', postUrl: row.url || undefined, created: row.publishedAt ? new Date(row.publishedAt).toISOString() : undefined,
          platform: A(row.channel), mediaUrls: row.mediaUrls || [], deleted: !!row.deleted,
        }));
        return { status: 'success', platform: A(channel), posts, lastUpdated: nowIso() };
      }
      const max = Number(params.lastRecords) > 0 ? Number(params.lastRecords) : 1000;
      let posts = await this.hermoso.listPosts({ max: params.lastDays ? 1000 : max });
      if (params.lastDays) {
        const since = Date.now() - Number(params.lastDays) * 864e5;
        posts = posts.filter((p) => Date.parse(p.scheduled_at || p.created_at || 0) >= since).slice(0, max);
      }
      let history = posts.map(historyItem);
      if (params.status) history = history.filter((h) => h.status === String(params.status));
      if (params.type) history = history.filter((h) => h.type === String(params.type));
      if (params.platforms) { const want = new Set([].concat(params.platforms).map((x) => A(toChannel(x)))); history = history.filter((h) => h.platforms.some((p) => want.has(p))); }
      return { history, refId: this.hermoso.brand || 'default', count: history.length, lastUpdated: nowIso(), nextUpdate: nowIso() };
    });
  }

  // ── MEDIA ──────────────────────────────────────────────────────────────────────────────────────────────────
  media(params = {}) {
    return this._safe(async () => {
      const r = await this.hermoso.request('GET', '/v1/library', { query: { limit: params.limit || 100 } });
      const media = (r.data || []).map((m) => ({ fileName: m.name || m.title || m.id, mediaUrl: m.url || m.image || m.video, contentType: m.type, createdAt: m.created_at, id: m.id }));
      return { status: 'success', media, count: media.length };
    });
  }

  verifyMediaExists(params = {}) {
    return this._safe(async () => {
      const r = await this.hermoso.fetch(params.mediaUrl, { method: 'HEAD', redirect: 'follow' });
      return { status: 'success', mediaExists: r.ok, statusCode: r.status, contentType: r.headers.get('content-type') || undefined };
    });
  }

  mediaUploadUrl(params = {}) {
    return this._safe(async () => {
      const r = await this.hermoso.callTool('upload_file', { getUploadUrl: true, ...(params.fileName ? { name: params.fileName } : {}) });
      const d = r.data || {};
      return {
        status: 'success', uploadUrl: d.uploadUrl, contentType: params.contentType, expiresAt: d.expiresAt,
        accessUrl: null,
        message: 'PUT the raw bytes to uploadUrl with their Content-Type: the response body is {url}, the durable URL to pass in mediaUrls.',
      };
    });
  }

  mediaMeta() { throw new HermosoUnsupportedError('mediaMeta', { tool: 'analyze_video', hint: 'For a video, analyze_video returns its duration and structure.' }); }
  resizeImage() { throw new HermosoUnsupportedError('resizeImage', { tool: 'resize_ad' }); }

  upload(data = {}) {
    return this._safe(async () => {
      if (!data.file) throw new HermosoApiError('upload needs `file`: a base64 string or a data: URI.', { status: 400, code: 'missing_file' });
      const m = await this.hermoso.uploadBytes(data.file, { fileName: data.fileName });
      return { status: 'success', id: m.url, url: m.url, fileName: data.fileName || m.name, description: data.description, type: m.type, size: m.bytes };
    });
  }

  // ── ANALYTICS ──────────────────────────────────────────────────────────────────────────────────────────────
  analyticsLinks() { throw new HermosoUnsupportedError('analyticsLinks', { tool: 'set_tracking_links', hint: 'Hermoso tags links with UTM parameters instead of shortening them; read the clicks in your web analytics.' }); }

  analyticsPost(data = {}) {
    return this._safe(async () => {
      const p = await this.hermoso.getPost(data.id);
      const want = data.platforms ? new Set([].concat(data.platforms).map(toChannel)) : null;
      const out = { status: 'success', id: p.id };
      const rows = [];
      for (const r of (p.results || []).filter((x) => x.ok && (!want || want.has(x.channel)))) {
        if (!rows.length) {
          let cursor;
          for (let i = 0; i < 5; i++) {
            const page = await this.hermoso.callTool('list_published_posts', { limit: 200, ...(cursor ? { cursor } : {}) });
            rows.push(...(page.data?.posts || []));
            cursor = page.data?.nextCursor;
            if (!cursor) break;
          }
        }
        const row = rows.find((x) => x.channel === r.channel && (String(x.postId) === String(r.id) || (r.url && x.url === r.url) || (x.siblingIds || []).includes(String(r.id))));
        const samples = (row?.samples || []).filter((s) => s && s.ok !== false);
        const latest = samples.sort((a, b) => Number(b.at) - Number(a.at))[0];
        out[A(r.channel)] = {
          id: r.id, postUrl: r.url || undefined,
          analytics: latest?.metrics || {},
          lastUpdated: latest?.at ? new Date(Number(latest.at)).toISOString() : undefined,
          ...(latest ? {} : { message: row ? 'Not measured yet: Hermoso reads a post at about 24 hours and again at 7 days (collect_post_metrics reads due posts now).' : 'Hermoso has no record of this post on that channel.' }),
          engagement: row?.engagement,
        };
      }
      return out;
    });
  }

  analyticsSocial(data = {}) {
    return this._safe(async () => {
      const want = data.platforms ? [].concat(data.platforms).map(toChannel) : null;
      const r = await this.hermoso.request('GET', '/v1/analytics/follower-history', { query: { granularity: 'daily' } });
      const out = { status: 'success' };
      for (const acct of (r.accounts || [])) {
        const ch = acct.channel;
        if (want && !want.includes(ch)) continue;
        const pts = acct.points || acct.series || [];
        const last = pts[pts.length - 1] || {};
        out[A(ch)] = { analytics: { followersCount: last.followers ?? last.count ?? acct.followers ?? null, followerChange: last.change ?? null, displayName: acct.account || acct.label || undefined }, lastUpdated: last.date || undefined, hermoso: acct };
      }
      if (want) for (const ch of want) if (!out[A(ch)]) out[A(ch)] = { status: 'error', message: `No follower count recorded for ${A(ch)} yet. Hermoso reads every connected account once a day.` };
      return out;
    });
  }

  // ── USER + PROFILES ────────────────────────────────────────────────────────────────────────────────────────
  user() {
    return this._safe(async () => {
      const [brands, rows, credits] = await Promise.all([this.hermoso.brands(), this.hermoso.accountRows(), this.hermoso.request('GET', '/v1/credits').catch(() => null)]);
      const cur = brands.find((b) => b.current) || brands[0] || {};
      return {
        status: 'success',
        title: cur.name, refId: cur.id, profileKey: brandKeyOf(cur),
        activeSocialAccounts: [...new Set(rows.filter((r) => !r.needsReconnect).map((r) => A(r.channel)))],
        displayNames: rows.map((r) => ({ platform: A(r.channel), displayName: r.label || r.handle || r.name, username: r.handle || r.label || undefined, id: r.ref || undefined, needsReconnect: r.needsReconnect || undefined })),
        ...(credits ? { credits: credits.balance, plan: credits.plan } : {}),
      };
    });
  }

  shorten() { throw new HermosoUnsupportedError('shorten', { tool: 'set_tracking_links' }); }

  createProfile(data = {}) {
    return this._safe(async () => {
      const r = await this.hermoso.callTool('create_brand', { name: data.title || data.name, activate: false });
      const b = r.data?.brand || {};
      return { status: 'success', title: b.name, refId: b.id, profileKey: b.id, created: r.data?.created };
    });
  }

  /** Deleting a brand destroys everything in it, irreversibly, so Hermoso keeps it behind its own confirm step. */
  deleteProfile() {
    throw new HermosoUnsupportedError('deleteProfile', { tool: 'delete_brand', hint: 'It is irreversible and confirm-gated: call delete_brand over MCP (it first reports what the brand holds), or delete the brand in the Hermoso app.' });
  }

  updateProfile(data = {}) {
    return this._safe(async () => {
      const key = data.profileKey || this.profileKey;
      const client = key ? this.hermoso.forBrand(key) : this.hermoso;
      const r = await client.callTool('update_brand', { ...(data.title ? { name: data.title } : {}) });
      return { status: 'success', profileKey: key, title: data.title, message: r.text };
    });
  }

  getProfiles() {
    return this._safe(async () => {
      const [brands] = await Promise.all([this.hermoso.brands()]);
      const profiles = brands.map((b) => ({ title: b.name, profileKey: brandKeyOf(b), refId: b.id, default: !!b.is_default, shared: !!b.shared, role: b.role }));
      return { status: 'success', profiles, count: profiles.length };
    });
  }

  /** Ayrshare's hosted linking page = a Hermoso connect link (one platform per link). */
  generateJWT(data = {}) {
    return this._safe(async () => {
      const client = data.profileKey ? this.hermoso.forBrand(data.profileKey) : this.hermoso;
      const want = [].concat(data.allowedSocial || []).map(toChannel);
      if (!want.length) throw new HermosoApiError('Hermoso connect links connect one platform each: pass allowedSocial, e.g. ["instagram"].', { status: 400, code: 'allowed_social_required', param: 'allowedSocial' });
      const chs = await client.channels();
      const providers = [...new Set(want.map((c) => chs.find((x) => x.id === c)?.connector || c))];
      const minutes = data.expiresIn ? Math.min(2880, Math.max(5, Number(data.expiresIn))) : 60;
      const links = [];
      for (const provider of providers) {
        links.push(await client.request('POST', '/v1/connect-links', { body: { provider, ...(data.redirect ? { redirect_url: data.redirect } : {}), expires_in_minutes: minutes } }));
      }
      return { status: 'success', title: data.title, token: links[0].id, url: links[0].url, emailSent: false, expiresIn: `${minutes}m`, links: links.map((l) => ({ platform: l.provider, url: l.url, id: l.id, expiresAt: l.expires_at })) };
    });
  }

  unlinkSocial(data = {}) {
    return this._safe(async () => {
      const channel = toChannel(data.platform);
      const ch = (await this.hermoso.channels()).find((c) => c.id === channel);
      const provider = ch?.connector || channel;
      const r = await this.hermoso.request('DELETE', `/v1/connections/${encodeURIComponent(provider)}`, { query: data.account ? { account: data.account } : {} });
      return { status: 'success', platform: data.platform, message: r.note };
    });
  }

  // ── AUTO-SCHEDULE (posting queues) ─────────────────────────────────────────────────────────────────────────
  setAutoSchedule(data = {}) {
    return this._safe(async () => {
      const slots = [].concat(data.schedule || []).map((t) => String(t).replace(/Z$/i, '').slice(0, 5));
      const r = await this.hermoso.callTool('manage_post_queues', { action: 'save', name: data.title || 'Default', slots, timezone: 'UTC' });
      return { status: 'success', title: data.title || 'default', schedule: data.schedule, message: r.text };
    });
  }

  deleteAutoSchedule(data = {}) {
    return this._safe(async () => {
      const r = await this.hermoso.callTool('manage_post_queues', { action: 'delete', name: data.title || 'Default' });
      return { status: 'success', title: data.title || 'default', message: r.text };
    });
  }

  listAutoSchedule() {
    return this._safe(async () => {
      const r = await this.hermoso.callTool('manage_post_queues', { action: 'list' });
      const schedules = (r.data?.queues || []).map((q) => ({ title: q.isDefault ? 'default' : q.name, schedule: (q.slots || []).map((s) => `${s}${q.timezone === 'UTC' ? 'Z' : ''}`), timezone: q.timezone, days: q.days, channels: q.channels }));
      return { status: 'success', autoSchedules: schedules };
    });
  }

  // ── WEBHOOKS (one webhook per brand in Hermoso; Ayrshare actions map to event groups) ─────────────────────
  static ACTION_EVENTS = { social: ['connections'], scheduled: ['posts'], messages: ['message.received'], comments: ['comment.received'], reviews: ['reviews'], mentions: ['mentions'] };

  async _webhookState() {
    const s = await webhookSink(this.hermoso);
    return { ...s, events: s.groupsSelected };
  }

  registerWebhook(data = {}) {
    return this._safe(async () => {
      const events = SocialMediaAPI.ACTION_EVENTS[data.action];
      if (!events) throw new HermosoApiError(`Unknown webhook action "${data.action}". Hermoso maps: ${Object.keys(SocialMediaAPI.ACTION_EVENTS).join(', ')}.`, { status: 400, code: 'unknown_action', param: 'action' });
      const cur = await this._webhookState();
      let secret;
      if (!cur.connected || data.url) {
        await this.hermoso.callTool('connect_connector', { provider: 'webhook', fields: { webhookUrl: data.url } });
        if (!cur.connected) secret = await freshSecret(this.hermoso);
      }
      const have = cur.connected && Array.isArray(cur.events) ? cur.events : [];
      const r = await this.hermoso.callTool('set_alert_events', { provider: 'webhook', events: [...new Set([...have, ...events])] });
      return { status: 'success', action: data.action, url: data.url, events: r.data?.events, ...(secret ? { secret } : {}), message: r.text };
    });
  }

  unregisterWebhook(data = {}) {
    return this._safe(async () => {
      const cur = await this._webhookState();
      const drop = new Set(SocialMediaAPI.ACTION_EVENTS[data.action] || []);
      const keep = (cur.events || []).filter((e) => !drop.has(e));
      if (!keep.length || !data.action) {
        const r = await this.hermoso.callTool('disconnect_connector', { provider: 'webhook', confirm: true });
        return { status: 'success', action: data.action, message: r.text };
      }
      const r = await this.hermoso.callTool('set_alert_events', { provider: 'webhook', events: keep });
      return { status: 'success', action: data.action, message: r.text };
    });
  }

  listWebhooks() {
    return this._safe(async () => {
      const s = await this._webhookState();
      if (!s.connected) return { status: 'success', webhooks: [] };
      const have = new Set([...(s.groupsSelected || []), ...(s.eventNames || [])]);
      const actions = Object.entries(SocialMediaAPI.ACTION_EVENTS).filter(([, ev]) => ev.every((e) => have.has(e))).map(([a]) => a);
      return { status: 'success', webhooks: [{ actions, events: s.eventNames, state: s.state, signed: s.signed, lastDeliveredAt: s.lastDeliveredAt }] };
    });
  }

  getBrandByUser() { throw new HermosoUnsupportedError('getBrandByUser', { tool: 'fetch_social_data' }); }

  // ── FEEDS (RSS) ────────────────────────────────────────────────────────────────────────────────────────────
  feedAdd() { throw new HermosoUnsupportedError('feedAdd', { tool: 'set_post_refill', hint: 'Hermoso has no RSS auto-post; its autopilot (set_post_refill) makes and schedules new posts on a cadence.' }); }
  feedDelete() { throw new HermosoUnsupportedError('feedDelete', { tool: 'set_post_refill' }); }
  feedGet() { throw new HermosoUnsupportedError('feedGet', { tool: 'get_post_refill' }); }
  feedUpdate() { throw new HermosoUnsupportedError('feedUpdate', { tool: 'set_post_refill' }); }

  // ── COMMENTS ───────────────────────────────────────────────────────────────────────────────────────────────
  async _platformPosts(id, platforms) {
    const p = await this.hermoso.getPost(id);
    const want = platforms ? new Set([].concat(platforms).map(toChannel)) : null;
    return (p.results || []).filter((r) => r.ok && r.id && (!want || want.has(r.channel)));
  }

  postComment(data = {}) {
    return this._safe(async () => {
      const out = { status: 'success', commentIds: [] };
      for (const r of await this._platformPosts(data.id, data.platforms)) {
        const t = COMMENT_TOOLS[r.channel];
        if (!t?.comment) { out.commentIds.push({ platform: A(r.channel), status: 'error', message: `Hermoso cannot comment on ${A(r.channel)} posts.` }); continue; }
        const args = r.channel === 'tiktok' ? { videoId: r.id, text: data.comment }
          : r.channel === 'linkedin' ? { postUrn: r.id, text: data.comment }
          : r.channel === 'threads' ? { replyToId: r.id, text: data.comment }
          : { postId: r.id, message: data.comment };
        try {
          const res = await this.hermoso.callTool(t.comment, args);
          out.commentIds.push({ platform: A(r.channel), status: 'success', commentId: res.data?.id || res.data?.commentId || res.data?.comment?.id, id: r.id });
        } catch (e) { out.status = 'error'; out.commentIds.push({ platform: A(r.channel), ...errorResponse(e) }); }
      }
      return out;
    });
  }

  getComments(params = {}) {
    return this._safe(async () => {
      const out = { status: 'success', id: params.id };
      for (const r of await this._platformPosts(params.id, params.platforms || params.platform)) {
        const t = COMMENT_TOOLS[r.channel];
        if (!t) { out[A(r.channel)] = { status: 'error', message: `Hermoso cannot read ${A(r.channel)} comments.` }; continue; }
        const args = r.channel === 'youtube' || r.channel === 'tiktok' ? { videoId: r.id } : r.channel === 'linkedin' ? { postUrn: r.id } : { postId: r.id };
        try {
          const res = await this.hermoso.callTool(t.list, args);
          const d = res.data || {};
          const list = d.comments || d.replies || d.items || d.data || [];
          out[A(r.channel)] = list.map((c) => ({ commentId: c.id || c.commentId || c.urn, comment: c.text ?? c.message ?? c.comment, created: c.createdAt || c.created_time || c.timestamp || c.publishedAt, userName: c.author || c.username || c.from?.name, likeCount: c.likeCount ?? c.like_count, platform: A(r.channel), raw: c }));
        } catch (e) { out[A(r.channel)] = errorResponse(e); }
      }
      return out;
    });
  }

  deleteComments(params = {}) {
    return this._safe(async () => {
      const channel = toChannel(params.platform);
      const t = COMMENT_TOOLS[channel];
      const commentId = params.commentId || params.id;
      if (!t || !params.platform) throw new HermosoUnsupportedError('deleteComments without { platform, commentId }', { tool: 'moderate_meta_comment', hint: 'Pass the platform and the platform comment id from getComments.' });
      const args = channel === 'linkedin' ? { postUrn: params.postId, commentId, confirm: true }
        : channel === 'threads' ? { replyId: commentId, hide: true }
        : channel === 'tiktok' ? { commentId, action: 'DELETE', confirm: true, ...(params.postId ? { videoId: params.postId } : {}) }
        : { commentId, action: 'delete', confirm: true };
      const r = await this.hermoso.callTool(t.moderate, args);
      return { status: 'success', platform: params.platform, commentId, message: r.text };
    });
  }

  replyComment(params = {}) {
    return this._safe(async () => {
      const out = { status: 'success', commentId: params.commentId, replies: [] };
      for (const pl of [].concat(params.platforms || params.platform || [])) {
        const channel = toChannel(pl);
        const t = COMMENT_TOOLS[channel];
        if (!t?.reply) { out.replies.push({ platform: A(channel), status: 'error', message: `Hermoso cannot reply to ${A(channel)} comments.` }); continue; }
        const args = channel === 'tiktok' ? { videoId: params.postId || params.id, commentId: params.commentId, text: params.comment }
          : channel === 'youtube' ? { commentId: params.commentId, text: params.comment }
          : channel === 'linkedin' ? { postUrn: params.postId || params.id, parentComment: params.commentId, text: params.comment }
          : channel === 'threads' ? { replyToId: params.commentId, text: params.comment }
          : { commentId: params.commentId, message: params.comment };
        try {
          const r = await this.hermoso.callTool(t.reply, args);
          out.replies.push({ platform: A(channel), status: 'success', commentId: r.data?.id || r.data?.commentId, message: r.text });
        } catch (e) { out.status = 'error'; out.replies.push({ platform: A(channel), ...errorResponse(e) }); }
      }
      return out;
    });
  }

  // ── GENERATE (paid: billed as Hermoso credits) ─────────────────────────────────────────────────────────────
  async _write(prompt) {
    const r = await this.hermoso.callTool('generate_text', { prompt });
    return String(r.data?.text ?? r.data?.output ?? r.text ?? '').trim();
  }

  generatePost(params = {}) {
    return this._safe(async () => {
      const extras = [params.hashtags ? 'Add relevant hashtags.' : 'No hashtags.', params.emojis ? 'Use a few emojis.' : 'No emojis.', params.twitter ? 'Keep it under 280 characters.' : ''].join(' ');
      const post = await this._write(`Write one social media post about the following. ${extras} Answer with the post text only.\n\n${params.text || ''}`);
      return { status: 'success', post };
    });
  }

  generateRewrite(params = {}) {
    return this._safe(async () => {
      const n = Math.min(10, Math.max(1, Number(params.rewrites) || 1));
      const txt = await this._write(`Rewrite this social media post ${n} different way(s). ${params.hashtags ? 'Keep or add hashtags.' : 'No hashtags.'} ${params.emojis ? 'Emojis are fine.' : 'No emojis.'} ${params.twitter ? 'Each under 280 characters.' : ''} Separate the versions with a line containing only ---. Answer with the versions only.\n\n${params.post || ''}`);
      const posts = txt.split(/\n\s*-{3,}\s*\n/).map((s) => s.trim()).filter(Boolean).slice(0, n);
      return { status: 'success', posts };
    });
  }

  generateTranslation(params = {}) {
    return this._safe(async () => {
      const translatedText = await this._write(`Translate the following into the language with code "${params.lang}". Answer with the translation only.\n\n${params.text || ''}`);
      return { status: 'success', originalText: params.text, translatedText, language: params.lang };
    });
  }

  generateTranscription(params = {}) {
    return this._safe(async () => {
      const r = await this.hermoso.callTool('analyze_video', { url: params.videoUrl || params.url });
      return { status: 'success', transcription: r.data?.transcript ?? r.text, hermoso: r.data };
    });
  }

  generateAltText() { throw new HermosoUnsupportedError('generateAltText', { tool: 'generate_text', hint: 'Pass your own description as options.altText on the post (POST /v1/posts), or write one with generate_text.' }); }
  autoHashtags() { throw new HermosoUnsupportedError('autoHashtags', { tool: 'generate_text' }); }
  recommendHashtags() { throw new HermosoUnsupportedError('recommendHashtags', { tool: 'tiktok_hashtag_suggestions' }); }
  checkBannedHashtags() { throw new HermosoUnsupportedError('checkBannedHashtags', { tool: 'check_ad_policy' }); }
  shortLink() { throw new HermosoUnsupportedError('shortLink', { tool: 'set_tracking_links' }); }
  shortLinkAnalytics() { throw new HermosoUnsupportedError('shortLinkAnalytics', { tool: 'set_tracking_links' }); }

  // ── REVIEWS (Google Business Profile = "gmb", Facebook Page recommendations = "facebook") ────────────────────
  reviews(params = {}) {
    return this._safe(async () => {
      const channel = toChannel(params.platform || 'gmb');
      const r = channel === 'facebook'
        ? await this.hermoso.callTool('meta_page_reviews', { action: 'list' })
        : await this.hermoso.callTool('list_google_business_reviews', {});
      const list = r.data?.reviews || r.data?.items || [];
      return { status: 'success', platform: A(channel), reviews: list.map((x) => ({ id: x.id || x.reviewId || x.name, rating: x.rating ?? x.starRating, review: x.text ?? x.comment ?? x.review_text, reviewer: x.reviewer?.displayName || x.reviewer || x.author, created: x.createTime || x.created_time || x.createdAt, reply: x.reply?.comment ?? x.reply, raw: x })), averageRating: r.data?.averageRating, totalReviewCount: r.data?.totalReviewCount };
    });
  }

  async review(params = {}) {
    const all = await this.reviews(params);
    if (all.status !== 'success') return all;
    const one = all.reviews.find((x) => String(x.id) === String(params.id) || String(x.id).endsWith(`/${params.id}`));
    return one ? { status: 'success', ...one } : { status: 'error', code: 'review_not_found', message: `No review ${params.id} on ${all.platform}.` };
  }

  replyReview(params = {}) {
    return this._safe(async () => {
      const channel = toChannel(params.platform || 'gmb');
      const r = channel === 'facebook'
        ? await this.hermoso.callTool('meta_page_reviews', { action: 'reply', reviewId: params.reviewId, text: params.reply, confirm: true })
        : await this.hermoso.callTool('reply_to_google_business_review', { reviewId: params.reviewId, comment: params.reply });
      return { status: 'success', platform: A(channel), reviewId: params.reviewId, reply: params.reply, message: r.text };
    });
  }

  deleteReplyReview(params = {}) {
    if (toChannel(params.platform || 'gmb') !== 'google_business') throw new HermosoUnsupportedError('deleteReplyReview (facebook)', { tool: 'meta_page_reviews', hint: 'Meta offers no delete for a review reply.' });
    return this._safe(async () => {
      const r = await this.hermoso.callTool('reply_to_google_business_review', { reviewId: params.reviewId, delete: true, confirm: true });
      return { status: 'success', platform: 'gmb', reviewId: params.reviewId, message: r.text };
    });
  }
}

export { HermosoApiError, HermosoUnsupportedError };
export default SocialMediaAPI;
