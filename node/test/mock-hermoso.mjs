// A tiny stand-in for Hermoso's /v1 API: enough to check what the compat layers SEND and how they shape what
// comes back. The real API is exercised separately (see the repo README, "How this was tested").
import http from 'node:http';

export async function startMock() {
  const calls = [];
  const posts = new Map();
  let n = 0;
  const queues = [{ id: 'default', name: 'Default', isDefault: true, slots: ['09:00'], timezone: 'UTC', channels: [] }];
  const channels = [
    { object: 'channel', id: 'x', name: 'X', connector: 'x', available: true, connected: true, caption_max: 280, target_field: null, carousel: null },
    { object: 'channel', id: 'facebook', name: 'Facebook', connector: 'meta', available: true, connected: true, caption_max: 63206, target_field: 'pageId', carousel: { min: 2, max: null, effective_max: 30 } },
    { object: 'channel', id: 'tiktok', name: 'TikTok', connector: 'tiktok', available: true, connected: false, caption_max: 2200, target_field: null, carousel: null },
  ];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = raw && /json/.test(req.headers['content-type'] || '') ? JSON.parse(raw) : raw;
      calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: req.headers });
      const send = (s, j) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (req.headers.authorization !== 'Bearer hmk_test') return send(401, { error: { type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid API key.' } });
      const p = url.pathname;
      if (p === '/v1/channels') return send(200, { object: 'list', data: channels });
      if (p === '/v1/connections') return send(200, { object: 'list', data: [{ provider: 'x', name: 'X', account: '@brand', accounts: [{ id: '111', handle: '@brand', label: 'Brand' }, { id: '222', handle: '@other', label: 'Other' }] }, { provider: 'meta', name: 'Meta', account: 'Brand Page', accounts: [] }] });
      if (p === '/v1/brands') return send(200, { object: 'list', data: [{ object: 'brand', id: 'default', name: 'Acme', is_default: true, current: true, role: 'owner' }, { object: 'brand', id: 'b2', name: 'Client', owner_account_id: 'acct9', shared: true, role: 'member' }] });
      if (p === '/v1/credits') return send(200, { object: 'credits', balance: 100, plan: 'pro' });
      if (p === '/v1/posts' && req.method === 'POST') {
        if ((body.channels || []).includes('tiktok')) return send(401, { error: { type: 'connector_error', code: 'channel_not_connected', message: 'TikTok is not connected.', connector: 'tiktok' } });
        const id = `job_${++n}`;
        const now = !body.scheduled_at && !body.use_queue;
        const post = { object: 'post', id, status: now ? 'published' : 'scheduled', scheduled_at: body.scheduled_at || new Date().toISOString(), created_at: new Date().toISOString(), channels: body.channels, caption: body.caption, title: body.title || '', media: (body.media || []).map((m) => ({ url: m.url || m, type: 'image' })), targets: body.targets || {}, options: body.options || {}, captions_by_channel: body.captions_by_channel || null, results: now ? body.channels.map((c) => ({ channel: c, ok: true, id: `${c}-1`, url: `https://example.com/${c}/1` })) : null };
        posts.set(id, post);
        return send(200, post);
      }
      if (p === '/v1/posts' && req.method === 'GET') return send(200, { object: 'list', data: [...posts.values()].reverse(), has_more: false, next_cursor: null });
      const m = p.match(/^\/v1\/posts\/([^/]+)$/);
      if (m) {
        const post = posts.get(m[1]);
        if (!post) return send(404, { error: { type: 'invalid_request_error', code: 'post_not_found', message: 'No post.' } });
        if (req.method === 'GET') return send(200, post);
        if (req.method === 'PATCH') { if (body.caption !== undefined) post.caption = body.caption; return send(200, post); }
        if (req.method === 'DELETE') {
          if (post.status !== 'scheduled') return send(409, { error: { type: 'invalid_request_error', code: 'post_not_cancellable', message: 'Already published.' } });
          posts.delete(m[1]); return send(200, { object: 'post', id: m[1], deleted: true });
        }
      }
      if (p === '/v1/media') return send(200, { object: 'media', url: 'https://assets.hermoso.ai/u/1.png', type: 'image', bytes: 3 });
      if (p === '/v1/tools/manage_post_queues') {
        if (body.action === 'save') { const q = queues.find((x) => x.name === body.name) || (queues.push({ id: `q_${queues.length}`, name: body.name }), queues[queues.length - 1]); Object.assign(q, { slots: body.slots, days: body.days, timezone: body.timezone || 'UTC', channels: [] }); }
        if (body.action === 'delete') { const i = queues.findIndex((x) => x.name === body.name); if (i > 0) queues.splice(i, 1); }
        return send(200, { object: 'tool_result', tool: 'manage_post_queues', text: 'ok', data: { queues, weekdays: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] } });
      }
      if (p.startsWith('/v1/tools/')) return send(200, { object: 'tool_result', tool: p.slice(10), text: 'ok', data: {} });
      return send(404, { error: { type: 'invalid_request_error', code: 'not_found', message: `No route ${p}` } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, posts, close: () => new Promise((r) => server.close(r)) };
}
