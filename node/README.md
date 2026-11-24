# hermoso-compat

**Unofficial** drop-in compatibility layers that run code written for other social-posting SDKs on
[Hermoso](https://hermoso.ai)'s API. Change one import and your API key; the method names and argument shapes stay
the same.

| You use | Node | Python |
|---|---|---|
| Ayrshare (`social-media-api` / `social-post-api`) | `@hermoso/compat/ayrshare` | `hermoso_compat.ayrshare` |
| Zernio (`@zernio/node` / `zernio-sdk`) | `@hermoso/compat/zernio` | `hermoso_compat.zernio` |
| Postiz (`@postiz/node`) | `@hermoso/compat/postiz` | (Postiz ships no Python SDK) |

> **Not affiliated.** This package is written and maintained by Hermoso. It is not affiliated with, endorsed by or
> sponsored by Ayrshare, Zernio or Postiz. Their names appear only to say which SDK each layer is compatible with;
> all trademarks belong to their owners.

```bash
npm install @hermoso/compat        # Node 18.17+
pip install hermoso-compat         # Python 3.9+, no dependencies
```

Get a Hermoso API key at [app.hermoso.ai](https://app.hermoso.ai) (the **API, MCP & CLI** tab) and connect your
channels there, or hand your customers a connect link (`generateJWT` / `getConnectUrl` below). Publishing and
scheduling cost no Hermoso credits.

## Switch in one line

**Ayrshare, Node**

```diff
- import SocialMediaAPI from 'social-media-api';
+ import SocialMediaAPI from '@hermoso/compat/ayrshare';

  const social = new SocialMediaAPI(process.env.HERMOSO_API_KEY);
  await social.post({ post: 'Hello', platforms: ['twitter', 'linkedin'], mediaUrls: ['https://…/a.png'] });
```

**Ayrshare, Python**

```diff
- from ayrshare import SocialPost
+ from hermoso_compat.ayrshare import SocialPost

  social = SocialPost(os.environ["HERMOSO_API_KEY"])
  social.post({"post": "Hello", "platforms": ["twitter", "linkedin"]})
```

**Zernio, Node**

```diff
- import Zernio from '@zernio/node';
+ import Zernio from '@hermoso/compat/zernio';

  const zernio = new Zernio({ apiKey: process.env.HERMOSO_API_KEY });
  const { data } = await zernio.posts.createPost({ body: { content: 'Hello', platforms: [{ platform: 'twitter', accountId: 'x' }], publishNow: true } });
```

**Zernio, Python**

```diff
- from zernio import Zernio
+ from hermoso_compat.zernio import Zernio

  client = Zernio(api_key=os.environ["HERMOSO_API_KEY"])
  client.posts.create(content="Hello", platforms=[{"platform": "twitter", "accountId": "x"}], publish_now=True)
```

**Postiz, Node**

```diff
- import Postiz from '@postiz/node';
+ import Postiz from '@hermoso/compat/postiz';

  const postiz = new Postiz(process.env.HERMOSO_API_KEY);
```

## How the concepts map

| Their word | Hermoso | Notes |
|---|---|---|
| Ayrshare Profile-Key, Zernio `profileId` | a brand id (`GET /v1/brands`), sent as `X-Hermoso-User` | A brand another account shared with you is `<brandId>:<ownerAccountId>`; `getProfiles` / `listProfiles` return it in that form. |
| Zernio `accountId`, Postiz integration `id` | `<channel>` or `<channel>:<account>` | `listAccounts` / `integrations` list them. The account part is a Facebook Page, LinkedIn Page, Pinterest board or Business location id, or one account of a channel that holds several (TikTok, X, YouTube, Threads, Bluesky, Telegram). |
| `twitter` | `x` | |
| `gmb`, `googlebusiness` | `google_business` | |
| A scheduled post's id | a Hermoso post id (`job_…`) | |
| Ayrshare auto-schedule, Zernio queue | posting queues (`manage_post_queues`) | Zernio's per-weekday slots are kept exactly. |
| Webhooks | the brand's webhook alert channel | One webhook URL per brand. Signed the Standard Webhooks way (`webhook-id`, `webhook-timestamp`, `webhook-signature`); the secret is returned when you first register. Event names are translated both ways; an event Hermoso does not send is listed in `warnings`. |
| Ayrshare `generateJWT`, Zernio `getConnectUrl` | a connect link (`POST /v1/connect-links`) | Hermoso links connect one platform each, so pass `allowedSocial`. |

**Behaviour you should know about**

- **Publish now waits for the result**, like Ayrshare and Zernio do, up to 2 minutes (Ayrshare) or 5 (Zernio):
  options `waitForPublish` / `publishTimeoutMs` (Node) and `wait_for_publish` / `publish_timeout` (Python).
- **Media URLs are copied to Hermoso's storage** before posting, so a link that expires does not break a scheduled
  post. Turn it off with `rehostMedia: false`.
- **Errors keep each SDK's style.** The Ayrshare layer returns `{ status: 'error', code, message }` instead of
  throwing, as Ayrshare's SDK does; the Zernio layer throws `ZernioApiError` and its subclasses. Hermoso's own `code`
  (for example `channel_not_connected`) is passed through.
- **A method this layer does not serve throws `HermosoUnsupportedError`** (in every layer, Ayrshare included), and
  its message names the Hermoso tool that does the job. Every Hermoso tool is one call away:
  `client.callTool(name, args)` (Node) or `client.call_tool(name, args)` (Python), which is `POST /v1/tools/{name}`.
  The list: `GET https://app.hermoso.ai/v1/tools`.
- **X needs no keys of your own.** Ayrshare's `setTwitterByo` is accepted and ignored; Hermoso posts through the X
  account the brand connected.
- **Deleting a published post** is each platform's own delete in Hermoso. `delete` / `deletePost` cancel a post that
  has not gone out yet; for one that has, the error names the tool per platform (`delete_x_post`, `manage_meta_post`, …).

## Method coverage

✅ served · ◐ served with a difference noted · ✖ throws `HermosoUnsupportedError` naming the tool

### Ayrshare

Node names first; the Python name follows where it differs.

| Method | | Hermoso |
|---|---|---|
| `post` | ✅ | `POST /v1/posts`. `profileKeys` posts to each brand. Platform options mapped: YouTube, Instagram, Facebook, LinkedIn, Pinterest, TikTok, X, Google Business, Telegram, Threads, Bluesky. `requiresApproval` and `randomPost` ✖. |
| `delete` | ◐ | Cancels a scheduled post (`id`, `bulk`, `deleteAllScheduled`). A published one: the error names each platform's delete tool. |
| `updatePost` | ✅ | `PATCH /v1/posts/{id}` (time, text, media, platforms) |
| `retryPost` | ✅ | `retry_scheduled` |
| `getPost` | ✅ | `GET /v1/posts/{id}` |
| `history` | ✅ | `GET /v1/posts`; `history({ platform })` reads what is on that channel (`list_published_posts`) |
| `media` | ✅ | `GET /v1/library` |
| `verifyMediaExists` | ✅ | a HEAD request from your process |
| `mediaUploadUrl` | ◐ | `upload_file`. PUT the bytes to `uploadUrl`; its response body holds the final `url` (`accessUrl` is null). |
| `upload` | ✅ | `POST /v1/media` |
| `analyticsPost` | ✅ | the post's measured numbers (`list_published_posts`) |
| `analyticsSocial` | ✅ | `GET /v1/analytics/follower-history` |
| `user` | ✅ | brands, connections, credits |
| `createProfile` | ✅ | `create_brand` |
| `updateProfile` | ✅ | `update_brand` (sets the brand's name) |
| `getProfiles` | ✅ | `GET /v1/brands` |
| `deleteProfile` | ✖ | `delete_brand` (irreversible, confirm-gated: use MCP or the app) |
| `generateJWT` | ✅ | `POST /v1/connect-links`, one per `allowedSocial` platform |
| `unlinkSocial` | ✅ | `DELETE /v1/connections/{provider}` |
| `postComment`, `getComments`, `replyComment`, `deleteComments` | ✅ | Facebook, Instagram, YouTube (no top-level comment), TikTok, LinkedIn Pages, Threads |
| `setAutoSchedule`, `deleteAutoSchedule`, `listAutoSchedule` | ✅ | `manage_post_queues` |
| `registerWebhook`, `unregisterWebhook`, `listWebhooks` | ✅ | actions `social`, `scheduled`, `messages`, `comments`, `reviews`, `mentions` |
| `generatePost`, `generateRewrite`, `generateTranslation` (+ Python `generateSentiment`) | ✅ | `generate_text` (billed in Hermoso credits) |
| `generateTranscription` | ✅ | `analyze_video` (billed in Hermoso credits) |
| `reviews`, `review`, `replyReview` / `reviewReply`, `deleteReplyReview` / `deleteReviewReply` | ✅ | Google Business Profile and Facebook Page reviews |
| `setProfileKey`, `setTwitterByo` / `set_twitter_byo`, `clearTwitterByo` / `clear_twitter_byo` | ✅ | |
| `feedAdd` / `addFeed`, `feedGet` / `getFeeds`, `feedUpdate` / `updateFeed`, `feedDelete` / `deleteFeed` | ✖ | `set_post_refill` (autopilot posting) |
| `shorten`, `shortLink`, `shortLinkAnalytics`, `analyticsLinks` | ✖ | `set_tracking_links` |
| `generateAltText`, `autoHashtags` | ✖ | `generate_text` |
| `recommendHashtags` | ✖ | `tiktok_hashtag_suggestions` |
| `checkBannedHashtags` | ✖ | `check_ad_policy` |
| `mediaMeta` | ✖ | `analyze_video` |
| `resizeImage` | ✖ | `resize_ad` |
| `getBrandByUser` | ✖ | `fetch_social_data` |

### Zernio

Node `namespace.method`; Python uses the same namespace with snake_case names (`posts.create_post`), plus the short
names (`posts.create`, `posts.list`, `posts.get`, `posts.update`, `posts.delete`, `posts.retry`, `accounts.list`,
`profiles.list`, `queue.get_slots`, `queue.update_slots`, `queue.delete_slots`, `analytics.get`, `media.upload`,
`media.upload_bytes`) and every `a…` async twin.

| Method | | Hermoso |
|---|---|---|
| `posts.createPost` | ◐ | `POST /v1/posts`. `publishNow`, `scheduledFor`, `queuedFromProfile`/`queueId`, `dryRun` (validated against each channel's limits, nothing created), `customContent`, `mediaItems`, `platformSpecificData`, `tiktokSettings`, `Idempotency-Key`. Drafts (`isDraft`, or none of the three timings) ✖ `schedule_post`. `customMedia` and per-platform `scheduledFor` are reported in `warnings`. |
| `posts.listPosts`, `getPost`, `updatePost`, `deletePost`, `retryPost` | ✅ | `/v1/posts`, `retry_scheduled` |
| `posts.editPost`, `pinPost`, `unpinPost`, `unpublishPost` | ✖ | `manage_meta_post` (and each platform's own tool) |
| `posts.bulkUploadPosts` | ✖ | `import_posts_csv` |
| `profiles.listProfiles`, `createProfile`, `getProfile`, `updateProfile` | ✅ | `/v1/brands`, `create_brand`, `update_brand` |
| `profiles.deleteProfile` | ✖ | `delete_brand` |
| `accounts.listAccounts`, `getAccount`, `deleteAccount`, `getAllAccountsHealth`, `getAccountHealth`, `getFollowerStats`, `getAccountPosts` | ✅ | `/v1/channels`, `/v1/connections`, follower history, `list_published_posts` |
| `accounts.getGoogleBusinessReviews`, `replyToGoogleBusinessReview`, `deleteGoogleBusinessReviewReply` | ✅ | Google Business Profile tools |
| `media.getMediaPresignedUrl` | ◐ | `upload_file`. `publicUrl` is null: the PUT's response body holds the URL. Python `media.upload(path)` / `upload_bytes(...)` return `publicUrl` directly. |
| `queue.listQueueSlots`, `createQueueSlot`, `updateQueueSlot`, `deleteQueueSlot` | ✅ | `manage_post_queues` |
| `webhooks.getWebhookSettings`, `createWebhookSettings`, `updateWebhookSettings`, `deleteWebhookSettings`, `testWebhook`, `getWebhookLogs`, `redeliverWebhookEvent` | ✅ | the webhook alert channel |
| `connect.getConnectUrl`, `createPlatformInvite` | ✅ | `POST /v1/connect-links` |
| `analytics.getAnalytics`, `getBestTimeToPost`, `getContentDecay`, `getPostingFrequency`, `getInstagramFollowerHistory` | ✅ | `list_published_posts`, `/v1/analytics/*` |
| `users.getCurrentUser`, `usage.getUsageStats`, `usage.getUsage` | ✅ | `/v1/brands`, `/v1/account/email`, `/v1/credits` |
| `comments.getInboxPostComments`, `replyToInboxPost`, `deleteInboxComment`, `hideInboxComment`, `unhideInboxComment`, `sendPrivateReplyToComment` | ✅ | per-platform comment tools |
| `reviews.listInboxReviews`, `replyToInboxReview`, `deleteInboxReviewReply` | ✅ | Google Business Profile and Facebook Page reviews |
| `validate.validatePostLength`, `validatePost` | ✅ | each channel's limits from `/v1/channels` |
| Every other method, in any namespace (ads, WhatsApp, SMS, email, CRM, …) | ✖ | The error names the closest tool where there is one (`create_meta_campaign`, `send_whatsapp_message`, `send_sms`, `list_inbox`, …), else a `/v1/tools?search=` link. |

### Postiz

| Method | | Hermoso |
|---|---|---|
| `post` | ◐ | `POST /v1/posts`, one Hermoso post per entry in `posts[]`. Extra `value[]` items become an X thread, or the first comment elsewhere. `type: 'draft'` ✖ `schedule_post`. |
| `postList` | ✅ | `GET /v1/posts` (`startDate`/`endDate`, or `display` week/month) |
| `upload` | ✅ | `POST /v1/media` |
| `integrations` | ✅ | `/v1/channels` + `/v1/connections` |
| `deletePost` | ✅ | `DELETE /v1/posts/{id}` (resolves with a Response-like object, as the original does) |

## Zernio REST → Hermoso REST

If you call Zernio's HTTP API directly, this is where each call goes. Hermoso's base URL is
`https://app.hermoso.ai`, auth is `Authorization: Bearer hmk_…`, and the brand is the `X-Hermoso-User` header.
Responses are Hermoso's own shapes (documented at [hermoso.ai/docs/api](https://hermoso.ai/docs/api/)); to keep
Zernio's shapes, run the call through this package: `zernio.request('POST', '/v1/posts', { body })`.

| Zernio | Hermoso |
|---|---|
| `POST /v1/posts` | `POST /v1/posts` (`content`→`caption`, `platforms[].platform`→`channels[]`, `scheduledFor`→`scheduled_at`, `customContent`→`captions_by_channel`, `mediaItems`→`media`; omit `scheduled_at` to publish now) |
| `GET /v1/posts`, `GET/PUT/DELETE /v1/posts/{id}` | `GET /v1/posts`, `GET/PATCH/DELETE /v1/posts/{id}` |
| `POST /v1/posts/{id}/retry` | `POST /v1/tools/retry_scheduled` `{"id"}` |
| `GET /v1/accounts` | `GET /v1/channels` (`connected: true`) and `GET /v1/connections` |
| `DELETE /v1/accounts/{id}` | `DELETE /v1/connections/{provider}?account=` |
| `GET /v1/profiles`, `POST /v1/profiles` | `GET /v1/brands`, `POST /v1/tools/create_brand` |
| `POST /v1/media/presign` | `POST /v1/media` (bytes or `?url=`), or `POST /v1/tools/upload_file` `{"getUploadUrl": true}` |
| `GET/POST/PUT/DELETE /v1/queue/slots` | `POST /v1/tools/manage_post_queues` (`action` list / save / delete) |
| `GET/POST/PUT/DELETE /v1/webhooks/settings` | `POST /v1/tools/connect_connector` `{"provider":"webhook","fields":{"webhookUrl"}}`, `set_alert_events`, `list_alert_settings`, `disconnect_connector` |
| `POST /v1/webhooks/test`, `GET /v1/webhooks/logs`, `POST /v1/webhooks/logs/redeliver` | `send_test_alert`, `list_alert_settings` (`deliveries`), `redeliver_webhook` |
| `GET /v1/connect/{platform}` | `POST /v1/connect-links` `{"provider"}` |
| `GET /v1/analytics` | `POST /v1/tools/list_published_posts` |
| `GET /v1/analytics/best-time`, `/content-decay`, `/posting-frequency` | same paths under `/v1/analytics/` |
| `GET /v1/accounts/follower-stats` | `GET /v1/analytics/follower-history` |
| `GET /v1/users/me`, `GET /v1/usage-stats` | `GET /v1/brands`, `GET /v1/account/email`, `GET /v1/credits` |
| `/v1/inbox/comments/…`, `/v1/inbox/reviews/…` | the per-platform comment and review tools (`list_meta_comments`, `reply_to_meta_comment`, `list_google_business_reviews`, …) |
| anything else | `GET /v1/tools?search=<what you need>` |

## Beyond what you had

The same key reaches everything else Hermoso does: generate image and video ads, research competitors' ads, run paid
campaigns, read analytics, and call every tool in Hermoso's catalog. Use the official SDKs for that:
[`@hermoso/sdk`](https://www.npmjs.com/package/@hermoso/sdk), [`hermoso`](https://pypi.org/project/hermoso/), and
[more languages](https://hermoso.ai/docs/sdks/).

## How this was tested

`npm test` (Node) and `python -m unittest discover -s python/tests` run each layer against a stand-in for the API.
Before each release the layers are also run end to end against a real Hermoso server with a brand whose only
channel cannot publish, so publish calls fail cleanly and nothing is posted anywhere public.

## License

MIT. Issues and pull requests are welcome.
