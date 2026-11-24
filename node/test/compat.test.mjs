import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startMock } from './mock-hermoso.mjs';
import SocialMediaAPI from '../src/ayrshare.js';
import Zernio, { ZernioApiError, SERVED_METHODS } from '../src/zernio.js';
import Postiz from '../src/postiz.js';
import { HermosoUnsupportedError, toChannel, fromChannel } from '../src/core.js';

const mock = await startMock();
test.after(() => mock.close());
const last = (path, method = 'POST') => [...mock.calls].reverse().find((c) => c.path === path && c.method === method);

test('platform names map both ways', () => {
  assert.equal(toChannel('twitter'), 'x');
  assert.equal(toChannel('gmb'), 'google_business');
  assert.equal(toChannel('googlebusiness'), 'google_business');
  assert.equal(toChannel('Instagram'), 'instagram');
  assert.equal(fromChannel('x', 'ayrshare'), 'twitter');
  assert.equal(fromChannel('google_business', 'ayrshare'), 'gmb');
  assert.equal(fromChannel('google_business', 'zernio'), 'googlebusiness');
});

test('ayrshare: post maps fields onto POST /v1/posts and shapes the answer', async () => {
  const s = new SocialMediaAPI('hmk_test', { baseUrl: mock.url });
  const r = await s.post({ post: 'Hello', platforms: ['twitter', 'facebook'], mediaUrls: ['https://assets.hermoso.ai/a.png'], firstComment: { comment: 'link' }, faceBookOptions: { pageId: 'P1' }, idempotencyKey: 'k1', youTubeOptions: { title: 'T', visibility: 'Unlisted' } });
  const sent = last('/v1/posts');
  assert.deepEqual(sent.body.channels, ['x', 'facebook']);
  assert.equal(sent.body.caption, 'Hello');
  assert.equal(sent.body.first_comment, 'link');
  assert.equal(sent.body.targets.pageId, 'P1');
  assert.equal(sent.body.title, 'T');
  assert.equal(sent.body.visibility_by_channel.youtube, 'unlisted');
  assert.equal(sent.headers['idempotency-key'], 'k1');
  assert.equal(r.status, 'success');
  assert.deepEqual(r.postIds.map((p) => p.platform), ['twitter', 'facebook']);
});

test('ayrshare: a schedule returns status "scheduled", and an API error is returned, not thrown', async () => {
  const s = new SocialMediaAPI('hmk_test', { baseUrl: mock.url });
  const when = new Date(Date.now() + 864e5).toISOString();
  const r = await s.post({ post: 'Later', platforms: ['twitter'], scheduleDate: when });
  assert.equal(r.status, 'scheduled');
  assert.equal(last('/v1/posts').body.scheduled_at, when);
  const bad = await s.post({ post: 'x', platforms: ['tiktok'] });
  assert.equal(bad.status, 'error');
  assert.equal(bad.code, 'channel_not_connected');
  const del = await s.delete({ id: r.id });
  assert.equal(del.status, 'success');
});

test('ayrshare: profile key selects the brand, shared brands carry the owner', async () => {
  const s = new SocialMediaAPI('hmk_test', { baseUrl: mock.url });
  const profiles = await s.getProfiles();
  const shared = profiles.profiles.find((p) => p.shared);
  assert.equal(shared.profileKey, 'b2:acct9');
  s.setProfileKey(shared.profileKey);
  await s.history();
  const h = last('/v1/posts', 'GET').headers;
  assert.equal(h['x-hermoso-user'], 'b2');
  assert.equal(h['x-hermoso-owner'], 'acct9');
});

test('ayrshare: unsupported methods throw and name a Hermoso tool', () => {
  const s = new SocialMediaAPI('hmk_test', { baseUrl: mock.url });
  for (const m of ['feedAdd', 'shortLink', 'resizeImage', 'deleteProfile', 'getBrandByUser']) {
    assert.throws(() => s[m]({}), (e) => e instanceof HermosoUnsupportedError && /Use the Hermoso tool `\w+`/.test(e.message), m);
  }
});

test('zernio: createPost resolves {data}, maps accountId to the right selector', async () => {
  const z = new Zernio({ apiKey: 'hmk_test', baseURL: mock.url });
  const when = new Date(Date.now() + 864e5).toISOString();
  const { data } = await z.posts.createPost({ body: { content: 'Hi', platforms: [{ platform: 'twitter', accountId: 'x:222' }, { platform: 'facebook', accountId: 'facebook:P9', customContent: 'FB copy' }], scheduledFor: when } });
  const sent = last('/v1/posts').body;
  assert.deepEqual(sent.options.accounts, { x: ['222'] });
  assert.equal(sent.targets.pageId, 'P9');
  assert.equal(sent.captions_by_channel.facebook, 'FB copy');
  assert.equal(data.post.status, 'scheduled');
  assert.equal(data.post.platforms[0].platform, 'twitter');
  const got = await z.posts.getPost({ path: { postId: data.post._id } });
  assert.equal(got.data.post._id, data.post._id);
});

