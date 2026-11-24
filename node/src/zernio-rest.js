// Zernio's REST routes, served by Hermoso. Both the Node and the Python Zernio layers resolve every call to
// `zernioRoute(hermoso, method, path, { query, body, headers })`, which answers with the body Zernio's endpoint would
// answer, or throws. The route table at the bottom is also the migration map for people who call Zernio's REST API
// directly (README: "Zernio REST → Hermoso REST").
//
// Unofficial: written by Hermoso, not affiliated with or endorsed by Zernio.

import { HermosoApiError, HermosoUnsupportedError, toChannel, fromChannel, splitAccountId, PUBLISHED_DELETE_TOOLS, COMMENT_TOOLS, TERMINAL, brandKeyOf } from './core.js';

const Z = (c) => fromChannel(c, 'zernio');
const TARGET_FIELD = { facebook: 'pageId', instagram: 'pageId', threads: 'pageId', linkedin: 'linkedinOrganizationId', google_business: 'locationId', telegram: 'chatId', pinterest: 'boardId', whop: 'whopExperienceId' };

// Zernio webhook events → Hermoso alert events (exact names or groups). Anything else is reported back as not delivered.
export const ZERNIO_EVENTS = {
  'post.published': 'post.published', 'post.failed': 'post.failed', 'post.partial': 'post.partial',
  'post.platform.published': 'post.channel.published', 'post.platform.failed': 'post.channel.failed', 'post.platform.deleted': 'post.deleted',
  'account.connected': 'account.connected', 'account.disconnected': 'account.disconnected', 'account.permissions_changed': 'account.permissions_changed',
  'account.restricted': 'account.broken', 'comment.received': 'comment.received', 'message.received': 'message.received',
  'mention.received': 'mention.received', 'review.new': 'review.received', 'lead.received': 'lead.created',
  'ad.review.rejected': 'ad.rejected', 'ad.delivery_issue': 'ad.delivery_issue', 'campaign.budget.depleted': 'budget.exhausted', 'balance.low': 'credits.low',
};
const FROM_HERMOSO_EVENT = Object.fromEntries(Object.entries(ZERNIO_EVENTS).map(([z, h]) => [h, z]));

function zStatus(s) {
  return ({ scheduled: 'scheduled', processing: 'publishing', published: 'published', partially_published: 'partial', failed: 'failed', indeterminate: 'failed' })[s] || s;
}

/** A Hermoso post → a Zernio Post. */
export function zPost(p) {
  const results = Array.isArray(p.results) ? p.results : [];
  return {
    _id: p.id,
    title: p.title || null,
    content: p.caption ?? '',
    mediaItems: (p.media || []).map((m) => ({ type: m.type || 'image', url: m.url })),
    platforms: (p.channels || []).map((ch) => {
      const r = results.find((x) => x.channel === ch);
      const field = TARGET_FIELD[ch];
      const ref = field && p.targets?.[field] ? p.targets[field] : null;
      return {
        platform: Z(ch),
        accountId: ref ? `${ch}:${ref}` : ch,
        customContent: p.captions_by_channel?.[ch] ?? null,
        status: r ? (r.ok ? 'published' : 'failed') : (p.status === 'scheduled' ? 'scheduled' : zStatus(p.status)),
        ...(r?.id ? { platformPostId: r.id } : {}),
        platformPostUrl: r?.url ?? null,
        ...(r?.ok ? { publishedAt: p.scheduled_at } : {}),
        ...(r && !r.ok ? { errorMessage: r.error, errorSource: 'platform' } : {}),
      };
    }),
    scheduledFor: p.scheduled_at,
    timezone: 'UTC',
    status: zStatus(p.status),
    visibility: p.visibility,
    metadata: { hermosoStatus: p.status, ...(p.status_detail ? { statusDetail: p.status_detail } : {}) },
    createdAt: p.created_at,
    updatedAt: p.created_at,
  };
}

function zProfile(b) {
  return { _id: brandKeyOf(b), name: b.name, isDefault: !!b.is_default, description: '', timezone: null, role: b.role, shared: !!b.shared };
}

function zAccount(r, profileId) {
  return {
    _id: r.accountId, platform: Z(r.channel), profileId: profileId || 'default', username: r.handle || r.label || undefined,
    displayName: r.label || r.handle || r.name, platformUserId: r.ref || undefined, isActive: !r.needsReconnect,
    needsReconnection: r.needsReconnect, enabled: true, profilePicture: null,
  };
}

// Zernio `platforms[].platformSpecificData` (and the top-level tiktokSettings) → Hermoso fields. Unmapped keys are
// listed in warnings rather than silently dropped.
const PSD_SKIP = new Set(['contentType']);
function applyPlatformData(ch, d, body, warnings) {
  if (!d || typeof d !== 'object') return;
  const o = body.options;
  for (const [k, v] of Object.entries(d)) {
    switch (k) {
      case 'title': if (!body.title) body.title = v; break;
      case 'youtubeTitle': if (!body.title) body.title = v; break;
      case 'visibility': case 'privacyStatus': (body.visibility_by_channel ||= {})[ch] = String(v).toLowerCase(); break;
      case 'privacy_level': case 'privacyLevel': if (ch === 'tiktok') o.privacyLevel = v; else (body.visibility_by_channel ||= {})[ch] = /PUBLIC/i.test(v) ? 'public' : 'private'; break;
      case 'firstComment': body.first_comment = v; break;
      case 'boardId': case 'pageId': case 'locationId': case 'chatId': case 'organizationId':
        body.targets[k === 'organizationId' ? 'linkedinOrganizationId' : k] = v; break;
      case 'description': case 'tags': case 'categoryId': case 'madeForKids': case 'collaborators': case 'userTags': case 'altText':
      case 'coverUrl': case 'audioName': case 'link': case 'topicTag': case 'replySettings': case 'poll':
        if (k === 'link' && !body.link) body.link = v; else o[k] = v; break;
      case 'containsSyntheticMedia': case 'isAiGenerated': o.aiGenerated = !!v; break;
      case 'disable_comment': case 'disableComment': o.disableComment = v; break;
      case 'disable_duet': case 'disableDuet': o.disableDuet = v; break;
      case 'disable_stitch': case 'disableStitch': o.disableStitch = v; break;
      case 'shareToFeed': o.shareToFeed = v; break;
      case 'threadItems': o.thread = (v || []).map((x) => x.content ?? x); break;
      case 'trialParams': o.trialReel = true; break;
      default:
        if (PSD_SKIP.has(k)) { if (k === 'contentType' && v === 'story') o.story = true; break; }
        warnings.push(`platformSpecificData.${k} (${Z(ch)}) was not applied: Hermoso has no direct equivalent. Pass Hermoso's own field in metadata.hermosoOptions.`);
    }
  }
}

