#!/usr/bin/env python3
"""
test_serve_kiosk.py — the kiosk Exit in serve.py (Rae, 2026-11-25): GET /api/kiosk says whether
this page may show the Exit button, POST /api/quit stops the server — only with --kiosk, and only
for a page on the kiosk machine itself. Plus the port every way of running the app agrees on.

Run with:  python3 -m unittest discover -s test -p 'test_*.py' -t test   (or `npm test`)

  * PURE: _is_loopback_addr, _host_header_name and _is_local_request — the three conditions a
    quit needs (loopback peer, loopback Host, no proxy forwarding header).

  * A real http.server on an ephemeral 127.0.0.1 port (loopback only, like
    test_serve_playcounts.py): kiosk off → no button and a 404; kiosk on → the button, a 403
    for a foreign Host / a forwarded request / a cross-site page, and a quit that really ends
    serve_forever.
"""

import functools
import http.client
import json
import os
import sys
import tempfile
import threading
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import serve  # noqa: E402


class TestLocalRequest(unittest.TestCase):
    def test_loopback_addresses(self):
        for a in ("127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"):
            self.assertTrue(serve._is_loopback_addr(a), a)
        for a in ("10.42.0.5", "192.168.1.20", "::ffff:10.0.0.1", "0.0.0.0", "", None, "localhost", "nonsense"):
            self.assertFalse(serve._is_loopback_addr(a), a)

    def test_host_header_name(self):
        self.assertEqual(serve._host_header_name("localhost:52723"), "localhost")
        self.assertEqual(serve._host_header_name("LOCALHOST"), "localhost")
        self.assertEqual(serve._host_header_name("127.0.0.1:52723"), "127.0.0.1")
        self.assertEqual(serve._host_header_name("[::1]:52723"), "::1")
        self.assertEqual(serve._host_header_name("[::1]"), "::1")
        self.assertEqual(serve._host_header_name("abc.trycloudflare.com"), "abc.trycloudflare.com")
        self.assertEqual(serve._host_header_name(None), "")

    def test_all_three_conditions(self):
        ok = {"Host": "localhost:52723"}
        self.assertTrue(serve._is_local_request("127.0.0.1", ok))
        self.assertTrue(serve._is_local_request("127.0.0.1", {"Host": "127.0.0.1:52723"}))
        self.assertTrue(serve._is_local_request("::1", {"Host": "[::1]:52723"}))
        # a guest on the hotspot, even naming localhost
        self.assertFalse(serve._is_local_request("10.42.0.5", ok))
        # a tunnel: loopback peer, public Host
        self.assertFalse(serve._is_local_request("127.0.0.1", {"Host": "abc.trycloudflare.com"}))
        # a tunnel that rewrites Host to localhost still says who it forwards for
        for h in serve.FORWARDING_HEADERS:
            self.assertFalse(serve._is_local_request("127.0.0.1", {**ok, h: "203.0.113.9"}), h)
        # the LAN address of this machine is not loopback (a TV box would use it)
        self.assertFalse(serve._is_local_request("127.0.0.1", {"Host": "192.168.1.20:52723"}))
        self.assertFalse(serve._is_local_request("127.0.0.1", {}))


class KioskServer:
    """One serve.Handler server on an ephemeral loopback port, in its own thread."""

    def __init__(self, kiosk):
        self._root = tempfile.TemporaryDirectory()   # static root: nothing real is reachable
        handler = functools.partial(serve.Handler, directory=self._root.name)
        self.httpd = serve.ThreadingServer(("127.0.0.1", 0), handler)
        self.httpd.kiosk = kiosk
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever,
                                       kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    def call(self, method, path, headers=None, body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            c.request(method, path, body=body, headers=headers or {})
            r = c.getresponse()
            raw = r.read()
            return r.status, (json.loads(raw) if r.getheader("Content-Type") == "application/json" else raw)
        finally:
            c.close()

    def close(self):
        if self.thread.is_alive():
            self.httpd.shutdown()
        self.httpd.server_close()
        self._root.cleanup()


class TestKioskHttp(unittest.TestCase):
    def server(self, kiosk):
        s = KioskServer(kiosk)
        self.addCleanup(s.close)
        return s

    def post_quit(self, s, **headers):
        return s.call("POST", "/api/quit", headers={"Content-Type": "application/json", **headers}, body=b"{}")

    def test_without_kiosk_there_is_no_button_and_no_quit(self):
        s = self.server(kiosk=False)
        self.assertEqual(s.call("GET", "/api/kiosk"), (200, {"ok": True, "kiosk": False, "canQuit": False}))
        status, _ = self.post_quit(s)
        self.assertEqual(status, 404)
        self.assertTrue(s.thread.is_alive(), "a server without --kiosk never stops on a POST")

    def test_kiosk_offers_the_button_to_its_own_screen_only(self):
        s = self.server(kiosk=True)
        self.assertEqual(s.call("GET", "/api/kiosk"), (200, {"ok": True, "kiosk": True, "canQuit": True}))
        self.assertEqual(s.call("GET", "/api/kiosk", headers={"Host": f"localhost:{s.port}"})[1]["canQuit"], True)
        self.assertEqual(s.call("GET", "/api/kiosk", headers={"Host": "abc.trycloudflare.com"})[1]["canQuit"], False)
        self.assertEqual(s.call("GET", "/api/kiosk", headers={"X-Forwarded-For": "10.42.0.5"})[1]["canQuit"], False)

    def test_quit_refused_unless_local_and_same_origin(self):
        s = self.server(kiosk=True)
        refused = [
            ({"Host": "abc.trycloudflare.com"}, 403),                          # through a tunnel
            ({"Cf-Connecting-IP": "203.0.113.9"}, 403),                        # cloudflared, Host rewritten
            ({"X-Forwarded-For": "10.42.0.5"}, 403),
            ({"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"}, 403),   # a page on another site
        ]
        for headers, code in refused:
            status, body = self.post_quit(s, **headers)
            self.assertEqual(status, code, headers)
            self.assertFalse(body["ok"], headers)
        self.assertTrue(s.thread.is_alive(), "a refused quit leaves the server running")
        self.assertEqual(s.call("GET", "/api/kiosk")[0], 200)

    def test_quit_from_the_kiosk_page_stops_the_server(self):
        s = self.server(kiosk=True)
        origin = f"http://localhost:{s.port}"
        status, body = self.post_quit(s, Host=f"localhost:{s.port}", Origin=origin, **{"Sec-Fetch-Site": "same-origin"})
        self.assertEqual((status, body), (200, {"ok": True}))
        s.thread.join(timeout=5)
        self.assertFalse(s.thread.is_alive(), "serve_forever returned: main() would now flush and exit")


class TestOnePort(unittest.TestCase):
    """serve.py, docker-compose.yml and the Dockerfile must name the same port (Rae, 2026-11-25)."""

    def read(self, name):
        with open(os.path.join(ROOT, name), encoding="utf-8") as f:
            return f.read()

    def test_default_port(self):
        self.assertEqual(serve.DEFAULT_PORT, 52723)

    def test_docker_publishes_the_same_port(self):
        p = serve.DEFAULT_PORT
        self.assertIn(f'"{p}:{p}"', self.read("docker-compose.yml"))
        self.assertIn(f"EXPOSE {p}", self.read("Dockerfile"))

    def test_lan_launcher_prints_the_same_port(self):
        self.assertIn(f"PORT={serve.DEFAULT_PORT}", self.read("tools/serve-lan.sh"))


if __name__ == "__main__":
    unittest.main()
