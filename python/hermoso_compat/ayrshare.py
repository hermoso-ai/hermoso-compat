"""Ayrshare-compatible client (the ``social-post-api`` package's ``SocialPost`` class and method names), served by Hermoso.

    - from ayrshare import SocialPost
    + from hermoso_compat.ayrshare import SocialPost
      social = SocialPost(os.environ["HERMOSO_API_KEY"])

Like the original, every method returns the response as a dict and does not raise on an API error: a refusal comes
back as ``{"status": "error", "code", "message", ...}``. A method this layer cannot serve RAISES
``HermosoUnsupportedError`` naming the Hermoso tool to call instead.

Unofficial: written by Hermoso, not affiliated with or endorsed by Ayrshare.
"""

from __future__ import annotations

import re
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any

from ._core import (COMMENT_TOOLS, PUBLISHED_DELETE_TOOLS, TERMINAL, HermosoApiError, HermosoClient,
                    HermosoUnsupportedError, brand_key_of, from_channel, to_channel)
from ._zernio_rest import fresh_secret, webhook_sink, _ms, _iso


def A(c: Any) -> str:
    return from_channel(c, "ayrshare")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _error(e: Exception, **extra: Any) -> dict:
    if isinstance(e, HermosoUnsupportedError):
        raise e
    he = e if isinstance(e, HermosoApiError) else None
    out: dict = {"status": "error", "code": (he.code if he else None) or "error", "message": he.message if he else str(e)}
    if he and he.connector:
        out["platform"] = A(he.connector)
        out["connector"] = he.connector
    if he:
        out["hermoso"] = {"status": he.status, "type": he.type, "code": he.code, "param": he.param, "connector": he.connector, "requestId": he.request_id}
    out.update(extra)
    return out


def history_item(p: dict) -> dict:
    results = p.get("results") or []
    st = p.get("status")
    status = {"published": "success", "scheduled": "pending", "processing": "processing"}.get(st, "error" if st in TERMINAL else st)
    item = {
        "id": p.get("id"), "post": p.get("caption") or "", "title": p.get("title") or None,
        "platforms": [A(c) for c in p.get("channels") or []],
        "postIds": [{"status": "success", "id": r.get("id"), "postUrl": r.get("url"), "platform": A(r.get("channel"))} for r in results if r.get("ok")],
        "errors": [{"action": "post", "status": "error", "code": "publish_failed", "message": r.get("error") or "This channel did not publish.", "platform": A(r.get("channel"))}
                   for r in results if not r.get("ok")],
        "status": status,
        "type": "schedule" if p.get("scheduled_at") and p.get("created_at") and _ms(p["scheduled_at"]) - _ms(p["created_at"]) > 90000 else "now",
        "created": p.get("created_at"), "scheduleDate": p.get("scheduled_at"), "mediaUrls": [m.get("url") for m in p.get("media") or []],
        "hermoso": p,
    }
    if p.get("status_detail"):
        item["notes"] = p["status_detail"]
    return item


def post_result(p: dict) -> dict:
    h = history_item(p)
    base = {"id": p.get("id"), "post": h["post"], "postIds": h["postIds"], "errors": h["errors"], "hermoso": p}
    st = p.get("status")
    if st == "scheduled":
        return {"status": "scheduled", "scheduleDate": p.get("scheduled_at"), **base}
    if st == "processing":
        return {"status": "pending", "message": "Still publishing. Read the outcome with getPost({'id': ...}).", **base}
    if st == "published":
        return {"status": "success", **base}
    if st == "indeterminate":
        return {"status": "error", "message": p.get("status_detail") or "The send was interrupted and Hermoso cannot tell whether it published. Check the channel before posting again.", **base}
    return {"status": "error", **base}


def _map_platform_options(d: dict, body: dict, warnings: list) -> None:
    o = body["options"]
    vis: dict = {}

    def take(src: dict, key: str, to: str | None = None) -> None:
        if key in src:
            o[to or key] = src[key]

    def alt(src: dict) -> None:
        if src.get("altText") is not None and "altText" not in o:
            o["altText"] = src["altText"]

    yt = d.get("youTubeOptions")
    if yt:
        if yt.get("title"):
            body.setdefault("title", yt["title"])
        if yt.get("visibility"):
            vis["youtube"] = str(yt["visibility"]).lower()
        for k in ("tags", "categoryId", "madeForKids", "notifySubscribers", "description"):
            take(yt, k)
        if yt.get("thumbNail"):
            o["thumbnailUrl"] = yt["thumbNail"]
    ig = d.get("instagramOptions")
    if ig:
        if ig.get("stories"):
            o["story"] = True
        take(ig, "shareReelsFeed", "shareToFeed")
        alt(ig)
        for k in ("userTags", "collaborators", "coverUrl", "audioName"):
            take(ig, k)
        take(ig, "locationId", "instagramLocationId")
        take(ig, "thumbNailOffset", "thumbOffset")
        if ig.get("trialParams") or ig.get("trialReel"):
            o["trialReel"] = True
    fb = d.get("faceBookOptions")
    if fb:
        alt(fb)
        if fb.get("stories"):
            o["story"] = True
        if fb.get("link"):
            body.setdefault("link", fb["link"])
        if fb.get("pageId"):
            body["targets"]["pageId"] = fb["pageId"]
    li = d.get("linkedInOptions")
    if li:
        alt(li)
        if li.get("organizationId"):
            body["targets"]["linkedinOrganizationId"] = li["organizationId"]
    pin = d.get("pinterestOptions")
    if pin:
        if pin.get("title"):
            body.setdefault("title", pin["title"])
        if pin.get("link"):
            body.setdefault("link", pin["link"])
        if pin.get("boardId"):
            body["targets"]["boardId"] = pin["boardId"]
        alt(pin)
        if pin.get("thumbNail"):
            o["coverImageUrl"] = pin["thumbNail"]
    tt = d.get("tikTokOptions")
    if tt:
        take(tt, "disableComments", "disableComment")
        take(tt, "disableDuet")
        take(tt, "disableStitch")
        take(tt, "isAIGenerated", "aiGenerated")
        take(tt, "thumbNailOffset", "coverTimestampMs")
        take(tt, "brandedContent")
        take(tt, "brandOrganic", "yourBrand")
        if tt.get("draft"):
            vis["tiktok"] = "draft"
        elif tt.get("visibility"):
            vis["tiktok"] = "public" if str(tt["visibility"]).lower() == "public" else "private"
    tw = d.get("twitterOptions")
    if tw:
        if tw.get("thread"):
            o["thread"] = True
        take(tw, "poll")
        take(tw, "replySettings")
        take(tw, "quoteTweetId", "xQuotePostId")
        alt(tw)
    gmb = d.get("gmbOptions")
    if gmb:
        cta = gmb.get("callToAction") or {}
        if cta.get("actionType"):
            o["actionType"] = cta["actionType"]
        if cta.get("url"):
            body.setdefault("link", cta["url"])
        take(gmb, "event")
        take(gmb, "offer")
        if gmb.get("locationId"):
            body["targets"]["locationId"] = gmb["locationId"]
    tg = d.get("telegramOptions") or {}
    if tg.get("chatId"):
        body["targets"]["chatId"] = tg["chatId"]
    th = d.get("threadsOptions")
    if th:
        take(th, "topicTag")
        alt(th)
    bs = d.get("blueSkyOptions") or d.get("blueskyOptions")
    if bs:
        alt(bs)
    if vis:
        body["visibility_by_channel"] = vis
    for k in ("redditOptions", "snapchatOptions"):
        if d.get(k):
            warnings.append(f"{k} was not applied: Hermoso does not publish to {k.replace('Options', '')}.")


