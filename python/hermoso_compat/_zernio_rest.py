"""Zernio's REST routes, served by Hermoso. A port of compat/node/src/zernio-rest.js: keep the two in step.

``zernio_route(h, method, path, query=..., body=..., headers=...)`` answers with the body Zernio's endpoint would
answer, or raises. Unofficial: written by Hermoso, not affiliated with or endorsed by Zernio."""

from __future__ import annotations

import re
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Any, Callable

from ._core import (COMMENT_TOOLS, PUBLISHED_DELETE_TOOLS, TERMINAL, HermosoApiError, HermosoClient,
                    HermosoUnsupportedError, brand_key_of, from_channel, split_account_id, to_channel)


def Z(c: Any) -> str:
    return from_channel(c, "zernio")


TARGET_FIELD = {"facebook": "pageId", "instagram": "pageId", "threads": "pageId", "linkedin": "linkedinOrganizationId",
                "google_business": "locationId", "telegram": "chatId", "pinterest": "boardId", "whop": "whopExperienceId"}

ZERNIO_EVENTS = {
    "post.published": "post.published", "post.failed": "post.failed", "post.partial": "post.partial",
    "post.platform.published": "post.channel.published", "post.platform.failed": "post.channel.failed", "post.platform.deleted": "post.deleted",
    "account.connected": "account.connected", "account.disconnected": "account.disconnected", "account.permissions_changed": "account.permissions_changed",
    "account.restricted": "account.broken", "comment.received": "comment.received", "message.received": "message.received",
    "mention.received": "mention.received", "review.new": "review.received", "lead.received": "lead.created",
    "ad.review.rejected": "ad.rejected", "ad.delivery_issue": "ad.delivery_issue", "campaign.budget.depleted": "budget.exhausted", "balance.low": "credits.low",
}
FROM_HERMOSO_EVENT = {h: z for z, h in ZERNIO_EVENTS.items()}


def _ms(iso: Any) -> float:
    if not iso:
        return 0.0
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return 0.0


def _iso(v: Any) -> str:
    if isinstance(v, datetime):
        return (v if v.tzinfo else v.replace(tzinfo=timezone.utc)).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return datetime.fromtimestamp(_ms(v) / 1000, timezone.utc).isoformat().replace("+00:00", "Z")


def z_status(s: Any) -> Any:
    return {"scheduled": "scheduled", "processing": "publishing", "published": "published", "partially_published": "partial",
            "failed": "failed", "indeterminate": "failed"}.get(s, s)


def z_post(p: dict) -> dict:
    results = p.get("results") or []
    plats = []
    for ch in p.get("channels") or []:
        r = next((x for x in results if x.get("channel") == ch), None)
        field = TARGET_FIELD.get(ch)
        ref = (p.get("targets") or {}).get(field) if field else None
        item = {"platform": Z(ch), "accountId": f"{ch}:{ref}" if ref else ch,
                "customContent": (p.get("captions_by_channel") or {}).get(ch),
                "status": ("published" if r.get("ok") else "failed") if r else ("scheduled" if p.get("status") == "scheduled" else z_status(p.get("status"))),
                "platformPostUrl": (r or {}).get("url")}
        if r and r.get("id"):
            item["platformPostId"] = r["id"]
        if r and r.get("ok"):
            item["publishedAt"] = p.get("scheduled_at")
        if r and not r.get("ok"):
            item["errorMessage"] = r.get("error")
            item["errorSource"] = "platform"
        plats.append(item)
    meta = {"hermosoStatus": p.get("status")}
    if p.get("status_detail"):
        meta["statusDetail"] = p["status_detail"]
    return {"_id": p.get("id"), "title": p.get("title") or None, "content": p.get("caption") or "",
            "mediaItems": [{"type": m.get("type") or "image", "url": m.get("url")} for m in p.get("media") or []],
            "platforms": plats, "scheduledFor": p.get("scheduled_at"), "timezone": "UTC", "status": z_status(p.get("status")),
            "visibility": p.get("visibility"), "metadata": meta, "createdAt": p.get("created_at"), "updatedAt": p.get("created_at")}


def z_profile(b: dict) -> dict:
    return {"_id": brand_key_of(b), "name": b.get("name"), "isDefault": bool(b.get("is_default")), "description": "",
            "timezone": None, "role": b.get("role"), "shared": bool(b.get("shared"))}


def z_account(r: dict, profile_id: Any) -> dict:
    return {"_id": r["accountId"], "platform": Z(r["channel"]), "profileId": profile_id or "default",
            "username": r.get("handle") or r.get("label"), "displayName": r.get("label") or r.get("handle") or r.get("name"),
            "platformUserId": r.get("ref"), "isActive": not r.get("needsReconnect"), "needsReconnection": r.get("needsReconnect"),
            "enabled": True, "profilePicture": None}


def _apply_platform_data(ch: str, d: Any, body: dict, warnings: list) -> None:
    if not isinstance(d, dict):
        return
    o = body["options"]
    for k, v in d.items():
        if k in ("title", "youtubeTitle"):
            body.setdefault("title", v)
        elif k in ("visibility", "privacyStatus"):
            body.setdefault("visibility_by_channel", {})[ch] = str(v).lower()
        elif k in ("privacy_level", "privacyLevel"):
            if ch == "tiktok":
                o["privacyLevel"] = v
            else:
                body.setdefault("visibility_by_channel", {})[ch] = "public" if re.search("PUBLIC", str(v), re.I) else "private"
        elif k == "firstComment":
            body["first_comment"] = v
        elif k in ("boardId", "pageId", "locationId", "chatId", "organizationId"):
            body["targets"]["linkedinOrganizationId" if k == "organizationId" else k] = v
        elif k == "link":
            body.setdefault("link", v)
        elif k in ("description", "tags", "categoryId", "madeForKids", "collaborators", "userTags", "altText", "coverUrl", "audioName", "topicTag", "replySettings", "poll"):
            o[k] = v
        elif k in ("containsSyntheticMedia", "isAiGenerated"):
            o["aiGenerated"] = bool(v)
        elif k in ("disable_comment", "disableComment"):
            o["disableComment"] = v
        elif k in ("disable_duet", "disableDuet"):
            o["disableDuet"] = v
        elif k in ("disable_stitch", "disableStitch"):
            o["disableStitch"] = v
        elif k == "shareToFeed":
            o["shareToFeed"] = v
        elif k == "threadItems":
            o["thread"] = [x.get("content", x) if isinstance(x, dict) else x for x in (v or [])]
        elif k == "trialParams":
            o["trialReel"] = True
        elif k == "contentType":
            if v == "story":
                o["story"] = True
        else:
            warnings.append(f"platformSpecificData.{k} ({Z(ch)}) was not applied: Hermoso has no direct equivalent. Pass Hermoso's own field in metadata.hermosoOptions.")


