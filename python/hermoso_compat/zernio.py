"""Zernio-compatible client (the ``zernio-sdk`` package's ``Zernio`` class, resources and method names), served by Hermoso.

    - from zernio import Zernio
    + from hermoso_compat.zernio import Zernio
      client = Zernio(api_key=os.environ["HERMOSO_API_KEY"])

Methods take Zernio's keyword arguments (snake_case) and return the response body as a dict that also allows
attribute access (``resp.posts`` and ``resp["posts"]`` both work). API errors raise ``ZernioAPIError`` and its
subclasses. A method this layer does not serve raises ``HermosoUnsupportedError`` naming the Hermoso tool to use.
Every ``a``-prefixed async twin (``alist``, ``acreate_post``...) exists too.

Unofficial: written by Hermoso, not affiliated with or endorsed by Zernio.
"""

from __future__ import annotations

import asyncio
import functools
import mimetypes
import os
import re
from pathlib import Path
from typing import Any

from ._core import HermosoApiError, HermosoClient, HermosoUnsupportedError
from ._zernio_rest import unsupported, zernio_route


class AttrDict(dict):
    """A dict whose keys are also attributes, recursively, so code written for the original's models keeps working."""

    def __getattr__(self, k: str) -> Any:
        try:
            return self[k]
        except KeyError:
            raise AttributeError(k) from None

    def model_dump(self, **_: Any) -> dict:
        return _plain(self)


def _wrap(v: Any) -> Any:
    if isinstance(v, dict):
        return AttrDict({k: _wrap(x) for k, x in v.items()})
    if isinstance(v, list):
        return [_wrap(x) for x in v]
    return v


