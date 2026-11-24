#!/usr/bin/env python3
"""
test_serve_backgrounds.py — the stage backgrounds in serve.py (M11): the GET /api/backgrounds
lister and the /bgv/ + /bgphoto/ data routes.

Run with:  python3 -m unittest discover -s test -p 'test_*.py' -t test   (or `npm test`)

Two layers, cheapest first:

  * PURE: _list_backgrounds(data_dir) against a temporary directory — what is listed, in what
    order, how the URLs are encoded, the cap, symlinks; and Handler.translate_path on an
    instance built without a socket (the data routes and the `..` sanitiser).

  * A real http.server on an ephemeral 127.0.0.1 port (loopback only), the same way
    test_serve_push.py does it: the endpoint's status, headers and body on a keep-alive socket,
    a Range/206 on a background clip, and `..` under /bgv/ refused over the wire.

Nothing here reads or writes the real data/ directory: serve.DATA_DIR points at a temporary one.
"""

import contextlib
import functools
import http.client
import io
import json
import os
import sys
import tempfile
import threading
import unittest

TOOLS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools")
sys.path.insert(0, TOOLS)

import catalog_common  # noqa: E402
import serve  # noqa: E402

EMPTY = {"videos": [], "photos": [], "categories": {"videos": [], "photos": []}}
PATCHED = ("DATA_DIR", "BG_MAX_ITEMS", "IGNORE_NAMES")


def item(url, category=""):
    return {"url": url, "category": category}


