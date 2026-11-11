"""Notifications and chat lists name a KLIPY GIF instead of showing its link."""
import os
import unittest
import unittest.mock

os.environ.setdefault("APP_STORAGE_DIR", "/tmp/social-gif-link-tests")
os.environ.setdefault("APP_ID", "7")
os.environ.setdefault("APP_SLUG", "social")
import social_routes as routes

GIF = "https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/um0L4dFH.gif"


class GifPreview(unittest.TestCase):
  def test_gif_alone_or_captioned(self):
    self.assertEqual(routes._message_preview(GIF), "GIF")
    self.assertEqual(routes._message_preview(f"so true\n{GIF}"), "so true · GIF")

  def test_anything_else_is_ordinary_text(self):
    for text in (
      f"look {GIF}", f"{GIF}\nnice", GIF.replace("https:", "http:"),
      GIF.replace("static.klipy.com", "klipy.com.evil.test"),
      GIF.replace("static.klipy.com", "static.klipy.com:8443"),
      "https://example.com/cat.gif",
    ):
      self.assertEqual(routes._message_preview(text), text[:120], text)
    self.assertEqual(routes._message_preview(""), "📷 Photo")


class SharedGifKey(unittest.IsolatedAsyncioTestCase):
  """This Möbius asks the community host once per hour, signed as itself."""

  def setUp(self):
    routes._gif_key_cache.update(key=None, at=0.0)
    self.patches = [
      unittest.mock.patch.object(routes, "_load_identity", return_value={"private_key_b64": "k"}),
      unittest.mock.patch.object(routes, "_sign", return_value="sig"),
      unittest.mock.patch.object(routes, "_own_host", return_value="me.example"),
    ]
    for patcher in self.patches:
      patcher.start()

  def tearDown(self):
    for patcher in self.patches:
      patcher.stop()
    routes._gif_key_cache.update(key=None, at=0.0)

  def _response(self, status, body):
    request = routes.httpx.Request("POST", "https://www.mobius.you/x")
    return routes.httpx.Response(status, json=body, request=request)

  async def test_key_is_fetched_signed_and_remembered(self):
    calls = []

    async def fake(method, url, *, json, timeout_seconds):
      calls.append((url, json))
      return self._response(200, {"provider": "klipy", "app_key": "shared_key_123456"})

    with unittest.mock.patch.object(routes, "federation_request", fake):
      self.assertEqual(await routes._community_gif_key(), "shared_key_123456")
      self.assertEqual(await routes._community_gif_key(), "shared_key_123456")
    self.assertEqual(len(calls), 1)
    url, envelope = calls[0]
    self.assertTrue(url.endswith("/gifs/key"))
    self.assertEqual((envelope["type"], envelope["from"], envelope["sig"]), ("gif_key_read", "me.example", "sig"))

  async def test_unset_older_or_refused_hosts_explain_themselves(self):
    for status, expected in ((404, 404), (405, 404), (403, 403), (500, 502)):
      async def fake(method, url, *, json, timeout_seconds, status=status):
        return self._response(status, {"detail": "x"})
      with unittest.mock.patch.object(routes, "federation_request", fake):
        with self.assertRaises(routes.HTTPException) as caught:
          await routes._community_gif_key()
      self.assertEqual(caught.exception.status_code, expected, status)

  async def test_a_malformed_key_is_never_handed_on(self):
    async def fake(method, url, *, json, timeout_seconds):
      return self._response(200, {"app_key": "bad key; script"})
    with unittest.mock.patch.object(routes, "federation_request", fake):
      with self.assertRaises(routes.HTTPException):
        await routes._community_gif_key()


if __name__ == "__main__":
  unittest.main()