def build_post_body(h: HermosoClient, b: dict, for_update: bool = False) -> tuple[dict, list]:
    warnings: list = []
    body: dict = {"options": {}, "targets": {}}
    platforms = b.get("platforms") if isinstance(b.get("platforms"), list) else []
    if platforms or not for_update:
        body["channels"] = []
    accounts: dict = {}
    for t in platforms:
        channel, ref = split_account_id(t.get("accountId"), t.get("platform"))
        ch = to_channel(t.get("platform") or channel)
        if ch not in body["channels"]:
            body["channels"].append(ch)
        if ref:
            sel = h.account_selector(ch, ref)
            if sel and sel["kind"] == "target":
                body["targets"][sel["field"]] = sel["value"]
            elif sel and sel["kind"] == "accounts":
                accounts.setdefault(ch, []).append(sel["value"])
        cc = t.get("customContent", t.get("platformSpecificContent"))
        if cc is not None:
            body.setdefault("captions_by_channel", {})[ch] = cc
        if t.get("customMedia"):
            warnings.append(f"customMedia ({Z(ch)}) was not applied: a Hermoso post carries one set of media for every channel. Send a separate post for that channel.")
        if t.get("scheduledFor"):
            warnings.append(f"platforms[].scheduledFor ({Z(ch)}) was not applied: a Hermoso post has one time. Send a separate post for that channel.")
        _apply_platform_data(ch, t.get("platformSpecificData"), body, warnings)
        if t.get("youtubeTitle"):
            body.setdefault("title", t["youtubeTitle"])
    if accounts:
        body["options"]["accounts"] = accounts
    if b.get("tiktokSettings"):
        _apply_platform_data("tiktok", b["tiktokSettings"], body, warnings)
    if b.get("content") is not None:
        body["caption"] = b["content"]
    if b.get("title"):
        body["title"] = b["title"]
    items = b.get("mediaItems") if isinstance(b.get("mediaItems"), list) else ([{"url": u} for u in b["mediaUrls"]] if isinstance(b.get("mediaUrls"), list) else None)
    if items is not None:
        body["media"] = []
        for m in items:
            url = m.get("url") if (not h.rehost_media or b.get("dryRun")) else h.rehost(m.get("url"))
            body["media"].append({"url": url, "type": m["type"]} if m.get("type") in ("image", "video") else url)
            if m.get("altText") and "altText" not in body["options"]:
                body["options"]["altText"] = m["altText"]
    if b.get("visibility"):
        body["visibility"] = b["visibility"]
    if b.get("hashtags") or b.get("mentions"):
        warnings.append("hashtags/mentions arrays were not applied: write them into content.")
    hopts = (b.get("metadata") or {}).get("hermosoOptions")
    if isinstance(hopts, dict):
        body["options"].update(hopts)
    if b.get("requiresApproval"):
        warnings.append("requiresApproval was not applied: Hermoso holds posts for approval only in its autopilot review queue.")
    if not body["options"]:
        del body["options"]
    if not body["targets"]:
        del body["targets"]
    return body, warnings


def _not_found(what: str) -> HermosoApiError:
    return HermosoApiError(f"{what} not found.", status=404, code="not_found")


def dry_run_check(h: HermosoClient, body: dict) -> dict:
    chs = h.channels()
    errors = []
    for ch in body.get("channels") or []:
        c = next((x for x in chs if x.get("id") == ch), None)
        if not c:
            errors.append({"platform": Z(ch), "error": f"Hermoso does not publish to {ch}."})
            continue
        if not c.get("available"):
            errors.append({"platform": Z(ch), "error": c.get("unavailable_reason") or "Not available yet."})
        elif not c.get("connected"):
            errors.append({"platform": Z(ch), "error": f"{c.get('name')} is not connected for this profile."})
        text = (body.get("captions_by_channel") or {}).get(ch, body.get("caption") or "")
        if c.get("caption_max") and len(text) > c["caption_max"]:
            errors.append({"platform": Z(ch), "error": f"Content is {len(text)} characters; {c.get('name')} allows {c['caption_max']}."})
        n = len(body.get("media") or [])
        car = c.get("carousel")
        if n > 1 and not car:
            errors.append({"platform": Z(ch), "error": c.get("carousel_unsupported_reason") or f"{c.get('name')} takes one media item."})
        elif n > 1 and car and car.get("effective_max") and n > car["effective_max"]:
            errors.append({"platform": Z(ch), "error": f"{c.get('name')} takes at most {car['effective_max']} media items."})
    return {"valid": not errors, "errors": errors}


def _queues(h: HermosoClient) -> tuple[list, list]:
    r = h.call_tool("manage_post_queues", {"action": "list"})
    d = r.get("data") or {}
    return d.get("queues") or [], d.get("weekdays") or ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]


def z_queue(q: dict, weekdays: list, profile_id: Any) -> dict:
    slots = []
    for d in range(7):
        days = q.get("days") or {}
        times = days[weekdays[d]] if isinstance(days.get(weekdays[d]), list) else (q.get("slots") or [])
        slots.extend({"dayOfWeek": d, "time": t} for t in times)
    return {"_id": q.get("id") or q.get("name"), "profileId": profile_id or "default", "name": q.get("name"), "timezone": q.get("timezone"),
            "slots": slots, "active": True, "isDefault": bool(q.get("isDefault")), "channels": q.get("channels")}


def to_queue_args(b: dict, weekdays: list) -> dict:
    days: dict = {w: [] for w in weekdays}
    for s in b.get("slots") or []:
        days[weekdays[int(s.get("dayOfWeek", 0)) % 7]].append(str(s.get("time"))[:5])
    vals = [sorted(v) for v in days.values()]
    same = all(v == vals[0] for v in vals)
    return {"slots": vals[0] if same else [], "days": days}