class BackgroundsCase(unittest.TestCase):
    """A temporary root holding data/ (the data dir) and app/ (the static root)."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = tmp.name
        self.data = os.path.join(self.root, "data")
        self.app = os.path.join(self.root, "app")
        os.makedirs(self.data)
        os.makedirs(self.app)
        saved = {n: getattr(serve, n) for n in PATCHED}
        self.addCleanup(lambda: [setattr(serve, n, v) for n, v in saved.items()])
        serve.DATA_DIR = self.data

    def put(self, rel, data=b""):
        """Create data/<rel> (a file) with its parent folders; returns the absolute path."""
        path = os.path.join(self.data, *rel.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data)
        return path

    def mkdir(self, rel):
        path = os.path.join(self.data, *rel.split("/"))
        os.makedirs(path, exist_ok=True)
        return path

    def listing(self):
        return serve._list_backgrounds(self.data)

    def handler(self):
        """A Handler with no socket: translate_path and guess_type need only `directory`."""
        h = serve.Handler.__new__(serve.Handler)
        h.directory = self.app
        return h

    def symlink(self, target, rel):
        link = os.path.join(self.data, *rel.split("/"))
        os.makedirs(os.path.dirname(link), exist_ok=True)
        try:
            os.symlink(target, link)
        except (OSError, NotImplementedError) as exc:   # Windows without the privilege
            self.skipTest(f"symlinks unavailable: {exc}")
        return link


def inside(path, root):
    return os.path.commonpath([os.path.normpath(path), os.path.normpath(root)]) == os.path.normpath(root)


# ---------------------------------------------------------------------------------------
# Pure: the lister
# ---------------------------------------------------------------------------------------
class TestListBackgrounds(BackgroundsCase):
    def test_missing_folders_give_empty_lists(self):
        self.assertEqual(self.listing(), EMPTY)
        self.assertEqual(serve._list_backgrounds(os.path.join(self.root, "no-such-dir")), EMPTY)
        # A FILE named bgv and an empty bgphoto/ are no media either.
        with open(os.path.join(self.data, "bgv"), "wb"):
            pass
        self.mkdir("bgphoto")
        self.assertEqual(self.listing(), EMPTY)
        self.assertEqual(json.loads(json.dumps(self.listing())), EMPTY)   # JSON-ready as is

    def test_lists_top_level_and_one_sub_level_only(self):
        for rel in ("bgv/top.mp4", "bgv/party/one.mp4", "bgv/party/deeper/two.mp4",
                    "bgv/party/deeper/more/three.mp4", "bgphoto/a.jpg", "bgphoto/beach/b.jpg",
                    "bgphoto/beach/rocks/c.jpg"):
            self.put(rel)
        self.assertEqual(self.listing(), {
            "videos": [item("/bgv/top.mp4"), item("/bgv/party/one.mp4", "party")],
            "photos": [item("/bgphoto/a.jpg"), item("/bgphoto/beach/b.jpg", "beach")],
            "categories": {"videos": ["party"], "photos": ["beach"]},
        })

    def test_filters_by_extension_case_insensitively(self):
        for name in ("A.MP4", "b.WebM", "c.m4v", "D.Mov", "e.avi", "f.mkv", "g.txt", "noext",
                     "photo.jpg", "clip.mp4.part"):
            self.put("bgv/" + name)
        self.put("bgv/folder.mp4/x.mp4")          # a FOLDER named like a clip is a category
        for name in ("x.JPG", "y.jpeg", "z.PNG", "w.WebP", "v.gif", "u.heic", "clip.mp4"):
            self.put("bgphoto/" + name)
        got = self.listing()
        self.assertEqual(got["videos"], [item("/bgv/A.MP4"), item("/bgv/D.Mov"), item("/bgv/b.WebM"),
                                         item("/bgv/c.m4v"), item("/bgv/folder.mp4/x.mp4", "folder.mp4")])
        self.assertEqual([i["url"] for i in got["photos"]],
                         ["/bgphoto/w.WebP", "/bgphoto/x.JPG", "/bgphoto/y.jpeg", "/bgphoto/z.PNG"])
        self.assertEqual(serve.BG_VIDEO_EXTS, (".mp4", ".webm", ".m4v", ".mov"))
        self.assertEqual(serve.BG_PHOTO_EXTS, (".jpg", ".jpeg", ".png", ".webp"))

    def test_skips_hidden_and_ignored_names(self):
        # serve uses the builders' own set, not a copy that could drift from it.
        self.assertIs(serve.IGNORE_NAMES, catalog_common.IGNORE_NAMES)
        for rel in ("bgv/.hidden.mp4", "bgv/._appledouble.mp4", "bgv/.DS_Store", "bgv/Thumbs.db",
                    "bgv/desktop.ini", "bgv/.cache/inside.mp4", "bgv/keep.mp4", "bgv/SKIP-ME.MP4",
                    "bgv/party/.hidden.mp4", "bgv/party/ok.mp4",
                    "bgphoto/Thumbs.db/x.jpg", "bgphoto/.trash/y.jpg"):
            self.put(rel)
        # The shipped names carry no media extension, so prove the set is consulted (and
        # case-insensitively) with one that does; folders named like OS litter are skipped too.
        serve.IGNORE_NAMES = set(catalog_common.IGNORE_NAMES) | {"skip-me.mp4"}
        self.assertEqual(self.listing(), {
            "videos": [item("/bgv/keep.mp4"), item("/bgv/party/ok.mp4", "party")],
            "photos": [],
            "categories": {"videos": ["party"], "photos": []},
        })

    def test_urls_are_percent_encoded(self):
        clip = self.put("bgv/Party Time/café #1.mp4")
        odd = self.put("bgv/100% fun+?.mp4")
        photo = self.put("bgphoto/日本/桜 2.webp")
        got = self.listing()
        self.assertEqual(got["videos"], [item("/bgv/100%25%20fun%2B%3F.mp4"),
                                         item("/bgv/Party%20Time/caf%C3%A9%20%231.mp4", "Party Time")])
        self.assertEqual(got["photos"], [item("/bgphoto/%E6%97%A5%E6%9C%AC/%E6%A1%9C%202.webp", "日本")])
        self.assertEqual(got["categories"], {"videos": ["Party Time"], "photos": ["日本"]})
        # Each URL is plain ASCII and the server's own routing maps it back to the very file.
        h = self.handler()
        for entry, path in ((got["videos"][0], odd), (got["videos"][1], clip), (got["photos"][0], photo)):
            self.assertTrue(all(32 < ord(c) < 127 for c in entry["url"]), entry["url"])
            self.assertTrue(os.path.samefile(h.translate_path(entry["url"]), path), entry["url"])

    def test_categories_are_sorted_and_distinct(self):
        for rel in ("bgv/zeta/1.mp4", "bgv/zeta/2.mp4", "bgv/alpha/1.mp4", "bgv/Beta/1.webm",
                    "bgv/empty/notes.txt", "bgv/top.mp4",
                    "bgphoto/city/a.png", "bgphoto/beach/a.jpg", "bgphoto/beach/b.jpg"):
            self.put(rel)
        self.mkdir("bgv/hollow")
        got = self.listing()
        # Distinct, sorted, never "" and never a folder with nothing listable in it.
        self.assertEqual(got["categories"], {"videos": ["Beta", "alpha", "zeta"],
                                             "photos": ["beach", "city"]})
        # The items: the top level first, then each sub-folder in name order.
        self.assertEqual([i["url"] for i in got["videos"]],
                         ["/bgv/top.mp4", "/bgv/Beta/1.webm", "/bgv/alpha/1.mp4",
                          "/bgv/zeta/1.mp4", "/bgv/zeta/2.mp4"])
        self.assertEqual(self.listing(), got)                    # deterministic

    def test_cap_is_applied(self):
        self.assertEqual(serve.BG_MAX_ITEMS, 2000)
        for rel in ("bgv/a.mp4", "bgv/b.mp4", "bgv/x/c.mp4", "bgv/x/d.mp4", "bgv/y/e.mp4"):
            self.put(rel)
        for n in range(5):
            self.put(f"bgphoto/p{n}.jpg")
        serve.BG_MAX_ITEMS = 3
        got = self.listing()
        # The first three in listing order, across the top-level/sub-folder boundary; the
        # categories follow the capped list; each kind is capped on its own.
        self.assertEqual(got["videos"], [item("/bgv/a.mp4"), item("/bgv/b.mp4"), item("/bgv/x/c.mp4", "x")])
        self.assertEqual(got["categories"]["videos"], ["x"])
        self.assertEqual([i["url"] for i in got["photos"]],
                         ["/bgphoto/p0.jpg", "/bgphoto/p1.jpg", "/bgphoto/p2.jpg"])
        # And the real cap, on a real folder past it.
        serve.BG_MAX_ITEMS = 2000
        many = self.mkdir("bgphoto/many")
        for n in range(2003):
            with open(os.path.join(many, f"{n:05d}.png"), "wb"):
                pass
        photos = self.listing()["photos"]
        self.assertEqual(len(photos), 2000)
        self.assertEqual(photos[-1], item("/bgphoto/many/01994.png", "many"))   # 5 top-level first

    def test_symlinks_out_of_the_data_dir_are_not_listed(self):
        outside = os.path.join(self.root, "outside")
        os.makedirs(os.path.join(outside, "outdir"))
        os.makedirs(os.path.join(outside, "photos"))
        for rel in ("clip.mp4", "outdir/x.mp4", "photos/a.jpg"):
            with open(os.path.join(outside, *rel.split("/")), "wb"):
                pass
        song = self.put("videos/song.mp4")
        self.put("pics/p.jpg")
        self.put("bgv/real.mp4")
        self.put("bgv/party/ok.mp4")
        self.symlink(os.path.join(outside, "clip.mp4"), "bgv/out.mp4")
        self.symlink(os.path.join(outside, "outdir"), "bgv/outdir")
        self.symlink(os.path.join(outside, "clip.mp4"), "bgv/party/out2.mp4")
        self.symlink(song, "bgv/in.mp4")                                  # stays in the data dir
        self.symlink(os.path.join(self.data, "missing.mp4"), "bgv/dangling.mp4")
        self.symlink(os.path.join(outside, "photos"), "bgphoto")         # the whole kind folder
        got = self.listing()
        self.assertEqual(got["videos"], [item("/bgv/in.mp4"), item("/bgv/real.mp4"),
                                         item("/bgv/party/ok.mp4", "party")])
        self.assertEqual(got["photos"], [])
        # A kind folder that is a symlink to elsewhere INSIDE the data dir is fine.
        os.remove(os.path.join(self.data, "bgphoto"))
        self.symlink(os.path.join(self.data, "pics"), "bgphoto")
        self.assertEqual(self.listing()["photos"], [item("/bgphoto/p.jpg")])


# ---------------------------------------------------------------------------------------
# Pure: the data routes
# ---------------------------------------------------------------------------------------
class TestDataRoutes(BackgroundsCase):
    def test_data_routes_include_the_two_prefixes(self):
        for prefix in ("/bgv/", "/bgphoto/", "/kar_raw/", "/videos/", "/audio_lyrics/"):
            self.assertIn(prefix, serve.DATA_URL_PREFIXES)
        h = self.handler()
        self.assertEqual(h.translate_path("/bgv/party/a.mp4"),
                         os.path.join(self.data, "bgv", "party", "a.mp4"))
        self.assertEqual(h.translate_path("/bgphoto/x.jpg?v=1#frag"),
                         os.path.join(self.data, "bgphoto", "x.jpg"))
        # Only the exact prefixes: look-alikes stay in the app tree.
        for url in ("/bgv", "/bgvx/a.mp4", "/bgphotos/a.jpg"):
            self.assertTrue(inside(h.translate_path(url), self.app), url)
        # `..` (raw or encoded) under a background prefix cannot climb out of the data dir.
        for url in ("/bgv/../../secret.txt", "/bgv/%2e%2e/%2e%2e/secret.txt",
                    "/bgv/..%2f..%2fsecret.txt", "/bgphoto/../../../etc/passwd",
                    "/bgphoto/party/../../../../app/index.html"):
            self.assertTrue(inside(h.translate_path(url), self.data), url)
        # The photo types do not depend on the host's mime.types or the Python version's
        # table (a new Python knows .webp on its own, so pin the handler's entries).
        for ext, ctype in ((".jpg", "image/jpeg"), (".jpeg", "image/jpeg"), (".png", "image/png"),
                           (".webp", "image/webp")):
            self.assertEqual(serve.Handler.extensions_map.get(ext), ctype, ext)
        self.assertEqual(h.guess_type("a.webp"), "image/webp")
        self.assertEqual(h.guess_type("a.JPG"), "image/jpeg")
        self.assertEqual(h.guess_type("a.png"), "image/png")
        self.assertEqual(h.guess_type("a.m4v"), "video/mp4")


# ---------------------------------------------------------------------------------------
# Over HTTP: a real server on an ephemeral loopback port
# ---------------------------------------------------------------------------------------
class LoopbackCase(BackgroundsCase):
    @classmethod
    def setUpClass(cls):
        cls._static = tempfile.TemporaryDirectory()   # static root: nothing real is reachable
        handler = functools.partial(serve.Handler, directory=cls._static.name)
        cls.httpd = serve.ThreadingServer(("127.0.0.1", 0), handler)
        cls.port = cls.httpd.server_address[1]
        cls._serving = threading.Thread(target=cls.httpd.serve_forever,
                                        kwargs={"poll_interval": 0.05}, daemon=True)
        cls._serving.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls._static.cleanup()

    def setUp(self):
        super().setUp()
        # Non-200s (the 206 and the 404s) are logged to stderr by the existing policy.
        cm = contextlib.redirect_stderr(io.StringIO())
        cm.__enter__()
        self.addCleanup(cm.__exit__, None, None, None)
        self.conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        self.addCleanup(self.conn.close)

    def get(self, path, headers=None):
        """One GET on the test's single keep-alive connection."""
        self.conn.request("GET", path, headers=headers or {})
        r = self.conn.getresponse()
        body = r.read()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, body