test('zernio: dryRun creates nothing and reports per-platform limits', async () => {
  const z = new Zernio({ apiKey: 'hmk_test', baseURL: mock.url });
  const before = mock.calls.filter((c) => c.path === '/v1/posts' && c.method === 'POST').length;
  const { data } = await z.posts.createPost({ body: { content: 'y'.repeat(300), platforms: [{ platform: 'twitter', accountId: 'x' }, { platform: 'tiktok', accountId: 'tiktok' }], dryRun: true } });
  assert.equal(mock.calls.filter((c) => c.path === '/v1/posts' && c.method === 'POST').length, before);
  assert.equal(data.valid, false);
  assert.equal(data.errors.length, 2);
});

test('zernio: errors reject with ZernioApiError; unserved methods with HermosoUnsupportedError', async () => {
  const z = new Zernio({ apiKey: 'hmk_test', baseURL: mock.url });
  await assert.rejects(z.posts.createPost({ body: { content: 'x', platforms: [{ platform: 'tiktok', accountId: 'tiktok' }], publishNow: true } }), (e) => e instanceof ZernioApiError && e.statusCode === 401 && e.code === 'channel_not_connected');
  await assert.rejects(z.posts.pinPost({ path: { postId: 'a' } }), (e) => e instanceof HermosoUnsupportedError && /manage_meta_post/.test(e.message));
  await assert.rejects(z.whatsapp.sendWhatsAppMessage({}), (e) => e instanceof HermosoUnsupportedError && /send_whatsapp_message/.test(e.message));
  await assert.rejects(z.posts.createPost({ body: { content: 'draft', platforms: [{ platform: 'twitter', accountId: 'x' }] } }), HermosoUnsupportedError);
  assert.ok(SERVED_METHODS.posts.includes('createPost'));
});

test('zernio: queue slots round-trip through manage_post_queues', async () => {
  const z = new Zernio({ apiKey: 'hmk_test', baseURL: mock.url });
  const { data } = await z.queue.createQueueSlot({ body: { profileId: 'default', name: 'Q', timezone: 'UTC', slots: [{ dayOfWeek: 1, time: '09:00' }] } });
  const sent = last('/v1/tools/manage_post_queues').body;
  assert.equal(last('/v1/tools/manage_post_queues').headers['x-hermoso-user'], 'default');
  assert.equal(sent.action, 'list'); // the read-back after the save
  assert.deepEqual(data.schedule.slots, [{ dayOfWeek: 1, time: '09:00' }]);
});

test('zernio: the Hermoso key is required, a Zernio key is never sent', () => {
  const prev = { h: process.env.HERMOSO_API_KEY, z: process.env.ZERNIO_API_KEY };
  delete process.env.HERMOSO_API_KEY; process.env.ZERNIO_API_KEY = 'sk_zernio';
  assert.throws(() => new Zernio(), /Hermoso API key/);
  process.env.ZERNIO_API_KEY = prev.z ?? ''; if (prev.h) process.env.HERMOSO_API_KEY = prev.h;
});

test('postiz: post, list, integrations, delete', async () => {
  const p = new Postiz('hmk_test', mock.url);
  const ints = await p.integrations();
  assert.ok(ints.some((i) => i.identifier === 'x'));
  const date = new Date(Date.now() + 864e5).toISOString();
  const r = await p.post({ type: 'schedule', date, posts: [{ integration: { id: 'x:111' }, value: [{ content: 'one' }, { content: 'two' }], settings: { __type: 'x' } }] });
  const sent = last('/v1/posts').body;
  assert.deepEqual(sent.options.thread, ['one', 'two']);
  assert.deepEqual(sent.options.accounts, { x: ['111'] });
  assert.equal(r[0].integration, 'x:111');
  const list = await p.postList({ startDate: new Date().toISOString(), endDate: new Date(Date.now() + 3 * 864e5).toISOString() });
  assert.ok(list.posts.some((x) => x.id === r[0].postId && x.state === 'QUEUE'));
  const d = await p.deletePost(r[0].postId);
  assert.equal(d.ok, true);
  await assert.rejects(p.post({ type: 'draft', posts: [] }), HermosoUnsupportedError);
});

test('the CommonJS build exports the class itself, like the originals', { skip: !process.env.TEST_CJS }, () => {
  const require = createRequire(import.meta.url);
  const S = require('../dist/ayrshare.cjs');
  assert.equal(typeof S, 'function');
  assert.equal(typeof new S('hmk_test').post, 'function');
  const Z = require('../dist/zernio.cjs');
  assert.equal(typeof Z, 'function');
  assert.equal(typeof Z.ZernioApiError, 'function');
});