async function buildPostBody(h, b, { forUpdate = false } = {}) {
  const warnings = [];
  const body = { options: {}, targets: {} };
  const platforms = Array.isArray(b.platforms) ? b.platforms : [];
  if (platforms.length || !forUpdate) body.channels = [];
  const accounts = {};
  for (const t of platforms) {
    const { channel, ref } = splitAccountId(t.accountId, t.platform);
    const ch = toChannel(t.platform || channel);
    if (!body.channels.includes(ch)) body.channels.push(ch);
    if (ref) {
      const sel = await h.accountSelector(ch, ref);
      if (sel?.kind === 'target') body.targets[sel.field] = sel.value;
      else if (sel?.kind === 'accounts') (accounts[ch] ||= []).push(sel.value);
    }
    if (t.customContent != null || t.platformSpecificContent != null) (body.captions_by_channel ||= {})[ch] = t.customContent ?? t.platformSpecificContent;
    if (t.customMedia?.length) warnings.push(`customMedia (${Z(ch)}) was not applied: a Hermoso post carries one set of media for every channel. Send a separate post for that channel.`);
    if (t.scheduledFor) warnings.push(`platforms[].scheduledFor (${Z(ch)}) was not applied: a Hermoso post has one time. Send a separate post for that channel.`);
    applyPlatformData(ch, t.platformSpecificData, body, warnings);
    if (t.youtubeTitle && !body.title) body.title = t.youtubeTitle;
  }
  if (Object.keys(accounts).length) body.options.accounts = accounts;
  if (b.tiktokSettings) applyPlatformData('tiktok', b.tiktokSettings, body, warnings);
  if (b.content !== undefined) body.caption = b.content;
  if (b.title) body.title = b.title;
  const items = Array.isArray(b.mediaItems) ? b.mediaItems : (Array.isArray(b.mediaUrls) ? b.mediaUrls.map((url) => ({ url })) : null);
  if (items) {
    body.media = [];
    for (const m of items) {
      const url = h.rehostMedia === false || b.dryRun ? m.url : await h.rehost(m.url);
      body.media.push(m.type === 'video' || m.type === 'image' ? { url, type: m.type } : url);
      if (m.altText && body.options.altText === undefined) body.options.altText = m.altText;
    }
  }
  if (b.visibility) body.visibility = b.visibility;
  if (b.hashtags?.length || b.mentions?.length) warnings.push('hashtags/mentions arrays were not applied: write them into content.');
  if (b.metadata?.hermosoOptions && typeof b.metadata.hermosoOptions === 'object') Object.assign(body.options, b.metadata.hermosoOptions);
  for (const k of ['recycling', 'externalId', 'requiresApproval', 'crosspostingEnabled', 'facebookSettings']) if (b[k] !== undefined && b[k] !== null && b[k] !== false && b[k] !== true) warnings.push(`${k} was not applied.`);
  if (b.requiresApproval) warnings.push('requiresApproval was not applied: Hermoso holds posts for approval only in its autopilot review queue.');
  if (!Object.keys(body.options).length) delete body.options;
  if (!Object.keys(body.targets).length) delete body.targets;
  return { body, warnings };
}

function notFound(what) { return new HermosoApiError(`${what} not found.`, { status: 404, code: 'not_found' }); }

async function dryRunCheck(h, body) {
  const chs = await h.channels();
  const errors = [];
  for (const ch of body.channels || []) {
    const c = chs.find((x) => x.id === ch);
    if (!c) { errors.push({ platform: Z(ch), error: `Hermoso does not publish to ${ch}.` }); continue; }
    if (!c.available) errors.push({ platform: Z(ch), error: c.unavailable_reason || 'Not available yet.' });
    else if (!c.connected) errors.push({ platform: Z(ch), error: `${c.name} is not connected for this profile.` });
    const text = body.captions_by_channel?.[ch] ?? body.caption ?? '';
    if (c.caption_max && [...text].length > c.caption_max) errors.push({ platform: Z(ch), error: `Content is ${[...text].length} characters; ${c.name} allows ${c.caption_max}.` });
    const n = (body.media || []).length;
    if (n > 1 && !c.carousel) errors.push({ platform: Z(ch), error: c.carousel_unsupported_reason || `${c.name} takes one media item.` });
    else if (n > 1 && c.carousel?.effective_max && n > c.carousel.effective_max) errors.push({ platform: Z(ch), error: `${c.name} takes at most ${c.carousel.effective_max} media items.` });
  }
  return { valid: errors.length === 0, errors };
}

