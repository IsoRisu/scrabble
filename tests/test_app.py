"""Quick HTTP smoke tests (skipped when Flask-SocketIO is not installed)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    import app as app_module
except ImportError:  # pragma: no cover
    app_module = None

import game.room as room_module
from game.room import set_words

if not getattr(room_module, "_en_stubbed", False):
    _orig_available = room_module.available_languages
    room_module.available_languages = lambda: sorted(set(_orig_available()) | {"en"})
    room_module._en_stubbed = True


@unittest.skipIf(app_module is None, "flask_socketio not installed")
class AppSmokeTests(unittest.TestCase):
    def setUp(self):
        set_words(["CAT", "CATS"])
        self.client = app_module.app.test_client()

    def test_security_headers(self):
        response = self.client.get("/")
        self.assertEqual(response.headers.get("X-Content-Type-Options"), "nosniff")
        self.assertEqual(response.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin")
        self.assertEqual(response.headers.get("X-Frame-Options"), "DENY")

    def test_send_file_max_age_default(self):
        self.assertEqual(app_module.app.config.get("SEND_FILE_MAX_AGE_DEFAULT"), 3600)

    def test_healthz(self):
        self.assertEqual(self.client.get("/healthz").status_code, 200)

    def test_home_page(self):
        self.assertEqual(self.client.get("/").status_code, 200)

    def test_create_room_defaults_to_wild(self):
        data = self.client.post("/create", json={}).get_json()
        self.assertEqual(data["mode"], "wild")
        info = self.client.get(f"/api/room/{data['code']}").get_json()
        self.assertTrue(info["exists"])

    def test_create_rejects_unknown_mode(self):
        self.assertEqual(self.client.post("/create", json={"mode": "nope"}).status_code, 400)

    def test_unknown_room(self):
        self.assertFalse(self.client.get("/api/room/ZZZZZZZZ").get_json()["exists"])

    def test_rate_limiter_helper(self):
        sid = "test_sid_123"
        # Clear any existing state for sid
        app_module._RATE_LIMIT_TIMERS.pop(sid, None)
        for _ in range(20):
            self.assertFalse(app_module.check_rate_limit(sid))
        # 21st event in the same moment should be rate-limited
        self.assertTrue(app_module.check_rate_limit(sid))
        app_module._RATE_LIMIT_TIMERS.pop(sid, None)


if __name__ == "__main__":
    unittest.main()
