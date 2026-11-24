"""Offline checks against a tiny stand-in for Hermoso's /v1 API (what the layers SEND, and how they shape answers)."""
import json
import os
import sys
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from hermoso_compat import HermosoUnsupportedError  # noqa: E402
from hermoso_compat._core import from_channel, to_channel  # noqa: E402
from hermoso_compat.ayrshare import SocialPost  # noqa: E402
from hermoso_compat.zernio import Zernio, ZernioAPIError  # noqa: E402

CALLS: list = []
POSTS: dict = {}
CHANNELS = [
    {"id": "x", "name": "X", "connector": "x", "available": True, "connected": True, "caption_max": 280, "target_field": None, "carousel": None},
    {"id": "facebook", "name": "Facebook", "connector": "meta", "available": True, "connected": True, "caption_max": 63206, "target_field": "pageId", "carousel": {"effective_max": 30}},
    {"id": "tiktok", "name": "TikTok", "connector": "tiktok", "available": True, "connected": False, "caption_max": 2200, "target_field": None, "carousel": None},
]


class Mock(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, status, obj):
        b = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _handle(self):
        u = urlparse(self.path)
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n) if n else b""
        body = json.loads(raw) if raw and "json" in (self.headers.get("content-type") or "") else None
        CALLS.append({"method": self.command, "path": u.path, "query": parse_qs(u.query), "body": body, "headers": dict(self.headers)})
        if self.headers.get("Authorization") != "Bearer hmk_test":
            return self._send(401, {"error": {"type": "authentication_error", "code": "invalid_api_key", "message": "Invalid API key."}})
        p = u.path
        if p == "/v1/channels":
            return self._send(200, {"object": "list", "data": CHANNELS})
        if p == "/v1/connections":
            return self._send(200, {"object": "list", "data": [{"provider": "x", "accounts": [{"id": "111", "handle": "@a"}, {"id": "222", "handle": "@b"}]}]})
        if p == "/v1/brands":
            return self._send(200, {"object": "list", "data": [{"id": "default", "name": "Acme", "is_default": True, "current": True}, {"id": "b2", "name": "Client", "owner_account_id": "acct9", "shared": True}]})
        if p == "/v1/posts" and self.command == "POST":
            if "tiktok" in body.get("channels", []):
                return self._send(401, {"error": {"type": "connector_error", "code": "channel_not_connected", "message": "TikTok is not connected.", "connector": "tiktok"}})
            pid = f"job_{len(POSTS) + 1}"
            now = not body.get("scheduled_at") and not body.get("use_queue")
            post = {"object": "post", "id": pid, "status": "published" if now else "scheduled", "scheduled_at": body.get("scheduled_at") or "2030-01-01T00:00:00Z",
                    "created_at": "2029-12-31T00:00:00Z", "channels": body["channels"], "caption": body.get("caption"), "media": [], "targets": body.get("targets") or {},
                    "results": [{"channel": c, "ok": True, "id": f"{c}-1", "url": f"https://example.com/{c}"} for c in body["channels"]] if now else None}
            POSTS[pid] = post
            return self._send(200, post)
        if p == "/v1/posts" and self.command == "GET":
            return self._send(200, {"object": "list", "data": list(reversed(list(POSTS.values()))), "has_more": False})
        if p.startswith("/v1/posts/"):
            pid = p.split("/")[-1]
            post = POSTS.get(pid)
            if not post:
                return self._send(404, {"error": {"code": "post_not_found", "message": "No post."}})
            if self.command == "DELETE":
                POSTS.pop(pid)
                return self._send(200, {"object": "post", "id": pid, "deleted": True})
            if self.command == "PATCH" and "caption" in body:
                post["caption"] = body["caption"]
            return self._send(200, post)
        if p.startswith("/v1/tools/"):
            return self._send(200, {"object": "tool_result", "tool": p[10:], "text": "ok", "data": {"queues": [{"id": "default", "name": "Default", "isDefault": True, "slots": ["09:00"], "timezone": "UTC"}]}})
        return self._send(404, {"error": {"code": "not_found", "message": p}})

    do_GET = do_POST = do_PATCH = do_DELETE = do_PUT = _handle