class TestBackgroundsHttp(LoopbackCase):
    def test_endpoint_answers_over_loopback(self):
        self.put("bgv/party/loop1.mp4", b"0123456789")
        self.put("bgv/loop2.mp4", b"x")
        self.put("bgphoto/beach/a.jpg", b"\xff\xd8jpeg")
        status, headers, body = self.get("/api/backgrounds")
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "application/json")
        self.assertEqual(int(headers["content-length"]), len(body))
        self.assertEqual(headers["cache-control"], "no-cache")
        self.assertEqual(json.loads(body), {
            "ok": True,
            "videos": [item("/bgv/loop2.mp4"), item("/bgv/party/loop1.mp4", "party")],
            "photos": [item("/bgphoto/beach/a.jpg", "beach")],
            "categories": {"videos": ["party"], "photos": ["beach"]},
        })
        # Rescanned on every call (same socket, so the first reply's length was exact).
        self.put("bgphoto/new.png", b"png")
        status, _, body = self.get("/api/backgrounds?t=2")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["photos"][0], item("/bgphoto/new.png"))
        # The listed URLs are served: a clip seeks with Range/206, a photo is a plain 200.
        status, headers, body = self.get("/bgv/party/loop1.mp4", {"Range": "bytes=2-5"})
        self.assertEqual((status, body), (206, b"2345"))
        self.assertEqual(headers["content-range"], "bytes 2-5/10")
        self.assertEqual(headers["content-type"], "video/mp4")
        status, headers, body = self.get("/bgphoto/beach/a.jpg")
        self.assertEqual((status, body, headers["content-type"]), (200, b"\xff\xd8jpeg", "image/jpeg"))

    def test_an_empty_data_dir_still_answers_ok(self):
        status, _, body = self.get("/api/backgrounds")
        self.assertEqual((status, json.loads(body)), (200, {"ok": True, **EMPTY}))

    def test_dot_dot_under_bgv_is_refused(self):
        secret = b"top secret, outside the data dir"
        with open(os.path.join(self.root, "secret.txt"), "wb") as fh:
            fh.write(secret)
        self.put("bgv/clip.mp4", b"clip")
        for url in ("/bgv/../secret.txt", "/bgv/../../secret.txt", "/bgv/%2e%2e/secret.txt",
                    "/bgv/..%2fsecret.txt", "/bgphoto/x/../../secret.txt"):
            for headers in (None, {"Range": "bytes=0-3"}):        # the static and the 206 path
                status, _, body = self.get(url, headers)
                self.assertEqual(status, 404, (url, headers))
                self.assertNotIn(secret, body, (url, headers))
        # Every refusal carried a length: the same keep-alive socket still answers.
        status, _, body = self.get("/bgv/clip.mp4")
        self.assertEqual((status, body), (200, b"clip"))


if __name__ == "__main__":
    unittest.main()
