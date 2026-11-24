"""Shared plumbing for the compatibility layers: a small client for Hermoso's REST API (/v1), the error types and
the platform-name tables. Standard library only, so installing a compat layer adds no dependencies."""

from __future__ import annotations

import base64
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

VERSION = "0.1.0"
DEFAULT_BASE_URL = "https://app.hermoso.ai"


class HermosoApiError(Exception):
    """An error Hermoso answered. ``code`` is Hermoso's own (log it); ``type`` is the coarse family."""

    def __init__(self, message: str, *, status: int = 0, type: str | None = None, code: str | None = None,
                 param: str | None = None, connector: str | None = None, body: Any = None, request_id: str | None = None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.status_code = status
        self.type = type
        self.code = code
        self.param = param
        self.connector = connector
        self.body = body
        self.request_id = request_id


def _words(name: str) -> str:
    name = re.sub(r"^.*\.", "", name)
    name = re.sub(r"([a-z])([A-Z])", r"\1 \2", name)
    return re.sub(r"[_\-]+", " ", name).lower().strip()


class HermosoUnsupportedError(Exception):
    """Raised by a method this layer does not serve. The message names the Hermoso tool that does the job."""

    def __init__(self, method: str, tool: str | None = None, hint: str = ""):
        if tool:
            via = (f" Use the Hermoso tool `{tool}` instead: client.call_tool('{tool}', {{...}}) or "
                   f"POST {DEFAULT_BASE_URL}/v1/tools/{tool} (its arguments: GET /v1/tools/{tool}).")
        else:
            via = f" Search Hermoso's tools for it: GET {DEFAULT_BASE_URL}/v1/tools?search={urllib.parse.quote(_words(method))}."
        super().__init__(f"{method} is not supported by Hermoso's compatibility layer.{via}{(' ' + hint) if hint else ''}")
        self.code = "unsupported"
        self.method = method
        self.tool = tool


_TO_CHANNEL = {"twitter": "x", "x": "x", "gmb": "google_business", "googlebusiness": "google_business",
               "google_business": "google_business", "google": "google_business"}


def to_channel(platform: Any) -> str:
    p = str(platform or "").strip().lower()
    return _TO_CHANNEL.get(p, p)


def from_channel(channel: Any, dialect: str) -> str:
    c = str(channel or "").lower()
    if c == "x":
        return "twitter"
    if c == "google_business":
        return "gmb" if dialect == "ayrshare" else "googlebusiness"
    return c


COMMENT_TOOLS = {
    "facebook": {"list": "list_meta_comments", "comment": "comment_on_meta_post", "reply": "reply_to_meta_comment", "moderate": "moderate_meta_comment"},
    "instagram": {"list": "list_meta_comments", "comment": "comment_on_meta_post", "reply": "reply_to_meta_comment", "moderate": "moderate_meta_comment"},
    "youtube": {"list": "list_youtube_comments", "reply": "reply_to_youtube_comment", "moderate": "moderate_youtube_comment"},
    "tiktok": {"list": "list_tiktok_comments", "comment": "comment_on_tiktok_video", "reply": "reply_to_tiktok_comment", "moderate": "moderate_tiktok_comment"},
    "linkedin": {"list": "list_linkedin_comments", "comment": "reply_to_linkedin_comment", "reply": "reply_to_linkedin_comment", "moderate": "delete_linkedin_comment"},
    "threads": {"list": "list_threads_replies", "comment": "reply_to_thread", "reply": "reply_to_thread", "moderate": "hide_thread_reply"},
}

PUBLISHED_DELETE_TOOLS = {
    "facebook": "manage_meta_post", "instagram": "manage_meta_post", "threads": "manage_meta_post", "x": "delete_x_post",
    "youtube": "delete_youtube_video", "pinterest": "delete_pinterest_pin", "linkedin": "manage_linkedin_post",
    "google_business": "delete_google_business_post", "bluesky": "delete_bluesky_post", "wordpress": "delete_wordpress_post", "wix": "delete_wix_post",
}

TERMINAL = {"published", "partially_published", "failed", "indeterminate"}


def is_hermoso_hosted(url: str) -> bool:
    try:
        h = urllib.parse.urlparse(url).hostname or ""
    except ValueError:
        return False
    return h == "hermoso.ai" or h.endswith(".hermoso.ai")


def parse_brand_key(key: Any) -> tuple[str | None, str | None]:
    """A brand key is ``<brandId>`` or ``<brandId>:<ownerAccountId>`` (a brand another account shared with you)."""
    s = str(key or "").strip()
    if not s:
        return None, None
    if ":" not in s:
        return s, None
    b, o = s.split(":", 1)
    return b, (o or None)


def brand_key_of(b: dict) -> str:
    return f"{b['id']}:{b['owner_account_id']}" if b.get("owner_account_id") else str(b.get("id", ""))


def split_account_id(account_id: Any, platform: Any = None) -> tuple[str, str | None]:
    s = str(account_id or "")
    if ":" in s and s.index(":") > 0:
        ch, ref = s.split(":", 1)
        return to_channel(ch), ref
    if s and to_channel(s) == to_channel(platform or s):
        return to_channel(s), None
    return to_channel(platform or s), (s if s and platform else None)


class HermosoClient:
    """One small client for Hermoso's REST API. ``api_key`` defaults to ``HERMOSO_API_KEY``."""

    def __init__(self, api_key: str | None = None, *, base_url: str | None = None, brand: str | None = None,
                 timeout: float = 120.0, client: str = "compat", default_headers: dict | None = None):
        self.api_key = api_key or os.environ.get("HERMOSO_API_KEY", "")
        self.base_url = (base_url or os.environ.get("HERMOSO_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.timeout = timeout
        self.client = client
        self.default_headers = dict(default_headers or {})
        self.brand: str | None = None
        self.owner: str | None = None
        self._channels: tuple[float, list] | None = None
        # Layer settings (read by the Zernio routes).
        self.wait_for_publish = True
        self.publish_timeout = 120.0
        self.rehost_media = True
        if brand:
            self.set_brand(brand)

    def set_brand(self, key: Any) -> "HermosoClient":
        self.brand, self.owner = parse_brand_key(key)
        self._channels = None
        return self

    def for_brand(self, key: Any) -> "HermosoClient":
        c = HermosoClient(self.api_key, base_url=self.base_url, timeout=self.timeout, client=self.client, default_headers=self.default_headers)
        c.wait_for_publish, c.publish_timeout, c.rehost_media = self.wait_for_publish, self.publish_timeout, self.rehost_media
        c.set_brand(key)
        return c

    def headers(self, extra: dict | None = None) -> dict:
        if not self.api_key:
            raise HermosoApiError("No Hermoso API key. Pass it to the constructor or set HERMOSO_API_KEY. Create one at "
                                  "https://app.hermoso.ai on the API, MCP & CLI tab.", status=401, type="authentication_error", code="missing_api_key")
        h = {"Authorization": f"Bearer {self.api_key}", "Accept": "application/json",
             "User-Agent": f"hermoso-compat-python/{VERSION} ({self.client})", **self.default_headers}
        if self.brand:
            h["X-Hermoso-User"] = self.brand
        if self.owner:
            h["X-Hermoso-Owner"] = self.owner
        h.update(extra or {})
        return h

    def request(self, method: str, path: str, *, query: dict | None = None, body: Any = None, headers: dict | None = None,
                data: bytes | None = None, content_type: str | None = None) -> Any:
        url = self.base_url + path
        q = {k: (str(v).lower() if isinstance(v, bool) else str(v)) for k, v in (query or {}).items() if v not in (None, "")}
        if q:
            url += "?" + urllib.parse.urlencode(q)
        h = self.headers(headers)
        payload = None
        if data is not None:
            payload = data
            h["Content-Type"] = content_type or "application/octet-stream"
        elif body is not None:
            payload = json.dumps(body).encode("utf-8")
            h["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=payload, headers=h, method=method.upper())
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                text = res.read().decode("utf-8")
                status = res.status
                rid = res.headers.get("x-request-id")
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", "replace")
            try:
                j = json.loads(text) if text else {}
            except ValueError:
                j = None
            err = j.get("error") if isinstance(j, dict) and isinstance(j.get("error"), dict) else {}
            msg = err.get("message") or (j.get("error") if isinstance(j, dict) and isinstance(j.get("error"), str) else "") or f"Hermoso answered HTTP {e.code}."
            raise HermosoApiError(msg, status=e.code, type=err.get("type"), code=err.get("code") or f"http_{e.code}", param=err.get("param"),
                                  connector=err.get("connector"), body=j if j is not None else text,
                                  request_id=(j or {}).get("request_id") if isinstance(j, dict) else None) from None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise HermosoApiError(f"Could not reach Hermoso ({e}).", status=0, type="api_error", code="network_error") from None
        try:
            return json.loads(text) if text else {}
        except ValueError:
            raise HermosoApiError("Hermoso answered something that is not JSON.", status=status, type="api_error", code="bad_response", body=text, request_id=rid) from None

    def call_tool(self, name: str, args: dict | None = None) -> dict:
        """Call any Hermoso tool. Returns the tool result: ``{"text", "data"}``."""
        return self.request("POST", f"/v1/tools/{urllib.parse.quote(name)}", body=args or {})

    def channels(self) -> list:
        if self._channels and time.time() - self._channels[0] < 60:
            return self._channels[1]
        data = self.request("GET", "/v1/channels").get("data") or []
        self._channels = (time.time(), data)
        return data

    def connections(self) -> list:
        return self.request("GET", "/v1/connections").get("data") or []

    def brands(self) -> list:
        return self.request("GET", "/v1/brands").get("data") or []

    def rehost(self, url: str) -> str:
        if not url or is_hermoso_hosted(url):
            return url
        return self.request("POST", "/v1/media", query={"url": url}).get("url") or url

    def upload_bytes(self, data: Any, *, file_name: str | None = None, content_type: str | None = None) -> dict:
        raw = data
        ctype = content_type
        if isinstance(data, str):
            m = re.match(r"^data:([^;,]+)?(;base64)?,(.*)$", data, re.S)
            if m:
                ctype = ctype or m.group(1)
                raw = base64.b64decode(m.group(3)) if m.group(2) else urllib.parse.unquote_to_bytes(m.group(3))
            else:
                raw = base64.b64decode(data)
        return self.request("POST", "/v1/media", data=raw, content_type=ctype or "application/octet-stream",
                            headers={"X-File-Name": file_name} if file_name else None)

    def get_post(self, post_id: str) -> dict:
        return self.request("GET", f"/v1/posts/{urllib.parse.quote(str(post_id))}")

    def list_posts(self, *, status: str | None = None, channel: str | None = None, max: int = 100) -> list:
        out: list = []
        after = None
        while len(out) < max:
            r = self.request("GET", "/v1/posts", query={"limit": min(100, max - len(out)), "status": status, "channel": channel, "starting_after": after})
            out.extend(r.get("data") or [])
            if not r.get("has_more") or not r.get("next_cursor"):
                break
            after = r["next_cursor"]
        return out

    def wait_for_post(self, post_id: str, timeout: float = 120.0, interval: float = 2.0) -> dict:
        until = time.time() + timeout
        p = self.get_post(post_id)
        while p.get("status") not in TERMINAL and time.time() < until:
            time.sleep(interval)
            p = self.get_post(post_id)
        return p

    def account_selector(self, channel: str, ref: str | None) -> dict | None:
        if not ref:
            return None
        ch = next((c for c in self.channels() if c.get("id") == channel), None)
        try:
            conns = self.connections()
        except HermosoApiError:
            conns = []
        conn = next((c for c in conns if c.get("provider") == ((ch or {}).get("connector") or channel)), None)
        accts = (conn or {}).get("accounts") or []
        known = any(str(ref) in (str(a.get("id")), str(a.get("handle")), str(a.get("label"))) for a in accts)
        if len(accts) > 1 and known:
            return {"kind": "accounts", "value": str(ref)}
        if ch and ch.get("target_field"):
            return {"kind": "target", "field": ch["target_field"], "value": str(ref)}
        if accts:
            return {"kind": "accounts", "value": str(ref)}
        return None

    def account_rows(self) -> list:
        chs = self.channels()
        try:
            conns = self.connections()
        except HermosoApiError:
            conns = []
        rows = []
        for ch in chs:
            if not ch.get("connected") and not ch.get("needs_reconnect"):
                continue
            conn = next((c for c in conns if c.get("provider") == ch.get("connector")), None) or {}
            accts = conn.get("accounts") or [{"id": None, "label": ch.get("account") or conn.get("account"), "handle": None}]
            for a in accts:
                rows.append({"channel": ch["id"], "connector": ch.get("connector"),
                             "accountId": f"{ch['id']}:{a['id']}" if a.get("id") else ch["id"], "ref": a.get("id"),
                             "label": a.get("label") or ch.get("account") or conn.get("account"), "handle": a.get("handle"),
                             "needsReconnect": bool(ch.get("needs_reconnect")), "name": ch.get("name")})
        return rows