async function queues(h) {
  const r = await h.callTool('manage_post_queues', { action: 'list' });
  return { list: r.data?.queues || [], weekdays: r.data?.weekdays || ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] };
}
function zQueue(q, weekdays, profileId) {
  const slots = [];
  for (let d = 0; d < 7; d++) {
    const times = q.days && Array.isArray(q.days[weekdays[d]]) ? q.days[weekdays[d]] : (q.slots || []);
    for (const t of times) slots.push({ dayOfWeek: d, time: t });
  }
  return { _id: q.id || q.name, profileId: profileId || 'default', name: q.name, timezone: q.timezone, slots, active: true, isDefault: !!q.isDefault, channels: q.channels };
}
function toQueueArgs(b, weekdays) {
  // Every weekday is sent explicitly, so a save fully replaces the previous per-day times.
  const days = {};
  for (const w of weekdays) days[w] = [];
  for (const s of b.slots || []) days[weekdays[Number(s.dayOfWeek) % 7]].push(String(s.time).slice(0, 5));
  const all = Object.values(days).map((x) => [...x].sort());
  const same = all.every((x) => JSON.stringify(x) === JSON.stringify(all[0]));
  return { slots: same ? all[0] : [], days };
}

// The webhook sink, with its event GROUPS expanded to event names, plus its recent deliveries.
export async function webhookSink(h) {
  const r = await h.callTool('list_alert_settings', { catalog: true });
  const sink = (r.data?.sinks || []).find((s) => s.provider === 'webhook') || { connected: false };
  const groups = Object.fromEntries((r.data?.catalog?.groups || []).map((g) => [g.key, g.events || []]));
  const names = [...new Set((sink.events || []).flatMap((e) => groups[e] || [e]))];
  const deliveries = (r.data?.deliveries || []).filter((d) => d.provider === 'webhook');
  return { ...sink, groupsSelected: sink.events || [], eventNames: names, deliveries };
}
/** A freshly connected webhook's signing secret (Hermoso shows it once, so the compat layer mints the copy it returns). */
export async function freshSecret(h) {
  try { const r = await h.callTool('rotate_webhook_signing_secret', {}); return r.data?.signingSecret || undefined; } catch { return undefined; }
}
function zWebhook(s) {
  return s.connected ? [{ _id: 'webhook', name: 'Hermoso webhook', events: s.eventNames.map((e) => FROM_HERMOSO_EVENT[e] || e), isActive: s.eventNames.length > 0, signed: s.signed, state: s.state, lastFiredAt: s.lastDeliveredAt }] : [];
}
function toHermosoEvents(events = []) {
  const out = []; const dropped = [];
  for (const e of events) { if (ZERNIO_EVENTS[e]) out.push(ZERNIO_EVENTS[e]); else dropped.push(e); }
  return { events: [...new Set(out)], dropped };
}

async function commentTarget(h, postId, accountId) {
  // postId is a platform post id with accountId naming the account, or a Hermoso post id.
  if (/^job_/.test(String(postId))) {
    const p = await h.getPost(postId);
    const r = (p.results || []).find((x) => x.ok && (!accountId || x.channel === splitAccountId(accountId).channel));
    if (!r) throw notFound(`A published platform post for ${postId}`);
    return { channel: r.channel, id: r.id };
  }
  const { channel } = splitAccountId(accountId);
  if (!channel) throw new HermosoApiError('accountId is required to tell which platform the post is on.', { status: 400, code: 'missing_account_id', param: 'accountId' });
  return { channel, id: String(postId) };
}

const NS_TOOLS = {
  whatsapp: 'send_whatsapp_message', whatsapptemplates: 'send_whatsapp_message', broadcasts: 'send_whatsapp_broadcast', sms: 'send_sms', email: 'send_email',
  messages: 'list_inbox', contacts: 'list_contacts', adcampaigns: 'create_meta_campaign', adinsights: 'meta_insights', adcreatives: 'create_meta_ad',
  reddit: 'search_reddit', mentions: 'x_mentions', users: 'list_team', invites: 'invite_member', logs: 'list_jobs', usage: 'hermoso_credits',
};
export function unsupported(ns, method) {
  const special = {
    'posts.editPost': 'manage_meta_post', 'posts.pinPost': 'manage_meta_post', 'posts.unpinPost': 'manage_meta_post', 'posts.bulkUploadPosts': 'import_posts_csv',
    'posts.unpublishPost': 'manage_meta_post', 'profiles.deleteProfile': 'delete_brand', 'profiles.getProfileLimits': 'get_credit_limits',
    'analytics.getInstagramAccountInsights': 'instagram_insights', 'analytics.getYouTubeChannelInsights': 'youtube_channel_report', 'analytics.getLinkedInOrgAggregateAnalytics': 'linkedin_page_analytics',
    'analytics.getTikTokAccountInsights': 'tiktok_account_insights', 'analytics.getFacebookPageInsights': 'meta_page_insights', 'analytics.getGoogleBusinessPerformance': 'google_business_insights',
    'analytics.getPinterestAccountInsights': 'pinterest_analytics', 'analytics.getLinkedInPostAnalytics': 'list_published_posts', 'analytics.runGoogleAnalyticsReport': 'analytics_report',
    'queue.getNextQueueSlot': 'manage_post_queues', 'queue.previewQueue': 'manage_post_queues', 'media.prepareMedia': 'upload_file', 'comments.listInboxComments': 'list_inbox',
    'comments.likeInboxComment': 'moderate_tiktok_comment', 'comments.pinInboxComment': 'moderate_tiktok_comment', 'accounts.updateAccount': 'set_connector_accounts',
    'accounts.moveAccountToProfile': 'set_connector_accounts', 'comments.editInboxComment': 'list_inbox',
  };
  return new HermosoUnsupportedError(`zernio.${ns}.${method}`, { tool: special[`${ns}.${method}`] || NS_TOOLS[ns.toLowerCase()] || null });
}