def last(path, method="POST"):
    return next(c for c in reversed(CALLS) if c["path"] == path and c["method"] == method)


class CompatTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), Mock)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.srv.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def test_platform_names(self):
        self.assertEqual(to_channel("twitter"), "x")
        self.assertEqual(to_channel("gmb"), "google_business")
        self.assertEqual(from_channel("google_business", "zernio"), "googlebusiness")

    def test_ayrshare_post_and_errors(self):
        s = SocialPost("hmk_test", base_url=self.url)
        r = s.post({"post": "Hi", "platforms": ["twitter", "facebook"], "faceBookOptions": {"pageId": "P1"}, "firstComment": {"comment": "c"}, "idempotencyKey": "k"})
        sent = last("/v1/posts")
        self.assertEqual(sent["body"]["channels"], ["x", "facebook"])
        self.assertEqual(sent["body"]["targets"]["pageId"], "P1")
        self.assertEqual(sent["body"]["first_comment"], "c")
        self.assertEqual(sent["headers"].get("Idempotency-Key"), "k")
        self.assertEqual(r["status"], "success")
        self.assertEqual([p["platform"] for p in r["postIds"]], ["twitter", "facebook"])
        bad = s.post({"post": "x", "platforms": ["tiktok"]})
        self.assertEqual((bad["status"], bad["code"]), ("error", "channel_not_connected"))
        with self.assertRaises(HermosoUnsupportedError):
            s.addFeed({})

    def test_ayrshare_profile_key(self):
        s = SocialPost("hmk_test", base_url=self.url)
        key = next(p for p in s.getProfiles()["profiles"] if p["shared"])["profileKey"]
        self.assertEqual(key, "b2:acct9")
        s.setProfileKey(key).history()
        h = last("/v1/posts", "GET")["headers"]
        self.assertEqual((h.get("X-Hermoso-User"), h.get("X-Hermoso-Owner")), ("b2", "acct9"))

    def test_zernio_create_get_update_delete(self):
        z = Zernio(api_key="hmk_test", base_url=self.url)
        when = datetime.now(timezone.utc) + timedelta(days=1)
        r = z.posts.create(content="Hi", platforms=[{"platform": "twitter", "accountId": "x:222"}, {"platform": "facebook", "accountId": "facebook:P9"}], scheduled_for=when)
        sent = last("/v1/posts")["body"]
        self.assertEqual(sent["options"]["accounts"], {"x": ["222"]})
        self.assertEqual(sent["targets"]["pageId"], "P9")
        self.assertEqual(r.post.status, "scheduled")
        self.assertEqual(z.posts.get_post(r.post._id)["post"]["_id"], r.post._id)
        self.assertEqual(z.posts.update(r.post._id, content="edited").post.content, "edited")
        self.assertEqual(z.posts.delete(r.post._id)["message"], "Post deleted successfully")

    def test_zernio_errors(self):
        z = Zernio(api_key="hmk_test", base_url=self.url)
        with self.assertRaises(ZernioAPIError) as cm:
            z.posts.create(content="x", platforms=[{"platform": "tiktok", "accountId": "tiktok"}], publish_now=True)
        self.assertEqual(cm.exception.code, "channel_not_connected")
        with self.assertRaises(HermosoUnsupportedError):
            z.posts.pin_post("a")
        with self.assertRaises(HermosoUnsupportedError):
            z.whatsapp.send_whatsapp_message(to="x")
        dry = z.posts.create_post(content="y" * 300, platforms=[{"platform": "twitter", "accountId": "x"}], dry_run=True)
        self.assertFalse(dry["valid"])

    def test_zernio_needs_hermoso_key(self):
        old = os.environ.pop("HERMOSO_API_KEY", None)
        os.environ["ZERNIO_API_KEY"] = "sk_zernio"
        try:
            with self.assertRaises(ValueError):
                Zernio()
        finally:
            os.environ.pop("ZERNIO_API_KEY", None)
            if old:
                os.environ["HERMOSO_API_KEY"] = old


if __name__ == "__main__":
    unittest.main()