def webhook_sink(h: HermosoClient) -> dict:
    r = h.call_tool("list_alert_settings", {"catalog": True})
    d = r.get("data") or {}
    sink = next((s for s in d.get("sinks") or [] if s.get("provider") == "webhook"), None) or {"connected": False}
    groups = {g["key"]: g.get("events") or [] for g in (d.get("catalog") or {}).get("groups") or []}
    names: list = []
    for e in sink.get("events") or []:
        for n in groups.get(e, [e]):
            if n not in names:
                names.append(n)
    deliveries = [x for x in d.get("deliveries") or [] if x.get("provider") == "webhook"]
    return {**sink, "groupsSelected": sink.get("events") or [], "eventNames": names, "deliveries": deliveries}


def fresh_secret(h: HermosoClient) -> str | None:
    try:
        return (h.call_tool("rotate_webhook_signing_secret", {}).get("data") or {}).get("signingSecret")
    except HermosoApiError:
        return None


def z_webhook(s: dict) -> list:
    if not s.get("connected"):
        return []
    return [{"_id": "webhook", "name": "Hermoso webhook", "events": [FROM_HERMOSO_EVENT.get(e, e) for e in s["eventNames"]],
             "isActive": bool(s["eventNames"]), "signed": s.get("signed"), "state": s.get("state"), "lastFiredAt": s.get("lastDeliveredAt")}]


def to_hermoso_events(events: list | None) -> tuple[list, list]:
    out: list = []
    dropped: list = []
    for e in events or []:
        if e in ZERNIO_EVENTS:
            if ZERNIO_EVENTS[e] not in out:
                out.append(ZERNIO_EVENTS[e])
        else:
            dropped.append(e)
    return out, dropped


def _comment_target(h: HermosoClient, post_id: str, account_id: Any) -> tuple[str, str]:
    if str(post_id).startswith("job_"):
        p = h.get_post(post_id)
        want = split_account_id(account_id)[0] if account_id else None
        r = next((x for x in p.get("results") or [] if x.get("ok") and (not want or x.get("channel") == want)), None)
        if not r:
            raise _not_found(f"A published platform post for {post_id}")
        return r["channel"], str(r["id"])
    channel = split_account_id(account_id)[0] if account_id else ""
    if not channel:
        raise HermosoApiError("accountId is required to tell which platform the post is on.", status=400, code="missing_account_id", param="accountId")
    return channel, str(post_id)


NS_TOOLS = {
    "whatsapp": "send_whatsapp_message", "whatsapptemplates": "send_whatsapp_message", "broadcasts": "send_whatsapp_broadcast", "sms": "send_sms",
    "email": "send_email", "messages": "list_inbox", "contacts": "list_contacts", "adcampaigns": "create_meta_campaign", "ad_campaigns": "create_meta_campaign",
    "adinsights": "meta_insights", "ad_insights": "meta_insights", "adcreatives": "create_meta_ad", "ad_creatives": "create_meta_ad", "reddit": "search_reddit",
    "mentions": "x_mentions", "users": "list_team", "invites": "invite_member", "logs": "list_jobs", "usage": "hermoso_credits",
}
SPECIAL = {
    "posts.editPost": "manage_meta_post", "posts.pinPost": "manage_meta_post", "posts.unpinPost": "manage_meta_post", "posts.bulkUploadPosts": "import_posts_csv",
    "posts.unpublishPost": "manage_meta_post", "profiles.deleteProfile": "delete_brand", "profiles.getProfileLimits": "get_credit_limits",
    "analytics.getInstagramAccountInsights": "instagram_insights", "analytics.getYouTubeChannelInsights": "youtube_channel_report",
    "analytics.getLinkedInOrgAggregateAnalytics": "linkedin_page_analytics", "analytics.getTikTokAccountInsights": "tiktok_account_insights",
    "analytics.getFacebookPageInsights": "meta_page_insights", "analytics.getGoogleBusinessPerformance": "google_business_insights",
    "analytics.getPinterestAccountInsights": "pinterest_analytics", "analytics.getLinkedInPostAnalytics": "list_published_posts",
    "analytics.runGoogleAnalyticsReport": "analytics_report", "queue.getNextQueueSlot": "manage_post_queues", "queue.previewQueue": "manage_post_queues",
    "media.prepareMedia": "upload_file", "comments.listInboxComments": "list_inbox", "comments.likeInboxComment": "moderate_tiktok_comment",
    "comments.pinInboxComment": "moderate_tiktok_comment", "accounts.updateAccount": "set_connector_accounts", "accounts.moveAccountToProfile": "set_connector_accounts",
    "comments.editInboxComment": "list_inbox",
}


def _camel(s: str) -> str:
    return re.sub(r"_([a-z0-9])", lambda m: m.group(1).upper(), s)


def unsupported(ns: str, method: str) -> HermosoUnsupportedError:
    camel = _camel(method)
    tool = SPECIAL.get(f"{_camel(ns)}.{camel}") or SPECIAL.get(f"{ns}.{camel}") or NS_TOOLS.get(ns.lower())
    return HermosoUnsupportedError(f"zernio.{ns}.{method}", tool)


# ── ROUTES ───────────────────────────────────────────────────────────────────────────────────────────────────────
Handler = Callable[[HermosoClient, dict, dict, dict, dict], Any]
ROUTES: dict[str, Handler] = {}


def route(key: str) -> Callable[[Handler], Handler]:
    def deco(fn: Handler) -> Handler:
        ROUTES[key] = fn
        return fn
    return deco