// ── THE ROUTES ──────────────────────────────────────────────────────────────────────────────────────────────────
// key: "METHOD /zernio/path/{param}" → handler(h, params, query, body, headers). `profileId` (query or body) selects
// the Hermoso brand for that call.
export const ROUTES = {
  // POSTS
  'GET /v1/posts': async (h, p, q) => {
    let posts = await h.listPosts({ max: 1000, channel: q.platform ? toChannel(q.platform) : undefined });
    if (q.status) posts = posts.filter((x) => zStatus(x.status) === q.status);
    const from = q.dateFrom || q.fromDate; const to = q.dateTo || q.toDate;
    if (from) posts = posts.filter((x) => Date.parse(x.scheduled_at || 0) >= Date.parse(from));
    if (to) posts = posts.filter((x) => Date.parse(x.scheduled_at || 0) <= Date.parse(to));
    if (q.search) posts = posts.filter((x) => String(x.caption || '').toLowerCase().includes(String(q.search).toLowerCase()));
    if (/asc/.test(q.sortBy || '')) posts.reverse();
    const limit = Math.max(1, Math.min(100, Number(q.limit) || 10));
    const page = Math.max(1, Number(q.page) || 1);
    const slice = posts.slice((page - 1) * limit, page * limit);
    return { posts: slice.map(zPost), pagination: { page, limit, total: posts.length, pages: Math.ceil(posts.length / limit), nextCursor: page * limit < posts.length ? String(page + 1) : null } };
  },
  'POST /v1/posts': async (h, p, q, b, headers) => {
    if (b.isDraft || (!b.publishNow && !b.scheduledFor && !b.queuedFromProfile && !b.queueId && !b.dryRun)) {
      throw new HermosoUnsupportedError('zernio.posts.createPost (draft)', { tool: 'schedule_post', hint: 'Hermoso has no unscheduled draft post. Pass publishNow: true or scheduledFor (you can edit or cancel a scheduled post until it fires), or queuedFromProfile to take the next queue slot.' });
    }
    const { body, warnings } = await buildPostBody(h, b);
    const now = b.publishNow || (b.scheduledFor && Date.parse(b.scheduledFor) <= Date.now() + 60_000);
    if (!now && b.scheduledFor) body.scheduled_at = new Date(b.scheduledFor).toISOString();
    if (!now && !b.scheduledFor && (b.queuedFromProfile || b.queueId)) {
      body.use_queue = true;
      if (b.queueId && b.queueId !== 'default') (body.options ||= {}).useQueue = b.queueId;
    }
    if (b.timezone && body.use_queue) body.timezone = b.timezone;
    if (b.dryRun) {
      const v = await dryRunCheck(h, body);
      return { message: v.valid ? 'Dry run passed. Nothing was created.' : 'Dry run failed. Nothing was created.', dryRun: true, valid: v.valid, errors: v.errors, warnings, hermosoRequest: body };
    }
    const hk = headers?.['Idempotency-Key'] || headers?.['idempotency-key'];
    let post = await h.request('POST', '/v1/posts', { body, headers: hk ? { 'Idempotency-Key': String(hk) } : {} });
    if (now && h.waitForPublish !== false && !TERMINAL.has(post.status)) post = await h.waitForPost(post.id, h.publishTimeoutMs ?? 300000);
    const message = post.status === 'scheduled' ? 'Post scheduled successfully' : post.status === 'published' ? 'Post published successfully' : post.status === 'processing' ? 'Post is publishing' : 'Post did not publish on every platform';
    return { message, post: zPost(post), ...(warnings.length ? { warnings } : {}) };
  },
  'GET /v1/posts/{postId}': async (h, p) => ({ post: zPost(await h.getPost(p.postId)) }),
  'PUT /v1/posts/{postId}': async (h, p, q, b) => {
    const { body, warnings } = await buildPostBody(h, b, { forUpdate: true });
    if (b.scheduledFor) body.scheduled_at = new Date(b.scheduledFor).toISOString();
    if (body.channels && !body.channels.length) delete body.channels;
    const post = await h.request('PATCH', `/v1/posts/${encodeURIComponent(p.postId)}`, { body });
    return { message: 'Post updated successfully', post: zPost(post), ...(warnings.length ? { warnings } : {}) };
  },
  'DELETE /v1/posts/{postId}': async (h, p) => {
    try {
      await h.request('DELETE', `/v1/posts/${encodeURIComponent(p.postId)}`);
      return { message: 'Post deleted successfully' };
    } catch (e) {
      if (e instanceof HermosoApiError && e.code === 'post_not_cancellable') {
        let tools = '';
        try { tools = ((await h.getPost(p.postId)).results || []).filter((r) => r.ok).map((r) => `${Z(r.channel)}: ${PUBLISHED_DELETE_TOOLS[r.channel] || 'the platform'}`).join('; '); } catch { /* optional */ }
        e.message = `${e.message}${tools ? ` Remove it from each platform with: ${tools}.` : ''}`;
      }
      throw e;
    }
  },
  'POST /v1/posts/{postId}/retry': async (h, p) => {
    const r = await h.callTool('retry_scheduled', { id: p.postId });
    const id = r.data?.id || r.data?.newId || r.data?.post?.id;
    let post = null;
    if (id) { try { post = zPost(await h.getPost(id)); } catch { post = null; } }
    return { message: r.text, ...(post ? { post } : {}) };
  },

  // PROFILES
  'GET /v1/profiles': async (h) => { const bs = await h.brands(); return { profiles: bs.map(zProfile), total: bs.length, skip: 0, limit: bs.length }; },
  'POST /v1/profiles': async (h, p, q, b) => {
    const r = await h.callTool('create_brand', { name: b.name, activate: false });
    return { message: 'Profile created successfully', profile: { _id: r.data?.brand?.id, name: r.data?.brand?.name, description: b.description || '', isDefault: false } };
  },
  'GET /v1/profiles/{profileId}': async (h, p) => {
    const b = (await h.brands()).find((x) => brandKeyOf(x) === p.profileId || x.id === p.profileId);
    if (!b) throw notFound(`Profile ${p.profileId}`);
    return { profile: zProfile(b) };
  },
  'PUT /v1/profiles/{profileId}': async (h, p, q, b) => {
    const c = h.forBrand(p.profileId);
    if (b.name) await c.callTool('update_brand', { name: b.name });
    return { message: 'Profile updated successfully', profile: { _id: p.profileId, name: b.name } };
  },

  // ACCOUNTS
  'GET /v1/accounts': async (h, p, q) => {
    let rows = await h.accountRows();
    if (q.platform) rows = rows.filter((r) => r.channel === toChannel(q.platform));
    return { accounts: rows.map((r) => zAccount(r, h.brand)), hasAnalyticsAccess: true };
  },
  'GET /v1/accounts/health': async (h) => {
    const rows = await h.accountRows();
    const accounts = rows.map((r) => ({ accountId: r.accountId, platform: Z(r.channel), username: r.handle || r.label, status: r.needsReconnect ? 'needs_reconnect' : 'healthy', canPost: !r.needsReconnect, needsReconnect: r.needsReconnect }));
    return { summary: { total: accounts.length, healthy: accounts.filter((a) => a.canPost).length, needsReconnect: accounts.filter((a) => !a.canPost).length }, accounts };
  },
  'GET /v1/accounts/follower-stats': async (h, p, q) => {
    const r = await h.request('GET', '/v1/analytics/follower-history', { query: { from: q.fromDate, to: q.toDate, granularity: q.granularity } });
    return { accounts: r.accounts || [], dateRange: r.dateRange, granularity: r.granularity, hermoso: r };
  },
  'GET /v1/accounts/{accountId}': async (h, p) => {
    const r = (await h.accountRows()).find((x) => x.accountId === p.accountId || x.channel === p.accountId);
    if (!r) throw notFound(`Account ${p.accountId}`);
    return { account: zAccount(r, h.brand) };
  },
  'GET /v1/accounts/{accountId}/health': async (h, p) => {
    const r = (await h.accountRows()).find((x) => x.accountId === p.accountId || x.channel === p.accountId);
    if (!r) throw notFound(`Account ${p.accountId}`);
    return { accountId: r.accountId, platform: Z(r.channel), username: r.handle || r.label, status: r.needsReconnect ? 'needs_reconnect' : 'healthy', canPost: !r.needsReconnect, needsReconnect: r.needsReconnect };
  },
  'DELETE /v1/accounts/{accountId}': async (h, p) => {
    const { channel, ref } = splitAccountId(p.accountId);
    const ch = (await h.channels()).find((c) => c.id === channel);
    const r = await h.request('DELETE', `/v1/connections/${encodeURIComponent(ch?.connector || channel)}`, { query: ref ? { account: ref } : {} });
    return { message: r.note || 'Account disconnected' };
  },
  'GET /v1/accounts/{accountId}/posts': async (h, p, q) => {
    const { channel } = splitAccountId(p.accountId);
    const r = await h.callTool('list_published_posts', { channel, limit: Math.min(200, Number(q.limit) || 50), ...(q.cursor ? { cursor: q.cursor } : {}) });
    return { posts: (r.data?.posts || []).map((x) => ({ platformPostId: x.postId, platform: Z(x.channel), content: x.caption, platformPostUrl: x.url, publishedAt: x.publishedAt ? new Date(x.publishedAt).toISOString() : undefined, mediaUrls: x.mediaUrls || [] })), nextCursor: r.data?.nextCursor || null };
  },
  'GET /v1/accounts/{accountId}/gmb-reviews': async (h, p, q) => {
    const r = await h.callTool('list_google_business_reviews', { ...(q.pageToken ? { pageToken: q.pageToken } : {}), ...(q.pageSize ? { limit: Number(q.pageSize) } : {}) });
    return { reviews: r.data?.reviews || [], averageRating: r.data?.averageRating, totalReviewCount: r.data?.totalReviewCount, nextPageToken: r.data?.nextPageToken };
  },
  'POST /v1/accounts/{accountId}/gmb-reviews/{reviewId}/reply': async (h, p, q, b) => {
    const r = await h.callTool('reply_to_google_business_review', { reviewId: p.reviewId, comment: b.comment || b.reply });
    return { success: true, message: r.text };
  },
  'DELETE /v1/accounts/{accountId}/gmb-reviews/{reviewId}/reply': async (h, p) => {
    const r = await h.callTool('reply_to_google_business_review', { reviewId: p.reviewId, delete: true, confirm: true });
    return { success: true, message: r.text };
  },

  // MEDIA
  'POST /v1/media/presign': async (h, p, q, b) => {
    const r = await h.callTool('upload_file', { getUploadUrl: true, ...(b.filename ? { name: b.filename } : {}) });
    return {
      uploadUrl: r.data?.uploadUrl, publicUrl: null, key: null,
      expiresIn: r.data?.expiresAt ? Math.round((Date.parse(r.data.expiresAt) - Date.now()) / 1000) : undefined,
      note: 'PUT the bytes to uploadUrl: the response body is {url}, the durable public URL to use in mediaItems. (Hermoso names the URL once the file is in.)',
    };
  },

  // QUEUE
  'GET /v1/queue/slots': async (h, p, q) => {
    const { list, weekdays } = await queues(h);
    const all = list.map((x) => zQueue(x, weekdays, q.profileId));
    if (q.queueId && q.all !== 'true') {
      const one = all.find((x) => x._id === q.queueId || x.name === q.queueId);
      return { exists: !!one, schedule: one || null, nextSlots: [] };
    }
    if (q.all === 'true' || !q.queueId) return { queues: all, count: all.length };
    return { queues: all, count: all.length };
  },
  'POST /v1/queue/slots': async (h, p, q, b) => {
    const { weekdays } = await queues(h);
    const r = await h.callTool('manage_post_queues', { action: 'save', name: b.name || 'Default', timezone: b.timezone || 'UTC', ...toQueueArgs(b, weekdays) });
    const { list } = await queues(h);
    const saved = list.find((x) => x.name === (b.name || 'Default'));
    return { success: true, message: r.text, schedule: saved ? zQueue(saved, weekdays, b.profileId) : null };
  },
  'PUT /v1/queue/slots': async (h, p, q, b) => {
    const { list: before, weekdays } = await queues(h);
    const cur = before.find((x) => x.id === b.queueId || x.name === b.queueId) || before.find((x) => x.isDefault);
    const args = { action: 'save', name: cur?.name || 'Default', ...(b.timezone ? { timezone: b.timezone } : {}), ...(b.slots ? toQueueArgs(b, weekdays) : {}), ...(b.name && cur && b.name !== cur.name ? { rename: b.name } : {}) };
    const r = await h.callTool('manage_post_queues', args);
    const { list } = await queues(h);
    const saved = list.find((x) => x.name === (args.rename || args.name));
    return { success: true, message: r.text, schedule: saved ? zQueue(saved, weekdays, b.profileId) : null };
  },
  'DELETE /v1/queue/slots': async (h, p, q) => {
    const { list } = await queues(h);
    const cur = list.find((x) => x.id === q.queueId || x.name === q.queueId);
    const r = await h.callTool('manage_post_queues', { action: 'delete', name: cur?.name || q.queueId || 'Default' });
    return { success: true, message: r.text };
  },

  // WEBHOOKS (one per Hermoso brand)
  'GET /v1/webhooks/settings': async (h) => ({ webhooks: zWebhook(await webhookSink(h)) }),
  'POST /v1/webhooks/settings': async (h, p, q, b) => {
    await h.callTool('connect_connector', { provider: 'webhook', fields: { webhookUrl: b.url } });
    const secret = await freshSecret(h);
    const { events, dropped } = toHermosoEvents(b.events);
    await h.callTool('set_alert_events', { provider: 'webhook', events: b.isActive === false ? [] : events });
    const [w] = zWebhook(await webhookSink(h));
    const warnings = [...(dropped.length ? [`Not delivered by Hermoso: ${dropped.join(', ')}.`] : []), ...(b.secret ? ['secret was not applied: Hermoso signs with its own secret (returned here) using the Standard Webhooks headers webhook-id, webhook-timestamp, webhook-signature.'] : [])];
    return { message: 'Webhook created', webhook: { ...w, name: b.name || w?.name, url: b.url, secret }, ...(warnings.length ? { warnings } : {}) };
  },
  'PUT /v1/webhooks/settings': async (h, p, q, b) => {
    const cur = await webhookSink(h);
    if (b.url) await h.callTool('connect_connector', { provider: 'webhook', fields: { webhookUrl: b.url } });
    let dropped = [];
    if (b.events || b.isActive !== undefined) {
      const m = b.events ? toHermosoEvents(b.events) : { events: cur.groupsSelected.length ? cur.groupsSelected : ['posts'], dropped: [] };
      dropped = m.dropped;
      await h.callTool('set_alert_events', { provider: 'webhook', events: b.isActive === false ? [] : m.events });
    }
    const [w] = zWebhook(await webhookSink(h));
    return { message: 'Webhook updated', webhook: w, ...(dropped.length ? { warnings: [`Not delivered by Hermoso: ${dropped.join(', ')}.`] } : {}) };
  },
  'DELETE /v1/webhooks/settings': async (h) => {
    const r = await h.callTool('disconnect_connector', { provider: 'webhook', confirm: true });
    return { message: r.text || 'Webhook deleted' };
  },
  'POST /v1/webhooks/test': async (h) => {
    const r = await h.callTool('send_test_alert', { provider: 'webhook' });
    return { success: !/fail|not deliver|error/i.test(r.text || ''), message: r.text };
  },
  'GET /v1/webhooks/logs': async (h) => {
    const s = await webhookSink(h);
    return { logs: s.deliveries.map((d) => ({ _id: d.id, event: FROM_HERMOSO_EVENT[d.event] || d.event, status: d.outcome === 'ok' ? 'success' : d.outcome, statusCode: d.lastStatus, attemptNumber: d.attempts, createdAt: d.firstAt, lastAttemptAt: d.lastAt, redelivered: d.redelivered })) };
  },
  'POST /v1/webhooks/logs/redeliver': async (h, p, q, b) => {
    const r = await h.callTool('redeliver_webhook', { deliveryId: b.logId || b.id || b.deliveryId });
    return { success: true, message: r.text };
  },

  // CONNECT
  'GET /v1/connect/{platform}': async (h, p, q) => {
    const ch = toChannel(p.platform);
    const c = (await h.channels()).find((x) => x.id === ch);
    const link = await h.request('POST', '/v1/connect-links', { body: { provider: c?.connector || ch, ...(q.redirect_url ? { redirect_url: q.redirect_url } : {}) } });
    return { authUrl: link.url, state: link.id };
  },
  'POST /v1/platform-invites': async (h, p, q, b) => {
    const ch = toChannel(b.platform);
    const c = (await h.channels()).find((x) => x.id === ch);
    const link = await h.request('POST', '/v1/connect-links', { body: { provider: c?.connector || ch } });
    return { invite: { _id: link.id, token: link.id, platform: b.platform, profileId: b.profileId, inviteUrl: link.url, expiresAt: link.expires_at } };
  },

  // ANALYTICS
  'GET /v1/analytics': async (h, p, q) => {
    const rows = [];
    let cursor;
    for (let i = 0; i < 5; i++) {
      const r = await h.callTool('list_published_posts', { limit: 200, ...(q.platform ? { channel: toChannel(q.platform) } : {}), ...(cursor ? { cursor } : {}) });
      rows.push(...(r.data?.posts || []));
      cursor = r.data?.nextCursor;
      if (!cursor) break;
    }
    const metricsOf = (row) => {
      const s = (row?.samples || []).filter((x) => x && x.ok !== false).sort((a, b) => Number(b.at) - Number(a.at))[0];
      const m = s?.metrics || {};
      return { impressions: m.impressions ?? m.views ?? null, reach: m.reach ?? null, likes: m.likes ?? m.like_count ?? null, comments: m.comments ?? null, shares: m.shares ?? m.reposts ?? null, saves: m.saves ?? m.saved ?? null, clicks: m.clicks ?? null, views: m.views ?? m.video_views ?? null, engagementRate: row?.engagement?.present ? row.engagement.rate * 100 : null, lastUpdated: s?.at ? new Date(Number(s.at)).toISOString() : null, raw: m };
    };
    if (q.postId) {
      let ids = [String(q.postId)];
      if (/^job_/.test(String(q.postId))) ids = ((await h.getPost(q.postId)).results || []).filter((r) => r.ok).map((r) => String(r.id));
      const hit = rows.filter((r) => ids.includes(String(r.postId)) || (r.siblingIds || []).some((x) => ids.includes(String(x))));
      if (!hit.length) throw notFound(`Analytics for post ${q.postId}`);
      return { postId: q.postId, analytics: metricsOf(hit[0]), platformAnalytics: hit.map((r) => ({ platform: Z(r.channel), platformPostId: r.postId, platformPostUrl: r.url, analytics: metricsOf(r) })) };
    }
    const limit = Math.max(1, Math.min(100, Number(q.limit) || 50));
    const page = Math.max(1, Number(q.page) || 1);
    const slice = rows.slice((page - 1) * limit, page * limit);
    return { posts: slice.map((r) => ({ _id: r.id, platformPostId: r.postId, platform: Z(r.channel), content: r.caption, publishedAt: r.publishedAt ? new Date(r.publishedAt).toISOString() : null, platformPostUrl: r.url, analytics: metricsOf(r) })), pagination: { page, limit, total: rows.length, pages: Math.ceil(rows.length / limit) } };
  },
  'GET /v1/analytics/best-time': async (h, p, q) => h.request('GET', '/v1/analytics/best-time', { query: { channel: q.platform ? toChannel(q.platform) : undefined, days: q.days, timezone: q.timezone } }),
  'GET /v1/analytics/content-decay': async (h, p, q) => h.request('GET', '/v1/analytics/content-decay', { query: { channel: q.platform ? toChannel(q.platform) : undefined } }),
  'GET /v1/analytics/posting-frequency': async (h, p, q) => h.request('GET', '/v1/analytics/posting-frequency', { query: { channel: q.platform ? toChannel(q.platform) : undefined } }),
  'GET /v1/analytics/instagram/follower-history': async (h, p, q) => h.request('GET', '/v1/analytics/follower-history', { query: { channel: 'instagram', from: q.fromDate, to: q.toDate } }),

  // USERS + USAGE
  'GET /v1/users/me': async (h) => {
    const [brands, email] = await Promise.all([h.brands(), h.request('GET', '/v1/account/email').catch(() => null)]);
    const cur = brands.find((b) => b.current) || {};
    return { _id: null, name: cur.name, email: email?.email ?? null, role: cur.role, workspaceId: cur.id, workspaceName: cur.name };
  },
  'GET /v1/usage-stats': async (h) => { const c = await h.request('GET', '/v1/credits'); return { planName: c.plan, credits: c.balance, limits: c.limits }; },
  'GET /v1/usage': async (h) => { const c = await h.request('GET', '/v1/credits'); return { planName: c.plan, credits: c.balance, limits: c.limits }; },

  // INBOX COMMENTS
  'GET /v1/inbox/comments/{postId}': async (h, p, q) => {
    const t = await commentTarget(h, p.postId, q.accountId);
    const tools = COMMENT_TOOLS[t.channel];
    if (!tools) throw new HermosoUnsupportedError(`zernio.comments.getInboxPostComments (${Z(t.channel)})`, { tool: 'list_inbox' });
    const args = t.channel === 'youtube' || t.channel === 'tiktok' ? { videoId: t.id } : t.channel === 'linkedin' ? { postUrn: t.id } : { postId: t.id };
    const r = await h.callTool(tools.list, args);
    const list = r.data?.comments || r.data?.replies || r.data?.items || [];
    return { comments: list.map((c) => ({ id: c.id || c.commentId || c.urn, message: c.text ?? c.message, createdTime: c.createdAt || c.created_time || c.timestamp || c.publishedAt, from: { name: c.author || c.username || c.from?.name, id: c.authorId || c.from?.id }, likeCount: c.likeCount ?? c.like_count, replyCount: c.replyCount ?? c.reply_count, platform: Z(t.channel), raw: c })) };
  },
  'POST /v1/inbox/comments/{postId}': async (h, p, q, b) => {
    const t = await commentTarget(h, p.postId, b.accountId);
    const tools = COMMENT_TOOLS[t.channel];
    const tool = b.commentId ? tools?.reply : tools?.comment;
    if (!tool) throw new HermosoUnsupportedError(`zernio.comments.replyToInboxPost (${Z(t.channel)})`, { tool: 'list_inbox' });
    const text = b.message;
    const args = t.channel === 'tiktok' ? { videoId: t.id, text, ...(b.commentId ? { commentId: b.commentId } : {}) }
      : t.channel === 'youtube' ? { commentId: b.commentId, text }
      : t.channel === 'linkedin' ? { postUrn: t.id, text, ...(b.commentId ? { parentComment: b.commentId } : {}) }
      : t.channel === 'threads' ? { replyToId: b.commentId || t.id, text }
      : b.commentId ? { commentId: b.commentId, message: text } : { postId: t.id, message: text };
    const r = await h.callTool(tool, args);
    return { success: true, commentId: r.data?.id || r.data?.commentId || null, message: r.text };
  },
  'DELETE /v1/inbox/comments/{postId}': async (h, p, q) => {
    const t = await commentTarget(h, p.postId, q.accountId);
    const tools = COMMENT_TOOLS[t.channel];
    if (!tools) throw new HermosoUnsupportedError(`zernio.comments.deleteInboxComment (${Z(t.channel)})`, { tool: 'list_inbox' });
    const args = t.channel === 'linkedin' ? { postUrn: t.id, commentId: q.commentId, confirm: true }
      : t.channel === 'threads' ? { replyId: q.commentId, hide: true }
      : t.channel === 'tiktok' ? { commentId: q.commentId, action: 'DELETE', videoId: t.id, confirm: true }
      : { commentId: q.commentId, action: 'delete', confirm: true };
    const r = await h.callTool(tools.moderate, args);
    return { success: true, message: r.text };
  },
  'POST /v1/inbox/comments/{postId}/{commentId}/hide': async (h, p, q, b) => hideComment(h, p, b.accountId || q.accountId, true),
  'DELETE /v1/inbox/comments/{postId}/{commentId}/hide': async (h, p, q) => hideComment(h, p, q.accountId, false),
  'POST /v1/inbox/comments/{postId}/{commentId}/private-reply': async (h, p, q, b) => {
    const t = await commentTarget(h, p.postId, b.accountId);
    if (!['facebook', 'instagram'].includes(t.channel)) throw new HermosoUnsupportedError(`zernio.comments.sendPrivateReplyToComment (${Z(t.channel)})`, { tool: 'reply_to_inbox_item' });
    const r = await h.callTool('reply_to_meta_comment', { commentId: p.commentId, message: b.message, private: true });
    return { success: true, message: r.text };
  },

  // INBOX REVIEWS (Google Business Profile + Facebook Page)
  'GET /v1/inbox/reviews': async (h, p, q) => {
    const ch = q.platform ? toChannel(q.platform) : (q.accountId ? splitAccountId(q.accountId).channel : 'google_business');
    const r = ch === 'facebook' ? await h.callTool('meta_page_reviews', { action: 'list' }) : await h.callTool('list_google_business_reviews', {});
    return { reviews: (r.data?.reviews || r.data?.items || []).map((x) => ({ id: x.id || x.reviewId || x.name, platform: Z(ch), rating: x.rating ?? x.starRating, text: x.text ?? x.comment, reviewer: { name: x.reviewer?.displayName || x.reviewer || x.author }, created: x.createTime || x.created_time, reply: x.reply, raw: x })) };
  },
  'POST /v1/inbox/reviews/{reviewId}/reply': async (h, p, q, b) => {
    const ch = b.accountId ? splitAccountId(b.accountId).channel : 'google_business';
    const r = ch === 'facebook'
      ? await h.callTool('meta_page_reviews', { action: 'reply', reviewId: p.reviewId, text: b.message, confirm: true })
      : await h.callTool('reply_to_google_business_review', { reviewId: p.reviewId, comment: b.message });
    return { success: true, message: r.text };
  },
  'DELETE /v1/inbox/reviews/{reviewId}/reply': async (h, p) => {
    const r = await h.callTool('reply_to_google_business_review', { reviewId: p.reviewId, delete: true, confirm: true });
    return { success: true, message: r.text };
  },

  // VALIDATE
  'POST /v1/tools/validate/post-length': async (h, p, q, b) => {
    const chs = await h.channels();
    const n = [...String(b.content || '')].length;
    const platforms = {};
    for (const c of chs) if (c.caption_max) platforms[Z(c.id)] = { count: n, limit: c.caption_max, valid: n <= c.caption_max };
    return { content: b.content, characterCount: n, platforms };
  },
  'POST /v1/tools/validate/post': async (h, p, q, b) => {
    const { body, warnings } = await buildPostBody(h, { ...b, dryRun: true });
    const v = await dryRunCheck(h, body);
    return { valid: v.valid, errors: v.errors, warnings };
  },
};