def _plain(v: Any) -> Any:
    if isinstance(v, dict):
        return {k: _plain(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_plain(x) for x in v]
    return v


class ZernioError(Exception):
    pass


class ZernioAPIError(ZernioError):
    def __init__(self, message: str, status_code: int = 0, code: str | None = None, body: Any = None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code
        self.body = body


class ZernioAuthenticationError(ZernioAPIError):
    pass


class ZernioRateLimitError(ZernioAPIError):
    pass


class ZernioNotFoundError(ZernioAPIError):
    pass


class ZernioForbiddenError(ZernioAPIError):
    pass


class ZernioValidationError(ZernioError):
    def __init__(self, message: str, status_code: int = 400, code: str | None = None, body: Any = None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code
        self.body = body


class ZernioConnectionError(ZernioError):
    pass


class ZernioTimeoutError(ZernioError):
    pass


LateError, LateAPIError, LateAuthenticationError, LateRateLimitError = ZernioError, ZernioAPIError, ZernioAuthenticationError, ZernioRateLimitError
LateNotFoundError, LateForbiddenError, LateValidationError = ZernioNotFoundError, ZernioForbiddenError, ZernioValidationError
LateConnectionError, LateTimeoutError = ZernioConnectionError, ZernioTimeoutError


def _to_zernio_error(e: Exception) -> Exception:
    if not isinstance(e, HermosoApiError):
        return e
    body = {"error": e.message, "code": e.code, "type": e.type, "param": e.param, "platform": e.connector, "hermoso": e.body, "requestId": e.request_id}
    if e.status == 0:
        return ZernioConnectionError(e.message)
    cls = {401: ZernioAuthenticationError, 403: ZernioForbiddenError, 404: ZernioNotFoundError, 429: ZernioRateLimitError}.get(e.status)
    if cls:
        return cls(e.message, e.status, e.code, body)
    if e.status == 400 and e.param:
        return ZernioValidationError(e.message, 400, e.code, body)
    return ZernioAPIError(e.message, e.status, e.code, body)


def _camel(s: str) -> str:
    return re.sub(r"_([a-z0-9])", lambda m: m.group(1).upper(), s)


# name → (HTTP method, Zernio path, positional path params, where keyword args go)
_M = {
    "posts": {
        "list_posts": ("GET", "/v1/posts", [], "query"), "create_post": ("POST", "/v1/posts", [], "body"),
        "get_post": ("GET", "/v1/posts/{postId}", ["post_id"], "query"), "update_post": ("PUT", "/v1/posts/{postId}", ["post_id"], "body"),
        "delete_post": ("DELETE", "/v1/posts/{postId}", ["post_id"], "query"), "retry_post": ("POST", "/v1/posts/{postId}/retry", ["post_id"], "body"),
    },
    "profiles": {
        "list_profiles": ("GET", "/v1/profiles", [], "query"), "create_profile": ("POST", "/v1/profiles", [], "body"),
        "get_profile": ("GET", "/v1/profiles/{profileId}", ["profile_id"], "query"), "update_profile": ("PUT", "/v1/profiles/{profileId}", ["profile_id"], "body"),
    },
    "accounts": {
        "list_accounts": ("GET", "/v1/accounts", [], "query"), "get_account": ("GET", "/v1/accounts/{accountId}", ["account_id"], "query"),
        "delete_account": ("DELETE", "/v1/accounts/{accountId}", ["account_id"], "query"),
        "get_all_accounts_health": ("GET", "/v1/accounts/health", [], "query"), "get_account_health": ("GET", "/v1/accounts/{accountId}/health", ["account_id"], "query"),
        "get_follower_stats": ("GET", "/v1/accounts/follower-stats", [], "query"), "get_account_posts": ("GET", "/v1/accounts/{accountId}/posts", ["account_id"], "query"),
        "get_google_business_reviews": ("GET", "/v1/accounts/{accountId}/gmb-reviews", ["account_id"], "query"),
        "reply_to_google_business_review": ("POST", "/v1/accounts/{accountId}/gmb-reviews/{reviewId}/reply", ["account_id", "review_id"], "body"),
        "delete_google_business_review_reply": ("DELETE", "/v1/accounts/{accountId}/gmb-reviews/{reviewId}/reply", ["account_id", "review_id"], "query"),
    },
    "media": {"get_media_presigned_url": ("POST", "/v1/media/presign", [], "body")},
    "queue": {
        "list_queue_slots": ("GET", "/v1/queue/slots", [], "query"), "create_queue_slot": ("POST", "/v1/queue/slots", [], "body"),
        "update_queue_slot": ("PUT", "/v1/queue/slots", [], "body"), "delete_queue_slot": ("DELETE", "/v1/queue/slots", [], "query"),
    },
    "webhooks": {
        "get_webhook_settings": ("GET", "/v1/webhooks/settings", [], "query"), "create_webhook_settings": ("POST", "/v1/webhooks/settings", [], "body"),
        "update_webhook_settings": ("PUT", "/v1/webhooks/settings", [], "body"), "delete_webhook_settings": ("DELETE", "/v1/webhooks/settings", [], "query"),
        "test_webhook": ("POST", "/v1/webhooks/test", [], "body"), "get_webhook_logs": ("GET", "/v1/webhooks/logs", [], "query"),
        "redeliver_webhook_event": ("POST", "/v1/webhooks/logs/redeliver", [], "body"),
    },
    "connect": {"get_connect_url": ("GET", "/v1/connect/{platform}", ["platform"], "query"), "create_platform_invite": ("POST", "/v1/platform-invites", [], "body")},
    "analytics": {
        "get_analytics": ("GET", "/v1/analytics", [], "query"), "get_best_time_to_post": ("GET", "/v1/analytics/best-time", [], "query"),
        "get_content_decay": ("GET", "/v1/analytics/content-decay", [], "query"), "get_posting_frequency": ("GET", "/v1/analytics/posting-frequency", [], "query"),
        "get_instagram_follower_history": ("GET", "/v1/analytics/instagram/follower-history", [], "query"),
    },
    "users": {"get_current_user": ("GET", "/v1/users/me", [], "query")},
    "usage": {"get_usage_stats": ("GET", "/v1/usage-stats", [], "query"), "get_usage": ("GET", "/v1/usage", [], "query")},
    "comments": {
        "get_inbox_post_comments": ("GET", "/v1/inbox/comments/{postId}", ["post_id"], "query"),
        "reply_to_inbox_post": ("POST", "/v1/inbox/comments/{postId}", ["post_id"], "body"),
        "delete_inbox_comment": ("DELETE", "/v1/inbox/comments/{postId}", ["post_id"], "query"),
        "hide_inbox_comment": ("POST", "/v1/inbox/comments/{postId}/{commentId}/hide", ["post_id", "comment_id"], "body"),
        "unhide_inbox_comment": ("DELETE", "/v1/inbox/comments/{postId}/{commentId}/hide", ["post_id", "comment_id"], "query"),
        "send_private_reply_to_comment": ("POST", "/v1/inbox/comments/{postId}/{commentId}/private-reply", ["post_id", "comment_id"], "body"),
    },
    "reviews": {
        "list_inbox_reviews": ("GET", "/v1/inbox/reviews", [], "query"), "reply_to_inbox_review": ("POST", "/v1/inbox/reviews/{reviewId}/reply", ["review_id"], "body"),
        "delete_inbox_review_reply": ("DELETE", "/v1/inbox/reviews/{reviewId}/reply", ["review_id"], "query"),
    },
    "validate": {"validate_post_length": ("POST", "/v1/tools/validate/post-length", [], "body"), "validate_post": ("POST", "/v1/tools/validate/post", [], "body")},
}
# The friendly names the hand-written resources expose.
_ALIASES = {
    "posts": {"list": "list_posts", "create": "create_post", "get": "get_post", "update": "update_post", "delete": "delete_post", "retry": "retry_post"},
    "profiles": {"list": "list_profiles", "create": "create_profile", "get": "get_profile", "update": "update_profile"},
    "accounts": {"list": "list_accounts", "get": "get_account"},
    "queue": {"get_slots": "list_queue_slots", "update_slots": "update_queue_slot", "delete_slots": "delete_queue_slot"},
    "analytics": {"get": "get_analytics"},
    "users": {},
}
SERVED_METHODS = {ns: sorted(m) for ns, m in _M.items()}


class _Resource:
    def __init__(self, client: "Zernio", ns: str):
        self._client = client
        self._ns = ns

    def __getattr__(self, name: str) -> Any:
        if name.startswith("__"):
            raise AttributeError(name)
        if name.startswith("a") and len(name) > 1:
            sync = self._sync_name(name[1:])
            if sync:
                fn = getattr(self, sync)

                async def _async(*args: Any, **kwargs: Any) -> Any:
                    return await asyncio.to_thread(functools.partial(fn, *args, **kwargs))
                return _async
        real = _ALIASES.get(self._ns, {}).get(name, name)
        if real in _M.get(self._ns, {}):
            return functools.partial(self._call, real)
        if self._ns == "media" and name in ("upload", "upload_bytes", "upload_multiple", "upload_large", "upload_large_bytes"):
            return getattr(self, "_" + name)

        def _unsupported(*_: Any, **__: Any) -> Any:
            raise unsupported(self._ns, name)
        return _unsupported

    def _sync_name(self, name: str) -> str | None:
        real = _ALIASES.get(self._ns, {}).get(name, name)
        if real in _M.get(self._ns, {}) or name in _ALIASES.get(self._ns, {}) or (self._ns == "media" and name.startswith("upload")):
            return name
        return None

    def _call(self, _op: str, /, *args: Any, **kwargs: Any) -> Any:
        method, tpl, path_params, where = _M[self._ns][_op]
        values = dict(zip(path_params, args))
        for p in path_params:
            if p in kwargs:
                values[p] = kwargs.pop(p)
        path = tpl
        for p in path_params:
            v = values.get(p)
            if v is None or str(v) in ("", ".", ".."):
                raise ZernioValidationError(f'Path parameter "{p}" is required and cannot be empty, "." or "..".')
            path = path.replace("{" + _camel(p) + "}", str(v))
        headers = {}
        if kwargs.get("idempotency_key") is not None:
            headers["Idempotency-Key"] = str(kwargs.pop("idempotency_key"))
        kwargs.pop("x_request_id", None)
        fields = {_camel(k): v for k, v in kwargs.items() if v is not None}
        try:
            data = zernio_route(self._client.hermoso, method, path, query=fields if where == "query" else {}, body=fields if where == "body" else {}, headers=headers)
        except Exception as e:  # noqa: BLE001
            raise _to_zernio_error(e) from None
        return _wrap(data)

    # media.upload helpers (the original's convenience methods). Each returns {"publicUrl", "files": [...]}.
    def _upload_bytes(self, content: bytes, filename: str, content_type: str | None = None, /) -> Any:
        try:
            m = self._client.hermoso.upload_bytes(content, file_name=filename, content_type=content_type or mimetypes.guess_type(filename)[0])
        except Exception as e:  # noqa: BLE001
            raise _to_zernio_error(e) from None
        f = {"url": m.get("url"), "publicUrl": m.get("url"), "filename": filename, "size": m.get("bytes"), "type": m.get("type")}
        return _wrap({"publicUrl": m.get("url"), "files": [f]})

    def _upload(self, file_path: str | Path) -> Any:
        p = Path(file_path)
        return self._upload_bytes(p.read_bytes(), p.name)

    def _upload_multiple(self, file_paths: list) -> Any:
        files = [self._upload(p)["files"][0] for p in file_paths]
        return _wrap({"files": files, "publicUrl": files[0]["url"] if files else None})

    _upload_large = _upload
    _upload_large_bytes = _upload_bytes


class Zernio:
    """Drop-in for ``zernio.Zernio``. ``api_key`` defaults to ``HERMOSO_API_KEY`` (``ZERNIO_API_KEY`` is read only when it holds an ``hmk_`` key)."""

    def __init__(self, api_key: str | None = None, *, base_url: str | None = None, timeout: float = 30.0, max_retries: int = 3,
                 publish_timeout: float = 300.0, transport: Any = None, user_agent: str | None = None, wait_for_publish: bool = True,
                 rehost_media: bool = True) -> None:
        z = os.environ.get("ZERNIO_API_KEY") or os.environ.get("LATE_API_KEY") or ""
        key = api_key or os.environ.get("HERMOSO_API_KEY") or (z if z.startswith("hmk_") else "")
        if not key:
            raise ValueError("A Hermoso API key is required. Pass api_key= or set HERMOSO_API_KEY. Create one at https://app.hermoso.ai on the API, MCP & CLI tab.")
        if base_url and re.search(r"zernio\.com|getlate\.dev", base_url):
            base_url = None
        if base_url:
            base_url = re.sub(r"/api/?$", "", base_url)
        self.hermoso = HermosoClient(key, base_url=base_url, timeout=max(timeout, publish_timeout), client="zernio")
        self.hermoso.wait_for_publish = wait_for_publish
        self.hermoso.publish_timeout = publish_timeout
        self.hermoso.rehost_media = rehost_media
        self.api_key = key
        self.base_url = self.hermoso.base_url
        for ns in _M:
            setattr(self, ns, _Resource(self, ns))

    def __getattr__(self, name: str) -> Any:
        if name.startswith("__"):
            raise AttributeError(name)
        return _Resource(self, name)

    def call_tool(self, name: str, args: dict | None = None) -> Any:
        """Escape hatch: call any Hermoso tool. Returns ``{"text", "data"}``."""
        return _wrap(self.hermoso.call_tool(name, args))

    def request(self, method: str, path: str, *, query: dict | None = None, body: dict | None = None, headers: dict | None = None) -> Any:
        """Run any Zernio REST call (method + Zernio path) against Hermoso."""
        try:
            return _wrap(zernio_route(self.hermoso, method, path, query=query, body=body, headers=headers))
        except Exception as e:  # noqa: BLE001
            raise _to_zernio_error(e) from None

    def close(self) -> None:
        pass

    def __enter__(self) -> "Zernio":
        return self

    def __exit__(self, *_: Any) -> None:
        pass

    async def __aenter__(self) -> "Zernio":
        return self

    async def __aexit__(self, *_: Any) -> None:
        pass


Late = Zernio

__all__ = ["Zernio", "Late", "AttrDict", "SERVED_METHODS", "HermosoApiError", "HermosoUnsupportedError",
           "ZernioError", "ZernioAPIError", "ZernioAuthenticationError", "ZernioRateLimitError", "ZernioNotFoundError", "ZernioForbiddenError",
           "ZernioValidationError", "ZernioConnectionError", "ZernioTimeoutError",
           "LateError", "LateAPIError", "LateAuthenticationError", "LateRateLimitError", "LateNotFoundError", "LateForbiddenError",
           "LateValidationError", "LateConnectionError", "LateTimeoutError"]