@route("GET /v1/posts")
def _list_posts(h, p, q, b, hd):
    posts = h.list_posts(max=1000, channel=to_channel(q["platform"]) if q.get("platform") else None)
    if q.get("status"):
        posts = [x for x in posts if z_status(x.get("status")) == q["status"]]
    frm = q.get("dateFrom") or q.get("fromDate")
    to = q.get("dateTo") or q.get("toDate")
    if frm:
        posts = [x for x in posts if _ms(x.get("scheduled_at")) >= _ms(_iso(frm))]
    if to:
        posts = [x for x in posts if _ms(x.get("scheduled_at")) <= _ms(_iso(to))]
    if q.get("search"):
        posts = [x for x in posts if str(q["search"]).lower() in str(x.get("caption") or "").lower()]
    if "asc" in str(q.get("sortBy") or ""):
        posts.reverse()
    limit = max(1, min(100, int(q.get("limit") or 10)))
    page = max(1, int(q.get("page") or 1))
    sl = posts[(page - 1) * limit: page * limit]
    return {"posts": [z_post(x) for x in sl], "pagination": {"page": page, "limit": limit, "total": len(posts), "pages": -(-len(posts) // limit),
                                                              "nextCursor": str(page + 1) if page * limit < len(posts) else None}}


@route("POST /v1/posts")
def _create_post(h, p, q, b, hd):
    if b.get("isDraft") or not (b.get("publishNow") or b.get("scheduledFor") or b.get("queuedFromProfile") or b.get("queueId") or b.get("dryRun")):
        raise HermosoUnsupportedError("zernio.posts.create_post (draft)", "schedule_post",
                                      "Hermoso has no unscheduled draft post. Pass publish_now=True or scheduled_for (you can edit or cancel a scheduled post until it fires), or queued_from_profile to take the next queue slot.")
    body, warnings = build_post_body(h, b)
    now = bool(b.get("publishNow")) or bool(b.get("scheduledFor") and _ms(_iso(b["scheduledFor"])) <= time.time() * 1000 + 60000)
    if not now and b.get("scheduledFor"):
        body["scheduled_at"] = _iso(b["scheduledFor"])
    if not now and not b.get("scheduledFor") and (b.get("queuedFromProfile") or b.get("queueId")):
        body["use_queue"] = True
        if b.get("queueId") and b["queueId"] != "default":
            body.setdefault("options", {})["useQueue"] = b["queueId"]
    if b.get("timezone") and body.get("use_queue"):
        body["timezone"] = b["timezone"]
    if b.get("dryRun"):
        v = dry_run_check(h, body)
        return {"message": "Dry run passed. Nothing was created." if v["valid"] else "Dry run failed. Nothing was created.", "dryRun": True,
                "valid": v["valid"], "errors": v["errors"], "warnings": warnings}
    hk = (hd or {}).get("Idempotency-Key") or (hd or {}).get("idempotency-key")
    post = h.request("POST", "/v1/posts", body=body, headers={"Idempotency-Key": str(hk)} if hk else None)
    if now and h.wait_for_publish and post.get("status") not in TERMINAL:
        post = h.wait_for_post(post["id"], h.publish_timeout)
    st = post.get("status")
    msg = {"scheduled": "Post scheduled successfully", "published": "Post published successfully", "processing": "Post is publishing"}.get(st, "Post did not publish on every platform")
    out = {"message": msg, "post": z_post(post)}
    if warnings:
        out["warnings"] = warnings
    return out


@route("GET /v1/posts/{postId}")
def _get_post(h, p, q, b, hd):
    return {"post": z_post(h.get_post(p["postId"]))}


@route("PUT /v1/posts/{postId}")
def _update_post(h, p, q, b, hd):
    body, warnings = build_post_body(h, b, for_update=True)
    if b.get("scheduledFor"):
        body["scheduled_at"] = _iso(b["scheduledFor"])
    if "channels" in body and not body["channels"]:
        del body["channels"]
    post = h.request("PATCH", f"/v1/posts/{urllib.parse.quote(p['postId'])}", body=body)
    out = {"message": "Post updated successfully", "post": z_post(post)}
    if warnings:
        out["warnings"] = warnings
    return out


@route("DELETE /v1/posts/{postId}")
def _delete_post(h, p, q, b, hd):
    try:
        h.request("DELETE", f"/v1/posts/{urllib.parse.quote(p['postId'])}")
        return {"message": "Post deleted successfully"}
    except HermosoApiError as e:
        if e.code == "post_not_cancellable":
            try:
                tools = "; ".join(f"{Z(r['channel'])}: {PUBLISHED_DELETE_TOOLS.get(r['channel'], 'the platform')}" for r in h.get_post(p["postId"]).get("results") or [] if r.get("ok"))
            except HermosoApiError:
                tools = ""
            if tools:
                e.message = f"{e.message} Remove it from each platform with: {tools}."
                e.args = (e.message,)
        raise


@route("POST /v1/posts/{postId}/retry")
def _retry_post(h, p, q, b, hd):
    r = h.call_tool("retry_scheduled", {"id": p["postId"]})
    d = r.get("data") or {}
    pid = d.get("id") or d.get("newId") or (d.get("post") or {}).get("id")
    out = {"message": r.get("text")}
    if pid:
        try:
            out["post"] = z_post(h.get_post(pid))
        except HermosoApiError:
            pass
    return out


@route("GET /v1/profiles")
def _list_profiles(h, p, q, b, hd):
    bs = h.brands()
    return {"profiles": [z_profile(x) for x in bs], "total": len(bs), "skip": 0, "limit": len(bs)}


@route("POST /v1/profiles")
def _create_profile(h, p, q, b, hd):
    r = h.call_tool("create_brand", {"name": b.get("name"), "activate": False})
    br = (r.get("data") or {}).get("brand") or {}
    return {"message": "Profile created successfully", "profile": {"_id": br.get("id"), "name": br.get("name"), "description": b.get("description") or "", "isDefault": False}}


@route("GET /v1/profiles/{profileId}")
def _get_profile(h, p, q, b, hd):
    br = next((x for x in h.brands() if brand_key_of(x) == p["profileId"] or x.get("id") == p["profileId"]), None)
    if not br:
        raise _not_found(f"Profile {p['profileId']}")
    return {"profile": z_profile(br)}


@route("PUT /v1/profiles/{profileId}")
def _update_profile(h, p, q, b, hd):
    if b.get("name"):
        h.for_brand(p["profileId"]).call_tool("update_brand", {"name": b["name"]})
    return {"message": "Profile updated successfully", "profile": {"_id": p["profileId"], "name": b.get("name")}}


@route("GET /v1/accounts")
def _list_accounts(h, p, q, b, hd):
    rows = h.account_rows()
    if q.get("platform"):
        rows = [r for r in rows if r["channel"] == to_channel(q["platform"])]
    return {"accounts": [z_account(r, h.brand) for r in rows], "hasAnalyticsAccess": True}


def _health(r: dict) -> dict:
    return {"accountId": r["accountId"], "platform": Z(r["channel"]), "username": r.get("handle") or r.get("label"),
            "status": "needs_reconnect" if r.get("needsReconnect") else "healthy", "canPost": not r.get("needsReconnect"), "needsReconnect": r.get("needsReconnect")}


@route("GET /v1/accounts/health")
def _all_health(h, p, q, b, hd):
    accts = [_health(r) for r in h.account_rows()]
    return {"summary": {"total": len(accts), "healthy": sum(1 for a in accts if a["canPost"]), "needsReconnect": sum(1 for a in accts if not a["canPost"])}, "accounts": accts}


@route("GET /v1/accounts/follower-stats")
def _follower_stats(h, p, q, b, hd):
    r = h.request("GET", "/v1/analytics/follower-history", query={"from": q.get("fromDate"), "to": q.get("toDate"), "granularity": q.get("granularity")})
    return {"accounts": r.get("accounts") or [], "dateRange": r.get("dateRange"), "granularity": r.get("granularity")}


def _row(h: HermosoClient, account_id: str) -> dict:
    r = next((x for x in h.account_rows() if x["accountId"] == account_id or x["channel"] == account_id), None)
    if not r:
        raise _not_found(f"Account {account_id}")
    return r


@route("GET /v1/accounts/{accountId}")
def _get_account(h, p, q, b, hd):
    return {"account": z_account(_row(h, p["accountId"]), h.brand)}


@route("GET /v1/accounts/{accountId}/health")
def _account_health(h, p, q, b, hd):
    return _health(_row(h, p["accountId"]))


@route("DELETE /v1/accounts/{accountId}")
def _delete_account(h, p, q, b, hd):
    channel, ref = split_account_id(p["accountId"])
    ch = next((c for c in h.channels() if c.get("id") == channel), None)
    r = h.request("DELETE", f"/v1/connections/{urllib.parse.quote((ch or {}).get('connector') or channel)}", query={"account": ref} if ref else None)
    return {"message": r.get("note") or "Account disconnected"}


@route("GET /v1/accounts/{accountId}/posts")
def _account_posts(h, p, q, b, hd):
    channel = split_account_id(p["accountId"])[0]
    args = {"channel": channel, "limit": min(200, int(q.get("limit") or 50))}
    if q.get("cursor"):
        args["cursor"] = q["cursor"]
    d = h.call_tool("list_published_posts", args).get("data") or {}
    return {"posts": [{"platformPostId": x.get("postId"), "platform": Z(x.get("channel")), "content": x.get("caption"), "platformPostUrl": x.get("url"),
                       "publishedAt": _iso(x["publishedAt"]) if x.get("publishedAt") else None, "mediaUrls": x.get("mediaUrls") or []} for x in d.get("posts") or []],
            "nextCursor": d.get("nextCursor")}


@route("GET /v1/accounts/{accountId}/gmb-reviews")
def _gmb_reviews(h, p, q, b, hd):
    args = {}
    if q.get("pageToken"):
        args["pageToken"] = q["pageToken"]
    if q.get("pageSize"):
        args["limit"] = int(q["pageSize"])
    d = h.call_tool("list_google_business_reviews", args).get("data") or {}
    return {"reviews": d.get("reviews") or [], "averageRating": d.get("averageRating"), "totalReviewCount": d.get("totalReviewCount"), "nextPageToken": d.get("nextPageToken")}


@route("POST /v1/accounts/{accountId}/gmb-reviews/{reviewId}/reply")
def _gmb_reply(h, p, q, b, hd):
    r = h.call_tool("reply_to_google_business_review", {"reviewId": p["reviewId"], "comment": b.get("comment") or b.get("reply")})
    return {"success": True, "message": r.get("text")}


@route("DELETE /v1/accounts/{accountId}/gmb-reviews/{reviewId}/reply")
def _gmb_reply_delete(h, p, q, b, hd):
    r = h.call_tool("reply_to_google_business_review", {"reviewId": p["reviewId"], "delete": True, "confirm": True})
    return {"success": True, "message": r.get("text")}


@route("POST /v1/media/presign")
def _presign(h, p, q, b, hd):
    args = {"getUploadUrl": True}
    if b.get("filename"):
        args["name"] = b["filename"]
    d = h.call_tool("upload_file", args).get("data") or {}
    exp = d.get("expiresAt")
    return {"uploadUrl": d.get("uploadUrl"), "publicUrl": None, "key": None,
            "expiresIn": round((_ms(exp) - time.time() * 1000) / 1000) if exp else None,
            "note": "PUT the bytes to uploadUrl: the response body is {url}, the durable public URL to use in mediaItems. (Hermoso names the URL once the file is in.)"}


@route("GET /v1/queue/slots")
def _queue_list(h, p, q, b, hd):
    lst, wd = _queues(h)
    all_q = [z_queue(x, wd, q.get("profileId")) for x in lst]
    if q.get("queueId") and str(q.get("all")).lower() != "true":
        one = next((x for x in all_q if x["_id"] == q["queueId"] or x["name"] == q["queueId"]), None)
        return {"exists": bool(one), "schedule": one, "nextSlots": []}
    return {"queues": all_q, "count": len(all_q)}


@route("POST /v1/queue/slots")
def _queue_create(h, p, q, b, hd):
    _, wd = _queues(h)
    name = b.get("name") or "Default"
    r = h.call_tool("manage_post_queues", {"action": "save", "name": name, "timezone": b.get("timezone") or "UTC", **to_queue_args(b, wd)})
    lst, wd = _queues(h)
    saved = next((x for x in lst if x.get("name") == name), None)
    return {"success": True, "message": r.get("text"), "schedule": z_queue(saved, wd, b.get("profileId")) if saved else None}


@route("PUT /v1/queue/slots")
def _queue_update(h, p, q, b, hd):
    before, wd = _queues(h)
    cur = next((x for x in before if x.get("id") == b.get("queueId") or x.get("name") == b.get("queueId")), None) or next((x for x in before if x.get("isDefault")), None)
    args = {"action": "save", "name": (cur or {}).get("name") or "Default"}
    if b.get("timezone"):
        args["timezone"] = b["timezone"]
    if b.get("slots") is not None:
        args.update(to_queue_args(b, wd))
    if b.get("name") and cur and b["name"] != cur.get("name"):
        args["rename"] = b["name"]
    r = h.call_tool("manage_post_queues", args)
    lst, wd = _queues(h)
    saved = next((x for x in lst if x.get("name") == args.get("rename", args["name"])), None)
    return {"success": True, "message": r.get("text"), "schedule": z_queue(saved, wd, b.get("profileId")) if saved else None}


@route("DELETE /v1/queue/slots")
def _queue_delete(h, p, q, b, hd):
    lst, _ = _queues(h)
    cur = next((x for x in lst if x.get("id") == q.get("queueId") or x.get("name") == q.get("queueId")), None)
    r = h.call_tool("manage_post_queues", {"action": "delete", "name": (cur or {}).get("name") or q.get("queueId") or "Default"})
    return {"success": True, "message": r.get("text")}


@route("GET /v1/webhooks/settings")
def _wh_get(h, p, q, b, hd):
    return {"webhooks": z_webhook(webhook_sink(h))}


@route("POST /v1/webhooks/settings")
def _wh_create(h, p, q, b, hd):
    h.call_tool("connect_connector", {"provider": "webhook", "fields": {"webhookUrl": b.get("url")}})
    secret = fresh_secret(h)
    events, dropped = to_hermoso_events(b.get("events"))
    h.call_tool("set_alert_events", {"provider": "webhook", "events": [] if b.get("isActive") is False else events})
    ws = z_webhook(webhook_sink(h))
    w = dict(ws[0]) if ws else {}
    w.update({"name": b.get("name") or w.get("name"), "url": b.get("url"), "secret": secret})
    warnings = ([f"Not delivered by Hermoso: {', '.join(dropped)}."] if dropped else []) + (
        ["secret was not applied: Hermoso signs with its own secret (returned here) using the Standard Webhooks headers webhook-id, webhook-timestamp, webhook-signature."] if b.get("secret") else [])
    out = {"message": "Webhook created", "webhook": w}
    if warnings:
        out["warnings"] = warnings
    return out


@route("PUT /v1/webhooks/settings")
def _wh_update(h, p, q, b, hd):
    cur = webhook_sink(h)
    if b.get("url"):
        h.call_tool("connect_connector", {"provider": "webhook", "fields": {"webhookUrl": b["url"]}})
    dropped: list = []
    if b.get("events") is not None or b.get("isActive") is not None:
        if b.get("events") is not None:
            events, dropped = to_hermoso_events(b["events"])
        else:
            events = cur["groupsSelected"] or ["posts"]
        h.call_tool("set_alert_events", {"provider": "webhook", "events": [] if b.get("isActive") is False else events})
    ws = z_webhook(webhook_sink(h))
    out = {"message": "Webhook updated", "webhook": ws[0] if ws else None}
    if dropped:
        out["warnings"] = [f"Not delivered by Hermoso: {', '.join(dropped)}."]
    return out


@route("DELETE /v1/webhooks/settings")
def _wh_delete(h, p, q, b, hd):
    return {"message": h.call_tool("disconnect_connector", {"provider": "webhook", "confirm": True}).get("text") or "Webhook deleted"}


@route("POST /v1/webhooks/test")
def _wh_test(h, p, q, b, hd):
    t = h.call_tool("send_test_alert", {"provider": "webhook"}).get("text") or ""
    return {"success": not re.search(r"fail|not deliver|error", t, re.I), "message": t}


@route("GET /v1/webhooks/logs")
def _wh_logs(h, p, q, b, hd):
    s = webhook_sink(h)
    return {"logs": [{"_id": d.get("id"), "event": FROM_HERMOSO_EVENT.get(d.get("event"), d.get("event")), "status": "success" if d.get("outcome") == "ok" else d.get("outcome"),
                      "statusCode": d.get("lastStatus"), "attemptNumber": d.get("attempts"), "createdAt": d.get("firstAt"), "lastAttemptAt": d.get("lastAt"),
                      "redelivered": d.get("redelivered")} for d in s["deliveries"]]}


@route("POST /v1/webhooks/logs/redeliver")
def _wh_redeliver(h, p, q, b, hd):
    r = h.call_tool("redeliver_webhook", {"deliveryId": b.get("logId") or b.get("id") or b.get("deliveryId")})
    return {"success": True, "message": r.get("text")}


def _link(h: HermosoClient, platform: Any, redirect: Any = None) -> dict:
    ch = to_channel(platform)
    c = next((x for x in h.channels() if x.get("id") == ch), None)
    body = {"provider": (c or {}).get("connector") or ch}
    if redirect:
        body["redirect_url"] = redirect
    return h.request("POST", "/v1/connect-links", body=body)


@route("GET /v1/connect/{platform}")
def _connect(h, p, q, b, hd):
    link = _link(h, p["platform"], q.get("redirect_url"))
    return {"authUrl": link.get("url"), "state": link.get("id")}


@route("POST /v1/platform-invites")
def _invite(h, p, q, b, hd):
    link = _link(h, b.get("platform"))
    return {"invite": {"_id": link.get("id"), "token": link.get("id"), "platform": b.get("platform"), "profileId": b.get("profileId"),
                       "inviteUrl": link.get("url"), "expiresAt": link.get("expires_at")}}


def _metrics_of(row: dict | None) -> dict:
    samples = sorted([s for s in (row or {}).get("samples") or [] if s and s.get("ok") is not False], key=lambda s: float(s.get("at") or 0), reverse=True)
    s = samples[0] if samples else None
    m = (s or {}).get("metrics") or {}
    eng = (row or {}).get("engagement") or {}

    def first(*keys):
        for k in keys:
            if m.get(k) is not None:
                return m[k]
        return None
    return {"impressions": first("impressions", "views"), "reach": first("reach"), "likes": first("likes", "like_count"), "comments": first("comments"),
            "shares": first("shares", "reposts"), "saves": first("saves", "saved"), "clicks": first("clicks"), "views": first("views", "video_views"),
            "engagementRate": eng["rate"] * 100 if eng.get("present") else None,
            "lastUpdated": _iso(datetime.fromtimestamp(float(s["at"]) / 1000, timezone.utc)) if s and s.get("at") else None, "raw": m}


@route("GET /v1/analytics")
def _analytics(h, p, q, b, hd):
    rows: list = []
    cursor = None
    for _ in range(5):
        args = {"limit": 200}
        if q.get("platform"):
            args["channel"] = to_channel(q["platform"])
        if cursor:
            args["cursor"] = cursor
        d = h.call_tool("list_published_posts", args).get("data") or {}
        rows.extend(d.get("posts") or [])
        cursor = d.get("nextCursor")
        if not cursor:
            break
    if q.get("postId"):
        ids = [str(q["postId"])]
        if str(q["postId"]).startswith("job_"):
            ids = [str(r["id"]) for r in h.get_post(q["postId"]).get("results") or [] if r.get("ok")]
        hit = [r for r in rows if str(r.get("postId")) in ids or any(str(x) in ids for x in r.get("siblingIds") or [])]
        if not hit:
            raise _not_found(f"Analytics for post {q['postId']}")
        return {"postId": q["postId"], "analytics": _metrics_of(hit[0]),
                "platformAnalytics": [{"platform": Z(r.get("channel")), "platformPostId": r.get("postId"), "platformPostUrl": r.get("url"), "analytics": _metrics_of(r)} for r in hit]}
    limit = max(1, min(100, int(q.get("limit") or 50)))
    page = max(1, int(q.get("page") or 1))
    sl = rows[(page - 1) * limit: page * limit]
    return {"posts": [{"_id": r.get("id"), "platformPostId": r.get("postId"), "platform": Z(r.get("channel")), "content": r.get("caption"),
                       "publishedAt": _iso(datetime.fromtimestamp(float(r["publishedAt"]) / 1000, timezone.utc)) if r.get("publishedAt") else None,
                       "platformPostUrl": r.get("url"), "analytics": _metrics_of(r)} for r in sl],
            "pagination": {"page": page, "limit": limit, "total": len(rows), "pages": -(-len(rows) // limit)}}


@route("GET /v1/analytics/best-time")
def _best_time(h, p, q, b, hd):
    return h.request("GET", "/v1/analytics/best-time", query={"channel": to_channel(q["platform"]) if q.get("platform") else None, "days": q.get("days"), "timezone": q.get("timezone")})


@route("GET /v1/analytics/content-decay")
def _decay(h, p, q, b, hd):
    return h.request("GET", "/v1/analytics/content-decay", query={"channel": to_channel(q["platform"]) if q.get("platform") else None})


@route("GET /v1/analytics/posting-frequency")
def _freq(h, p, q, b, hd):
    return h.request("GET", "/v1/analytics/posting-frequency", query={"channel": to_channel(q["platform"]) if q.get("platform") else None})


@route("GET /v1/analytics/instagram/follower-history")
def _ig_followers(h, p, q, b, hd):
    return h.request("GET", "/v1/analytics/follower-history", query={"channel": "instagram", "from": q.get("fromDate"), "to": q.get("toDate")})


@route("GET /v1/users/me")
def _me(h, p, q, b, hd):
    brands = h.brands()
    try:
        email = h.request("GET", "/v1/account/email")
    except HermosoApiError:
        email = None
    cur = next((x for x in brands if x.get("current")), {}) or {}
    return {"_id": None, "name": cur.get("name"), "email": (email or {}).get("email"), "role": cur.get("role"), "workspaceId": cur.get("id"), "workspaceName": cur.get("name")}


@route("GET /v1/usage-stats")
def _usage_stats(h, p, q, b, hd):
    c = h.request("GET", "/v1/credits")
    return {"planName": c.get("plan"), "credits": c.get("balance"), "limits": c.get("limits")}


ROUTES["GET /v1/usage"] = _usage_stats


def _comment_args_list(ch: str, pid: str) -> dict:
    return {"videoId": pid} if ch in ("youtube", "tiktok") else {"postUrn": pid} if ch == "linkedin" else {"postId": pid}


@route("GET /v1/inbox/comments/{postId}")
def _comments(h, p, q, b, hd):
    ch, pid = _comment_target(h, p["postId"], q.get("accountId"))
    tools = COMMENT_TOOLS.get(ch)
    if not tools:
        raise HermosoUnsupportedError(f"zernio.comments.get_inbox_post_comments ({Z(ch)})", "list_inbox")
    d = h.call_tool(tools["list"], _comment_args_list(ch, pid)).get("data") or {}
    lst = d.get("comments") or d.get("replies") or d.get("items") or []
    return {"comments": [{"id": c.get("id") or c.get("commentId") or c.get("urn"), "message": c.get("text", c.get("message")),
                          "createdTime": c.get("createdAt") or c.get("created_time") or c.get("timestamp") or c.get("publishedAt"),
                          "from": {"name": c.get("author") or c.get("username") or (c.get("from") or {}).get("name"), "id": c.get("authorId") or (c.get("from") or {}).get("id")},
                          "likeCount": c.get("likeCount", c.get("like_count")), "replyCount": c.get("replyCount", c.get("reply_count")), "platform": Z(ch), "raw": c} for c in lst]}


@route("POST /v1/inbox/comments/{postId}")
def _comment_reply(h, p, q, b, hd):
    ch, pid = _comment_target(h, p["postId"], b.get("accountId"))
    tools = COMMENT_TOOLS.get(ch) or {}
    cid = b.get("commentId")
    tool = tools.get("reply") if cid else tools.get("comment")
    if not tool:
        raise HermosoUnsupportedError(f"zernio.comments.reply_to_inbox_post ({Z(ch)})", "list_inbox")
    text = b.get("message")
    if ch == "tiktok":
        args = {"videoId": pid, "text": text, **({"commentId": cid} if cid else {})}
    elif ch == "youtube":
        args = {"commentId": cid, "text": text}
    elif ch == "linkedin":
        args = {"postUrn": pid, "text": text, **({"parentComment": cid} if cid else {})}
    elif ch == "threads":
        args = {"replyToId": cid or pid, "text": text}
    else:
        args = {"commentId": cid, "message": text} if cid else {"postId": pid, "message": text}
    r = h.call_tool(tool, args)
    d = r.get("data") or {}
    return {"success": True, "commentId": d.get("id") or d.get("commentId"), "message": r.get("text")}


@route("DELETE /v1/inbox/comments/{postId}")
def _comment_delete(h, p, q, b, hd):
    ch, pid = _comment_target(h, p["postId"], q.get("accountId"))
    tools = COMMENT_TOOLS.get(ch)
    if not tools:
        raise HermosoUnsupportedError(f"zernio.comments.delete_inbox_comment ({Z(ch)})", "list_inbox")
    cid = q.get("commentId")
    if ch == "linkedin":
        args = {"postUrn": pid, "commentId": cid, "confirm": True}
    elif ch == "threads":
        args = {"replyId": cid, "hide": True}
    elif ch == "tiktok":
        args = {"commentId": cid, "action": "DELETE", "videoId": pid, "confirm": True}
    else:
        args = {"commentId": cid, "action": "delete", "confirm": True}
    return {"success": True, "message": h.call_tool(tools["moderate"], args).get("text")}


def _hide(h, p, account_id, hide):
    ch, pid = _comment_target(h, p["postId"], account_id)
    tools = COMMENT_TOOLS.get(ch)
    if not tools or ch == "linkedin":
        raise HermosoUnsupportedError("zernio.comments.hide_inbox_comment", "delete_linkedin_comment" if ch == "linkedin" else "list_inbox")
    cid = p["commentId"]
    if ch == "threads":
        args = {"replyId": cid, "hide": hide}
    elif ch == "tiktok":
        args = {"commentId": cid, "action": "HIDE" if hide else "UNHIDE", "videoId": pid}
    elif ch == "youtube":
        args = {"commentId": cid, "action": "hold" if hide else "publish"}
    else:
        args = {"commentId": cid, "action": "hide" if hide else "unhide"}
    return {"success": True, "hidden": hide, "message": h.call_tool(tools["moderate"], args).get("text")}


ROUTES["POST /v1/inbox/comments/{postId}/{commentId}/hide"] = lambda h, p, q, b, hd: _hide(h, p, b.get("accountId") or q.get("accountId"), True)
ROUTES["DELETE /v1/inbox/comments/{postId}/{commentId}/hide"] = lambda h, p, q, b, hd: _hide(h, p, q.get("accountId"), False)


@route("POST /v1/inbox/comments/{postId}/{commentId}/private-reply")
def _private_reply(h, p, q, b, hd):
    ch, _ = _comment_target(h, p["postId"], b.get("accountId"))
    if ch not in ("facebook", "instagram"):
        raise HermosoUnsupportedError(f"zernio.comments.send_private_reply_to_comment ({Z(ch)})", "reply_to_inbox_item")
    r = h.call_tool("reply_to_meta_comment", {"commentId": p["commentId"], "message": b.get("message"), "private": True})
    return {"success": True, "message": r.get("text")}


@route("GET /v1/inbox/reviews")
def _reviews(h, p, q, b, hd):
    ch = to_channel(q["platform"]) if q.get("platform") else (split_account_id(q["accountId"])[0] if q.get("accountId") else "google_business")
    r = h.call_tool("meta_page_reviews", {"action": "list"}) if ch == "facebook" else h.call_tool("list_google_business_reviews", {})
    d = r.get("data") or {}
    return {"reviews": [{"id": x.get("id") or x.get("reviewId") or x.get("name"), "platform": Z(ch), "rating": x.get("rating", x.get("starRating")),
                         "text": x.get("text", x.get("comment")), "reviewer": {"name": (x.get("reviewer") or {}).get("displayName") if isinstance(x.get("reviewer"), dict) else (x.get("reviewer") or x.get("author"))},
                         "created": x.get("createTime") or x.get("created_time"), "reply": x.get("reply"), "raw": x} for x in d.get("reviews") or d.get("items") or []]}


@route("POST /v1/inbox/reviews/{reviewId}/reply")
def _review_reply(h, p, q, b, hd):
    ch = split_account_id(b["accountId"])[0] if b.get("accountId") else "google_business"
    if ch == "facebook":
        r = h.call_tool("meta_page_reviews", {"action": "reply", "reviewId": p["reviewId"], "text": b.get("message"), "confirm": True})
    else:
        r = h.call_tool("reply_to_google_business_review", {"reviewId": p["reviewId"], "comment": b.get("message")})
    return {"success": True, "message": r.get("text")}


@route("DELETE /v1/inbox/reviews/{reviewId}/reply")
def _review_reply_delete(h, p, q, b, hd):
    r = h.call_tool("reply_to_google_business_review", {"reviewId": p["reviewId"], "delete": True, "confirm": True})
    return {"success": True, "message": r.get("text")}


@route("POST /v1/tools/validate/post-length")
def _validate_len(h, p, q, b, hd):
    n = len(str(b.get("content") or ""))
    return {"content": b.get("content"), "characterCount": n,
            "platforms": {Z(c["id"]): {"count": n, "limit": c["caption_max"], "valid": n <= c["caption_max"]} for c in h.channels() if c.get("caption_max")}}


@route("POST /v1/tools/validate/post")
def _validate_post(h, p, q, b, hd):
    body, warnings = build_post_body(h, {**b, "dryRun": True})
    v = dry_run_check(h, body)
    return {"valid": v["valid"], "errors": v["errors"], "warnings": warnings}


_COMPILED = []
for _key, _fn in ROUTES.items():
    _method, _tpl = _key.split(" ", 1)
    _names = re.findall(r"\{(\w+)\}", _tpl)
    _re = re.compile("^" + re.sub(r"\{\w+\}", "([^/]+)", _tpl) + "$")
    _COMPILED.append((len(_names), _method, _re, _names, _fn, _key))
_COMPILED.sort(key=lambda x: x[0])


def zernio_route(h: HermosoClient, method: str, path: str, *, query: dict | None = None, body: dict | None = None, headers: dict | None = None) -> Any:
    m = method.upper()
    clean = str(path).split("?")[0].rstrip("/")
    query = query or {}
    body = body or {}
    for _, meth, rx, names, fn, key in _COMPILED:
        if meth != m:
            continue
        hit = rx.match(clean)
        if not hit:
            continue
        params = {n: urllib.parse.unquote(hit.group(i + 1)) for i, n in enumerate(names)}
        profile_id = query.get("profileId") or (body.get("profileId") if isinstance(body, dict) else None)
        client = h.for_brand(profile_id) if profile_id and not ("/profiles/" in key and params.get("profileId")) else h
        return fn(client, params, query, body, headers or {})
    raise HermosoUnsupportedError(f"Zernio REST {m} {clean}")