async function hideComment(h, p, accountId, hide) {
  const t = await commentTarget(h, p.postId, accountId);
  const tools = COMMENT_TOOLS[t.channel];
  if (!tools) throw new HermosoUnsupportedError('zernio.comments.hideInboxComment', { tool: 'list_inbox' });
  const args = t.channel === 'threads' ? { replyId: p.commentId, hide }
    : t.channel === 'tiktok' ? { commentId: p.commentId, action: hide ? 'HIDE' : 'UNHIDE', videoId: t.id }
    : t.channel === 'youtube' ? { commentId: p.commentId, action: hide ? 'hold' : 'publish' }
    : t.channel === 'linkedin' ? null
    : { commentId: p.commentId, action: hide ? 'hide' : 'unhide' };
  if (!args) throw new HermosoUnsupportedError('zernio.comments.hideInboxComment (linkedin)', { tool: 'delete_linkedin_comment' });
  const r = await h.callTool(tools.moderate, args);
  return { success: true, hidden: hide, message: r.text };
}

const COMPILED = Object.keys(ROUTES).map((key) => {
  const [method, tpl] = key.split(' ');
  const names = [];
  const re = new RegExp(`^${tpl.replace(/\{(\w+)\}/g, (_, n) => { names.push(n); return '([^/]+)'; })}$`);
  return { method, re, names, fn: ROUTES[key], key };
}).sort((a, b) => a.names.length - b.names.length); // literal routes win over parameterised ones

/** Resolve one Zernio REST call. `path` is Zernio's path (e.g. /v1/posts/abc). */
export async function zernioRoute(h, method, path, { query = {}, body = {}, headers = {} } = {}) {
  const m = String(method).toUpperCase();
  const clean = String(path).split('?')[0].replace(/\/+$/, '');
  for (const r of COMPILED) {
    if (r.method !== m) continue;
    const hit = clean.match(r.re);
    if (!hit) continue;
    const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(hit[i + 1])]));
    const profileId = query?.profileId || body?.profileId;
    const client = profileId && !(r.key.includes('/profiles/') && params.profileId) ? h.forBrand(profileId) : h;
    return r.fn(client, params, query || {}, body || {}, headers || {});
  }
  throw new HermosoUnsupportedError(`Zernio REST ${m} ${clean}`, {});
}