class SocialPost:
    """Drop-in for ``ayrshare.SocialPost``. Pass your Hermoso API key (hmk_...)."""

    ACTION_EVENTS = {"social": ["connections"], "scheduled": ["posts"], "messages": ["message.received"], "comments": ["comment.received"],
                     "reviews": ["reviews"], "mentions": ["mentions"]}

    def __init__(self, API_KEY: str | None = None, *, base_url: str | None = None, wait_for_publish: bool = True,
                 publish_timeout: float = 120.0, rehost_media: bool = True):
        self.hermoso = HermosoClient(API_KEY, base_url=base_url, client="ayrshare")
        self.API_KEY = self.hermoso.api_key
        self.headers: dict = {}
        self.wait_for_publish = wait_for_publish
        self.publish_timeout = publish_timeout
        self.rehost_media = rehost_media

    def _safe(self, fn: Any) -> dict:
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            return _error(e)

    def setProfileKey(self, PROFILE_KEY: str | None) -> "SocialPost":
        """Ayrshare's Profile-Key = a Hermoso brand id (from getProfiles)."""
        if PROFILE_KEY:
            self.headers["Profile-Key"] = PROFILE_KEY
            self.hermoso.set_brand(PROFILE_KEY)
        return self

    def set_twitter_byo(self, api_key: str, api_secret: str) -> "SocialPost":
        """Accepted for compatibility and ignored: Hermoso posts to X through the account the brand connected."""
        self.headers["X-Twitter-OAuth1-Api-Key"] = api_key
        self.headers["X-Twitter-OAuth1-Api-Secret"] = api_secret
        return self

    def clear_twitter_byo(self) -> "SocialPost":
        self.headers.pop("X-Twitter-OAuth1-Api-Key", None)
        self.headers.pop("X-Twitter-OAuth1-Api-Secret", None)
        return self

    def call_tool(self, name: str, args: dict | None = None) -> dict:
        """Escape hatch: any Hermoso tool, ``{"text", "data"}``."""
        return self.hermoso.call_tool(name, args)

    # ── POSTS ─────────────────────────────────────────────────────────────────────────────────────────────────
    def post(self, data: dict, headers: dict | None = None) -> dict:
        data = dict(data or {})
        if data.get("profileKeys"):
            keys = data.pop("profileKeys")
            posts = []
            for key in keys:
                one = SocialPost(self.API_KEY, base_url=self.hermoso.base_url, wait_for_publish=self.wait_for_publish,
                                 publish_timeout=self.publish_timeout, rehost_media=self.rehost_media).setProfileKey(key)
                posts.append({"profileKey": key, **one.post(data)})
            return {"status": "success" if all(p.get("status") != "error" for p in posts) else "error", "posts": posts}
        if data.get("requiresApproval"):
            raise HermosoUnsupportedError("post(requiresApproval)", "set_post_refill", "Hermoso holds posts for approval in its autopilot review queue (mode \"review\"), not per API post.")
        if data.get("randomPost") or data.get("randomMediaUrl"):
            raise HermosoUnsupportedError("post(randomPost)", "generate_text", "Write the caption with generate_text, then post it.")

        def run() -> dict:
            warnings: list = []
            plats = data.get("platforms") or []
            plats = plats if isinstance(plats, list) else [plats]
            channels: list = []
            for p in plats:
                c = to_channel(p)
                if c not in channels:
                    channels.append(c)
            body: dict = {"channels": channels, "caption": data.get("post") or "", "options": {}, "targets": {}}
            if data.get("title"):
                body["title"] = data["title"]
            media = data.get("mediaUrls") or []
            media = media if isinstance(media, list) else [media]
            if self.rehost_media:
                media = [self.hermoso.rehost(u) for u in media]
            if media:
                body["media"] = [{"url": u, "type": "video"} if data.get("isVideo") and len(media) == 1 else u for u in media]
            if data.get("scheduleDate"):
                body["scheduled_at"] = _iso(data["scheduleDate"])
            auto = data.get("autoSchedule") or {}
            if auto.get("schedule"):
                body["use_queue"] = True
                if auto.get("title"):
                    body["options"]["useQueue"] = auto["title"]
            if (data.get("firstComment") or {}).get("comment"):
                body["first_comment"] = data["firstComment"]["comment"]
            if data.get("shortenLinks"):
                warnings.append("shortenLinks was not applied: Hermoso posts links as given.")
            _map_platform_options(data, body, warnings)
            if not body["options"]:
                del body["options"]
            if not body["targets"]:
                del body["targets"]
            hdr = {"Idempotency-Key": str(data["idempotencyKey"])} if data.get("idempotencyKey") else None
            p = self.hermoso.request("POST", "/v1/posts", body=body, headers=hdr)
            if not body.get("scheduled_at") and not body.get("use_queue") and self.wait_for_publish and p.get("status") not in TERMINAL:
                p = self.hermoso.wait_for_post(p["id"], self.publish_timeout)
            out = post_result(p)
            if warnings:
                out["warnings"] = warnings
            return out
        return self._safe(run)

    def _delete_one(self, pid: Any) -> dict:
        try:
            self.hermoso.request("DELETE", f"/v1/posts/{urllib.parse.quote(str(pid))}")
            return {"status": "success", "id": pid, "deleted": True}
        except HermosoApiError as e:
            if e.code == "post_not_cancellable":
                try:
                    tools = "; ".join(f"{A(r['channel'])}: {PUBLISHED_DELETE_TOOLS.get(r['channel'], 'that channel' + chr(39) + 's own app')} (post id {r.get('id')})"
                                      for r in self.hermoso.get_post(pid).get("results") or [] if r.get("ok"))
                except HermosoApiError:
                    tools = ""
                return _error(e, id=pid, message=f"{e.message}{(' To remove it from the channel, use the Hermoso tool for each: ' + tools + '.') if tools else ''}")
            return _error(e, id=pid)

    def delete(self, data: dict | None = None) -> dict:
        data = data or {}
        if data.get("deleteAllScheduled"):
            def run() -> dict:
                bulk = [self._delete_one(p["id"]) for p in self.hermoso.list_posts(status="scheduled", max=1000)]
                return {"status": "success" if all(b["status"] == "success" for b in bulk) else "error", "bulk": bulk}
            return self._safe(run)
        if isinstance(data.get("bulk"), list):
            bulk = [self._delete_one(i) for i in data["bulk"]]
            return {"status": "success" if all(b["status"] == "success" for b in bulk) else "error", "bulk": bulk}
        return self._delete_one(data.get("id"))

    def getPost(self, data: dict | None = None) -> dict:
        data = data or {}
        return self._safe(lambda: {"status": "success", **history_item(self.hermoso.get_post(data.get("id")))})

    def retryPost(self, data: dict | None = None) -> dict:
        data = data or {}

        def run() -> dict:
            r = self.hermoso.call_tool("retry_scheduled", {"id": data.get("id")})
            d = r.get("data") or {}
            return {"status": "success", "id": d.get("id") or d.get("newId") or (d.get("post") or {}).get("id") or data.get("id"), "message": r.get("text"), "hermoso": d}
        return self._safe(run)

    def updatePost(self, data: dict | None = None) -> dict:
        data = data or {}

        def run() -> dict:
            patch: dict = {}
            if data.get("scheduleDate"):
                patch["scheduled_at"] = _iso(data["scheduleDate"])
            if "post" in data:
                patch["caption"] = data["post"]
            if data.get("mediaUrls"):
                urls = data["mediaUrls"] if isinstance(data["mediaUrls"], list) else [data["mediaUrls"]]
                patch["media"] = [self.hermoso.rehost(u) for u in urls] if self.rehost_media else urls
            if data.get("platforms"):
                patch["channels"] = [to_channel(x) for x in data["platforms"]]
            warnings = [f"{k} was not applied: Hermoso has no equivalent field on a scheduled post." for k in ("approved", "notes", "disableComments") if k in data]
            p = self.hermoso.request("PATCH", f"/v1/posts/{urllib.parse.quote(str(data.get('id')))}", body=patch)
            out = {"status": "success", "id": p.get("id"), "scheduleDate": p.get("scheduled_at"), "post": p.get("caption"), "hermoso": p}
            if warnings:
                out["warnings"] = warnings
            return out
        return self._safe(run)

    # ── HISTORY ───────────────────────────────────────────────────────────────────────────────────────────────
    def history(self, params: dict | None = None) -> dict:
        params = params or {}

        def run() -> dict:
            if params.get("id"):
                return {"status": "success", **history_item(self.hermoso.get_post(params["id"]))}
            if params.get("platform"):
                ch = to_channel(params["platform"])
                d = self.hermoso.call_tool("list_published_posts", {"channel": ch, "limit": min(200, int(params.get("limit") or params.get("lastRecords") or 50))}).get("data") or {}
                posts = [{"id": r.get("postId"), "post": r.get("caption") or "", "postUrl": r.get("url"),
                          "created": _iso(datetime.fromtimestamp(float(r["publishedAt"]) / 1000, timezone.utc)) if r.get("publishedAt") else None,
                          "platform": A(r.get("channel")), "mediaUrls": r.get("mediaUrls") or [], "deleted": bool(r.get("deleted"))} for r in d.get("posts") or []]
                return {"status": "success", "platform": A(ch), "posts": posts, "lastUpdated": _now()}
            mx = int(params["lastRecords"]) if params.get("lastRecords") else 1000
            posts = self.hermoso.list_posts(max=1000 if params.get("lastDays") else mx)
            if params.get("lastDays"):
                since = time.time() * 1000 - float(params["lastDays"]) * 864e5
                posts = [p for p in posts if _ms(p.get("scheduled_at") or p.get("created_at")) >= since][:mx]
            hist = [history_item(p) for p in posts]
            if params.get("status"):
                hist = [x for x in hist if x["status"] == str(params["status"])]
            if params.get("type"):
                hist = [x for x in hist if x["type"] == str(params["type"])]
            if params.get("platforms"):
                want = {A(to_channel(x)) for x in params["platforms"]}
                hist = [x for x in hist if any(p in want for p in x["platforms"])]
            return {"history": hist, "refId": self.hermoso.brand or "default", "count": len(hist), "lastUpdated": _now(), "nextUpdate": _now()}
        return self._safe(run)

    # ── MEDIA ─────────────────────────────────────────────────────────────────────────────────────────────────
    def media(self, params: dict | None = None) -> dict:
        params = params or {}

        def run() -> dict:
            r = self.hermoso.request("GET", "/v1/library", query={"limit": params.get("limit") or 100})
            media = [{"fileName": m.get("name") or m.get("title") or m.get("id"), "mediaUrl": m.get("url") or m.get("image") or m.get("video"),
                      "contentType": m.get("type"), "createdAt": m.get("created_at"), "id": m.get("id")} for m in r.get("data") or []]
            return {"status": "success", "media": media, "count": len(media)}
        return self._safe(run)

    def verifyMediaExists(self, params: dict | None = None) -> dict:
        params = params or {}

        def run() -> dict:
            req = urllib.request.Request(params.get("mediaUrl"), method="HEAD")
            try:
                with urllib.request.urlopen(req, timeout=30) as res:
                    return {"status": "success", "mediaExists": 200 <= res.status < 400, "statusCode": res.status, "contentType": res.headers.get("content-type")}
            except urllib.error.HTTPError as e:
                return {"status": "success", "mediaExists": False, "statusCode": e.code}
        return self._safe(run)

    def mediaUploadUrl(self, params: dict | None = None) -> dict:
        params = params or {}

        def run() -> dict:
            args: dict = {"getUploadUrl": True}
            if params.get("fileName"):
                args["name"] = params["fileName"]
            d = self.hermoso.call_tool("upload_file", args).get("data") or {}
            return {"status": "success", "uploadUrl": d.get("uploadUrl"), "contentType": params.get("contentType"), "expiresAt": d.get("expiresAt"),
                    "accessUrl": None, "message": "PUT the raw bytes to uploadUrl with their Content-Type: the response body is {url}, the durable URL to pass in mediaUrls."}
        return self._safe(run)

    def mediaMeta(self, params: dict | None = None) -> dict:
        raise HermosoUnsupportedError("mediaMeta", "analyze_video", "For a video, analyze_video returns its duration and structure.")

    def resizeImage(self, data: dict | None = None) -> dict:
        raise HermosoUnsupportedError("resizeImage", "resize_ad")

    def upload(self, data: dict | None = None) -> dict:
        data = data or {}

        def run() -> dict:
            if not data.get("file"):
                raise HermosoApiError("upload needs `file`: a base64 string or a data: URI.", status=400, code="missing_file")
            m = self.hermoso.upload_bytes(data["file"], file_name=data.get("fileName"))
            return {"status": "success", "id": m.get("url"), "url": m.get("url"), "fileName": data.get("fileName") or m.get("name"),
                    "description": data.get("description"), "type": m.get("type"), "size": m.get("bytes")}
        return self._safe(run)

    # ── ANALYTICS ─────────────────────────────────────────────────────────────────────────────────────────────
    def analyticsPost(self, data: dict | None = None) -> dict:
        data = data or {}

        def run() -> dict:
            p = self.hermoso.get_post(data.get("id"))
            want = {to_channel(x) for x in data["platforms"]} if data.get("platforms") else None
            out: dict = {"status": "success", "id": p.get("id")}
            rows: list = []
            for r in [x for x in p.get("results") or [] if x.get("ok") and (not want or x.get("channel") in want)]:
                if not rows:
                    cursor = None
                    for _ in range(5):
                        args = {"limit": 200, **({"cursor": cursor} if cursor else {})}
                        d = self.hermoso.call_tool("list_published_posts", args).get("data") or {}
                        rows.extend(d.get("posts") or [])
                        cursor = d.get("nextCursor")
                        if not cursor:
                            break
                row = next((x for x in rows if x.get("channel") == r.get("channel") and (str(x.get("postId")) == str(r.get("id")) or (r.get("url") and x.get("url") == r.get("url"))
                                                                                        or str(r.get("id")) in [str(s) for s in x.get("siblingIds") or []])), None)
                samples = sorted([s for s in (row or {}).get("samples") or [] if s and s.get("ok") is not False], key=lambda s: float(s.get("at") or 0), reverse=True)
                latest = samples[0] if samples else None
                entry = {"id": r.get("id"), "postUrl": r.get("url"), "analytics": (latest or {}).get("metrics") or {}, "engagement": (row or {}).get("engagement")}
                if latest:
                    entry["lastUpdated"] = _iso(datetime.fromtimestamp(float(latest["at"]) / 1000, timezone.utc))
                else:
                    entry["message"] = ("Not measured yet: Hermoso reads a post at about 24 hours and again at 7 days (collect_post_metrics reads due posts now)."
                                        if row else "Hermoso has no record of this post on that channel.")
                out[A(r.get("channel"))] = entry
            return out
        return self._safe(run)

    def analyticsSocial(self, params: dict | None = None) -> dict:
        params = params or {}

        def run() -> dict:
            want = [to_channel(x) for x in params["platforms"]] if params.get("platforms") else None
            r = self.hermoso.request("GET", "/v1/analytics/follower-history", query={"granularity": "daily"})
            out: dict = {"status": "success"}
            for acct in r.get("accounts") or []:
                ch = acct.get("channel")
                if want and ch not in want:
                    continue
                pts = acct.get("points") or acct.get("series") or []
                last = pts[-1] if pts else {}
                out[A(ch)] = {"analytics": {"followersCount": last.get("followers", last.get("count", acct.get("followers"))), "followerChange": last.get("change"),
                                            "displayName": acct.get("account") or acct.get("label")}, "lastUpdated": last.get("date"), "hermoso": acct}
            for ch in want or []:
                if A(ch) not in out:
                    out[A(ch)] = {"status": "error", "message": f"No follower count recorded for {A(ch)} yet. Hermoso reads every connected account once a day."}
            return out
        return self._safe(run)

    def user(self, params: dict | None = None) -> dict:
        def run() -> dict:
            brands = self.hermoso.brands()
            rows = self.hermoso.account_rows()
            try:
                credits = self.hermoso.request("GET", "/v1/credits")
            except HermosoApiError:
                credits = None
            cur = next((b for b in brands if b.get("current")), brands[0] if brands else {})
            active: list = []
            for r in rows:
                if not r["needsReconnect"] and A(r["channel"]) not in active:
                    active.append(A(r["channel"]))
            out = {"status": "success", "title": cur.get("name"), "refId": cur.get("id"), "profileKey": brand_key_of(cur) if cur else None,
                   "activeSocialAccounts": active,
                   "displayNames": [{"platform": A(r["channel"]), "displayName": r.get("label") or r.get("handle") or r.get("name"),
                                     "username": r.get("handle") or r.get("label"), "id": r.get("ref")} for r in rows]}
            if credits:
                out["credits"] = credits.get("balance")
                out["plan"] = credits.get("plan")
            return out
        return self._safe(run)

    # ── FEEDS (RSS) ───────────────────────────────────────────────────────────────────────────────────────────
    def addFeed(self, data: dict | None = None) -> dict:
        raise HermosoUnsupportedError("addFeed", "set_post_refill", "Hermoso has no RSS auto-post; its autopilot (set_post_refill) makes and schedules new posts on a cadence.")

    def deleteFeed(self, data: dict | None = None) -> dict:
        raise HermosoUnsupportedError("deleteFeed", "set_post_refill")

    def getFeeds(self, params: dict | None = None) -> dict:
        raise HermosoUnsupportedError("getFeeds", "get_post_refill")

    def updateFeed(self, data: dict | None = None) -> dict:
        raise HermosoUnsupportedError("updateFeed", "set_post_refill")

    feedAdd, feedDelete, feedGet, feedUpdate = addFeed, deleteFeed, getFeeds, updateFeed

    # ── PROFILES ──────────────────────────────────────────────────────────────────────────────────────────────
    def createProfile(self, data: dict | None = None) -> dict:
        data = data or {}

        def run() -> dict:
            r = self.hermoso.call_tool("create_brand", {"name": data.get("title") or data.get("name"), "activate": False})
            b = (r.get("data") or {}).get("brand") or {}
            return {"status": "success", "title": b.get("name"), "refId": b.get("id"), "profileKey": b.get("id"), "created": (r.get("data") or {}).get("created")}
        return self._safe(run)

    def deleteProfile(self, data: dict | None = None) -> dict:
        """Deleting a brand destroys everything in it, irreversibly, so Hermoso keeps it behind its own confirm step."""
        raise HermosoUnsupportedError("deleteProfile", "delete_brand", "It is irreversible and confirm-gated: call delete_brand over MCP (it first reports what the brand holds), or delete the brand in the Hermoso app.")

    def updateProfile(self, data: dict | None = None) -> dict:
        data = data or {}

        def run() -> dict:
            key = data.get("profileKey") or self.headers.get("Profile-Key")
            client = self.hermoso.for_brand(key) if key else self.hermoso
            r = client.call_tool("update_brand", {"name": data["title"]} if data.get("title") else {})
            return {"status": "success", "profileKey": key, "title": data.get("title"), "message": r.get("text")}
        return self._safe(run)

    def getProfiles(self, params: dict | None = None) -> dict:
        def run() -> dict:
            profiles = [{"title": b.get("name"), "profileKey": brand_key_of(b), "refId": b.get("id"), "default": bool(b.get("is_default")),
                         "shared": bool(b.get("shared")), "role": b.get("role")} for b in self.hermoso.brands()]
            return {"status": "success", "profiles": profiles, "count": len(profiles)}
        return self._safe(run)

    def generateJWT(self, data: dict | None = None) -> dict:
        """Ayrshare's hosted linking page = a Hermoso connect link (one platform per link)."""
        data = data or {}

        def run() -> dict:
            client = self.hermoso.for_brand(data["profileKey"]) if data.get("profileKey") else self.hermoso
            want = [to_channel(x) for x in (data.get("allowedSocial") or [])]
            if not want:
                raise HermosoApiError('Hermoso connect links connect one platform each: pass allowedSocial, e.g. ["instagram"].', status=400,
                                      code="allowed_social_required", param="allowedSocial")
            chs = client.channels()
            providers: list = []
            for c in want:
                prov = next((x.get("connector") for x in chs if x.get("id") == c), None) or c
                if prov not in providers:
                    providers.append(prov)
            minutes = min(2880, max(5, int(data["expiresIn"]))) if data.get("expiresIn") else 60
            links = []
            for prov in providers:
                body = {"provider": prov, "expires_in_minutes": minutes}
                if data.get("redirect"):
                    body["redirect_url"] = data["redirect"]
                links.append(client.request("POST", "/v1/connect-links", body=body))
            return {"status": "success", "title": data.get("title"), "token": links[0].get("id"), "url": links[0].get("url"), "emailSent": False,
                    "expiresIn": f"{minutes}m", "links": [{"platform": x.get("provider"), "url": x.get("url"), "id": x.get("id"), "expiresAt": x.get("expires_at")} for x in links]}
        return self._safe(run)

    def unlinkSocial(self, data: dict | None = None) -> dict:
        data = data or {}

        def run() -> dict:
            ch = to_channel(data.get("platform"))
            prov = next((x.get("connector") for x in self.hermoso.channels() if x.get("id") == ch), None) or ch
            r = self.hermoso.request("DELETE", f"/v1/connections/{urllib.parse.quote(prov)}", query={"account": data["account"]} if data.get("account") else None)
            return {"status": "success", "platform": data.get("platform"), "message": r.get("note")}
        return self._safe(run)

    # ── COMMENTS ──────────────────────────────────────────────────────────────────────────────────────────────
    def _platform_posts(self, pid: Any, platforms: Any) -> list:
        p = self.hermoso.get_post(pid)
        want = {to_channel(x) for x in (platforms if isinstance(platforms, list) else [platforms])} if platforms else None
        return [r for r in p.get("results") or [] if r.get("ok") and r.get("id") and (not want or r.get("channel") in want)]

    def postComment(self, data: dict | None = None) -> dict:
        data = data or {}

        def run() -> dict:
            out: dict = {"status": "success", "commentIds": []}
            for r in self._platform_posts(data.get("id"), data.get("platforms")):
                ch = r["channel"]
                t = COMMENT_TOOLS.get(ch) or {}
                if not t.get("comment"):
                    out["commentIds"].append({"platform": A(ch), "status": "error", "message": f"Hermoso cannot comment on {A(ch)} posts."})
                    continue
                c = data.get("comment")
                args = ({"videoId": r["id"], "text": c} if ch == "tiktok" else {"postUrn": r["id"], "text": c} if ch == "linkedin"
                        else {"replyToId": r["id"], "text": c} if ch == "threads" else {"postId": r["id"], "message": c})
                try:
                    d = self.hermoso.call_tool(t["comment"], args).get("data") or {}
                    out["commentIds"].append({"platform": A(ch), "status": "success", "commentId": d.get("id") or d.get("commentId"), "id": r["id"]})
                except HermosoApiError as e:
                    out["status"] = "error"
                    out["commentIds"].append({"platform": A(ch), **_error(e)})
            return out
        return self._safe(run)

    def getComments(self, params: dict | None = None) -> dict:
        params = params or {}

        def run() -> dict:
            out: dict = {"status": "success", "id": params.get("id")}
            for r in self._platform_posts(params.get("id"), params.get("platforms") or params.get("platform")):
                ch = r["channel"]
                t = COMMENT_TOOLS.get(ch)
                if not t:
                    out[A(ch)] = {"status": "error", "message": f"Hermoso cannot read {A(ch)} comments."}
                    continue
                args = {"videoId": r["id"]} if ch in ("youtube", "tiktok") else {"postUrn": r["id"]} if ch == "linkedin" else {"postId": r["id"]}
                try:
                    d = self.hermoso.call_tool(t["list"], args).get("data") or {}
                    lst = d.get("comments") or d.get("replies") or d.get("items") or []
                    out[A(ch)] = [{"commentId": c.get("id") or c.get("commentId") or c.get("urn"), "comment": c.get("text", c.get("message", c.get("comment"))),
                                   "created": c.get("createdAt") or c.get("created_time") or c.get("timestamp") or c.get("publishedAt"),
                                   "userName": c.get("author") or c.get("username") or (c.get("from") or {}).get("name"),
                                   "likeCount": c.get("likeCount", c.get("like_count")), "platform": A(ch), "raw": c} for c in lst]
                except HermosoApiError as e:
                    out[A(ch)] = _error(e)
            return out
        return self._safe(run)

    def deleteComments(self, data: dict | None = None) -> dict:
        data = data or {}
        ch = to_channel(data.get("platform"))
        t = COMMENT_TOOLS.get(ch)
        cid = data.get("commentId") or data.get("id")
        if not t or not data.get("platform"):
            raise HermosoUnsupportedError("deleteComments without platform and commentId", "moderate_meta_comment", "Pass the platform and the platform comment id from getComments.")

        def run() -> dict:
            if ch == "linkedin":
                args = {"postUrn": data.get("postId"), "commentId": cid, "confirm": True}
            elif ch == "threads":
                args = {"replyId": cid, "hide": True}
            elif ch == "tiktok":
                args = {"commentId": cid, "action": "DELETE", "confirm": True, **({"videoId": data["postId"]} if data.get("postId") else {})}
            else:
                args = {"commentId": cid, "action": "delete", "confirm": True}
            r = self.hermoso.call_tool(t["moderate"], args)
            return {"status": "success", "platform": data.get("platform"), "commentId": cid, "message": r.get("text")}
        return self._safe(run)

    def replyComment(self, data: dict | None = None) -> dict:
        data = data or {}

        def run() -> dict:
            out: dict = {"status": "success", "commentId": data.get("commentId"), "replies": []}
            plats = data.get("platforms") or data.get("platform") or []
            for pl in plats if isinstance(plats, list) else [plats]:
                ch = to_channel(pl)
                t = COMMENT_TOOLS.get(ch) or {}
                if not t.get("reply"):
                    out["replies"].append({"platform": A(ch), "status": "error", "message": f"Hermoso cannot reply to {A(ch)} comments."})
                    continue
                c, cid, pid = data.get("comment"), data.get("commentId"), data.get("postId") or data.get("id")
                args = ({"videoId": pid, "commentId": cid, "text": c} if ch == "tiktok" else {"commentId": cid, "text": c} if ch == "youtube"
                        else {"postUrn": pid, "parentComment": cid, "text": c} if ch == "linkedin" else {"replyToId": cid, "text": c} if ch == "threads"
                        else {"commentId": cid, "message": c})
                try:
                    r = self.hermoso.call_tool(t["reply"], args)
                    d = r.get("data") or {}
                    out["replies"].append({"platform": A(ch), "status": "success", "commentId": d.get("id") or d.get("commentId"), "message": r.get("text")})
                except HermosoApiError as e:
                    out["status"] = "error"
                    out["replies"].append({"platform": A(ch), **_error(e)})
            return out
        return self._safe(run)

    # ── AUTO-SCHEDULE ─────────────────────────────────────────────────────────────────────────────────────────
    def setAutoSchedule(self, data: dict | None = None) -> dict:
        data = data or {}

        def run() -> dict:
            sched = data.get("schedule") or []
            slots = [re.sub(r"Z$", "", str(t), flags=re.I)[:5] for t in (sched if isinstance(sched, list) else [sched])]
            r = self.hermoso.call_tool("manage_post_queues", {"action": "save", "name": data.get("title") or "Default", "slots": slots, "timezone": "UTC"})
            return {"status": "success", "title": data.get("title") or "default", "schedule": data.get("schedule"), "message": r.get("text")}
        return self._safe(run)

    def deleteAutoSchedule(self, data: dict | None = None) -> dict:
        data = data or {}
        return self._safe(lambda: {"status": "success", "title": data.get("title") or "default",
                                   "message": self.hermoso.call_tool("manage_post_queues", {"action": "delete", "name": data.get("title") or "Default"}).get("text")})

    def listAutoSchedule(self, params: dict | None = None) -> dict:
        def run() -> dict:
            qs = (self.hermoso.call_tool("manage_post_queues", {"action": "list"}).get("data") or {}).get("queues") or []
            return {"status": "success", "autoSchedules": [{"title": "default" if q.get("isDefault") else q.get("name"),
                                                             "schedule": [f"{s}{'Z' if q.get('timezone') == 'UTC' else ''}" for s in q.get("slots") or []],
                                                             "timezone": q.get("timezone"), "days": q.get("days"), "channels": q.get("channels")} for q in qs]}
        return self._safe(run)

    # ── WEBHOOKS ──────────────────────────────────────────────────────────────────────────────────────────────
    def registerWebhook(self, data: dict | None = None) -> dict:
        data = data or {}

        def run() -> dict:
            events = self.ACTION_EVENTS.get(data.get("action"))
            if not events:
                raise HermosoApiError(f'Unknown webhook action "{data.get("action")}". Hermoso maps: {", ".join(self.ACTION_EVENTS)}.', status=400, code="unknown_action", param="action")
            cur = webhook_sink(self.hermoso)
            secret = None
            if not cur.get("connected") or data.get("url"):
                self.hermoso.call_tool("connect_connector", {"provider": "webhook", "fields": {"webhookUrl": data.get("url")}})
                if not cur.get("connected"):
                    secret = fresh_secret(self.hermoso)
            have = cur["groupsSelected"] if cur.get("connected") else []
            merged = list(dict.fromkeys([*have, *events]))
            r = self.hermoso.call_tool("set_alert_events", {"provider": "webhook", "events": merged})
            out = {"status": "success", "action": data.get("action"), "url": data.get("url"), "events": (r.get("data") or {}).get("events"), "message": r.get("text")}
            if secret:
                out["secret"] = secret
            return out
        return self._safe(run)

    def unregisterWebhook(self, data: dict | None = None) -> dict:
        data = data or {}

        def run() -> dict:
            cur = webhook_sink(self.hermoso)
            drop = set(self.ACTION_EVENTS.get(data.get("action"), []))
            keep = [e for e in cur["groupsSelected"] if e not in drop]
            if not keep or not data.get("action"):
                r = self.hermoso.call_tool("disconnect_connector", {"provider": "webhook", "confirm": True})
            else:
                r = self.hermoso.call_tool("set_alert_events", {"provider": "webhook", "events": keep})
            return {"status": "success", "action": data.get("action"), "message": r.get("text")}
        return self._safe(run)

    def listWebhooks(self, params: dict | None = None) -> dict:
        def run() -> dict:
            s = webhook_sink(self.hermoso)
            if not s.get("connected"):
                return {"status": "success", "webhooks": []}
            have = set(s["groupsSelected"]) | set(s["eventNames"])
            actions = [a for a, ev in self.ACTION_EVENTS.items() if all(e in have for e in ev)]
            return {"status": "success", "webhooks": [{"actions": actions, "events": s["eventNames"], "state": s.get("state"), "signed": s.get("signed"),
                                                        "lastDeliveredAt": s.get("lastDeliveredAt")}]}
        return self._safe(run)

    def getBrandByUser(self, params: dict | None = None) -> dict:
        raise HermosoUnsupportedError("getBrandByUser", "fetch_social_data")

    # ── GENERATE (paid: billed as Hermoso credits) ────────────────────────────────────────────────────────────
    def _write(self, prompt: str) -> str:
        r = self.hermoso.call_tool("generate_text", {"prompt": prompt})
        d = r.get("data") or {}
        return str(d.get("text") or d.get("output") or r.get("text") or "").strip()

    def generatePost(self, params: dict | None = None) -> dict:
        params = params or {}
        extras = " ".join(["Add relevant hashtags." if params.get("hashtags") else "No hashtags.", "Use a few emojis." if params.get("emojis") else "No emojis.",
                           "Keep it under 280 characters." if params.get("twitter") else ""])
        return self._safe(lambda: {"status": "success", "post": self._write(f"Write one social media post about the following. {extras} Answer with the post text only.\n\n{params.get('text') or ''}")})

    def generateRewrite(self, params: dict | None = None) -> dict:
        params = params or {}

        def run() -> dict:
            n = min(10, max(1, int(params.get("rewrites") or 1)))
            txt = self._write(f"Rewrite this social media post {n} different way(s). {'Keep or add hashtags.' if params.get('hashtags') else 'No hashtags.'} "
                              f"{'Emojis are fine.' if params.get('emojis') else 'No emojis.'} {'Each under 280 characters.' if params.get('twitter') else ''} "
                              f"Separate the versions with a line containing only ---. Answer with the versions only.\n\n{params.get('post') or ''}")
            return {"status": "success", "posts": [s.strip() for s in re.split(r"\n\s*-{3,}\s*\n", txt) if s.strip()][:n]}
        return self._safe(run)

    def generateTranslation(self, params: dict | None = None) -> dict:
        params = params or {}
        return self._safe(lambda: {"status": "success", "originalText": params.get("text"), "language": params.get("lang"),
                                   "translatedText": self._write(f'Translate the following into the language with code "{params.get("lang")}". Answer with the translation only.\n\n{params.get("text") or ""}')})

    def generateTranscription(self, params: dict | None = None) -> dict:
        params = params or {}

        def run() -> dict:
            r = self.hermoso.call_tool("analyze_video", {"url": params.get("videoUrl") or params.get("url")})
            return {"status": "success", "transcription": (r.get("data") or {}).get("transcript") or r.get("text"), "hermoso": r.get("data")}
        return self._safe(run)

    def generateSentiment(self, params: dict | None = None) -> dict:
        params = params or {}

        def run() -> dict:
            ans = self._write(f"Classify the sentiment of this text as exactly one word: positive, negative or neutral.\n\n{params.get('text') or ''}").lower()
            m = re.search(r"positive|negative|neutral", ans)
            return {"status": "success", "sentiment": m.group(0) if m else ans, "text": params.get("text")}
        return self._safe(run)

    def generateAltText(self, params: dict | None = None) -> dict:
        raise HermosoUnsupportedError("generateAltText", "generate_text", "Pass your own description as options.altText on the post (POST /v1/posts), or write one with generate_text.")

    def autoHashtags(self, params: dict | None = None) -> dict:
        raise HermosoUnsupportedError("autoHashtags", "generate_text")

    def recommendHashtags(self, params: dict | None = None) -> dict:
        raise HermosoUnsupportedError("recommendHashtags", "tiktok_hashtag_suggestions")

    def checkBannedHashtags(self, params: dict | None = None) -> dict:
        raise HermosoUnsupportedError("checkBannedHashtags", "check_ad_policy")

    def shortLink(self, params: dict | None = None) -> dict:
        raise HermosoUnsupportedError("shortLink", "set_tracking_links")

    def shortLinkAnalytics(self, params: dict | None = None) -> dict:
        raise HermosoUnsupportedError("shortLinkAnalytics", "set_tracking_links")

    # ── REVIEWS ───────────────────────────────────────────────────────────────────────────────────────────────
    def reviews(self, params: dict | None = None) -> dict:
        params = params or {}

        def run() -> dict:
            ch = to_channel(params.get("platform") or "gmb")
            r = self.hermoso.call_tool("meta_page_reviews", {"action": "list"}) if ch == "facebook" else self.hermoso.call_tool("list_google_business_reviews", {})
            d = r.get("data") or {}
            rows = [{"id": x.get("id") or x.get("reviewId") or x.get("name"), "rating": x.get("rating", x.get("starRating")),
                     "review": x.get("text", x.get("comment")), "reviewer": (x.get("reviewer") or {}).get("displayName") if isinstance(x.get("reviewer"), dict) else (x.get("reviewer") or x.get("author")),
                     "created": x.get("createTime") or x.get("created_time") or x.get("createdAt"),
                     "reply": (x.get("reply") or {}).get("comment") if isinstance(x.get("reply"), dict) else x.get("reply"), "raw": x}
                    for x in d.get("reviews") or d.get("items") or []]
            return {"status": "success", "platform": A(ch), "reviews": rows, "averageRating": d.get("averageRating"), "totalReviewCount": d.get("totalReviewCount")}
        return self._safe(run)

    def review(self, params: dict | None = None) -> dict:
        params = params or {}
        allr = self.reviews(params)
        if allr.get("status") != "success":
            return allr
        one = next((x for x in allr["reviews"] if str(x["id"]) == str(params.get("id")) or str(x["id"]).endswith(f"/{params.get('id')}")), None)
        return {"status": "success", **one} if one else {"status": "error", "code": "review_not_found", "message": f"No review {params.get('id')} on {allr['platform']}."}

    def reviewReply(self, params: dict | None = None) -> dict:
        params = params or {}

        def run() -> dict:
            ch = to_channel(params.get("platform") or "gmb")
            if ch == "facebook":
                r = self.hermoso.call_tool("meta_page_reviews", {"action": "reply", "reviewId": params.get("reviewId"), "text": params.get("reply"), "confirm": True})
            else:
                r = self.hermoso.call_tool("reply_to_google_business_review", {"reviewId": params.get("reviewId"), "comment": params.get("reply")})
            return {"status": "success", "platform": A(ch), "reviewId": params.get("reviewId"), "reply": params.get("reply"), "message": r.get("text")}
        return self._safe(run)

    def deleteReviewReply(self, params: dict | None = None) -> dict:
        params = params or {}
        if to_channel(params.get("platform") or "gmb") != "google_business":
            raise HermosoUnsupportedError("deleteReviewReply (facebook)", "meta_page_reviews", "Meta offers no delete for a review reply.")
        return self._safe(lambda: {"status": "success", "platform": "gmb", "reviewId": params.get("reviewId"),
                                   "message": self.hermoso.call_tool("reply_to_google_business_review", {"reviewId": params.get("reviewId"), "delete": True, "confirm": True}).get("text")})

    replyReview, deleteReplyReview = reviewReply, deleteReviewReply


SocialMediaAPI = SocialPost

__all__ = ["SocialPost", "SocialMediaAPI", "HermosoApiError", "HermosoUnsupportedError"]
