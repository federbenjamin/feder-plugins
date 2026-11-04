import http.client
import json
import os
import pathlib
import re
import shutil
import tempfile
import threading
import time
import unittest

import file_server

# Calls hooks/links.ts itself, so the server is tested against the file and the links the plugin writes.
from hooks_ts import call, node

T = "0123456789abcdef0123456789abcdef"
LATER = 4102444800000  # 2100
BASE = "https://host.example:1"
SHARE_URL = "import(process.argv[1]).then(m => process.stdout.write(JSON.stringify(m.shareUrl(...JSON.parse(process.argv[2])))))"


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.shares = self.tmp / "state" / "session-summary" / "shares.json"
        self.shares.parent.mkdir(parents=True)
        self.log = self.tmp / "state" / "logs" / "session-summary-links.log"
        self.server = file_server.make_server(0, str(self.shares), str(self.log))
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.docs = self.tmp / "docs"
        self.docs.mkdir()

    def file(self, name, data=b"hello"):
        path = self.docs / name
        path.write_bytes(data)
        return str(path)

    def share(self, *entries):
        self.shares.write_text(call("links", "sharesText", list(entries)))

    def request(self, path, method="GET"):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=10)
        self.addCleanup(conn.close)
        conn.putrequest(method, path, skip_accept_encoding=True)
        conn.endheaders()
        r = conn.getresponse()
        return r.status, dict(r.getheaders()), r.read()

    def assert_plain_404(self, path, method="GET"):
        status, headers, body = self.request(path, method)
        self.assertEqual((status, body), (404, b""), path)
        self.assertEqual({k.lower() for k in headers}, {"date", "content-length", "cache-control"})
        return headers

    def access_lines(self):
        for _ in range(100):
            if self.log.exists():
                break
            time.sleep(0.01)
        return self.log.read_text().splitlines()

    def test_it_binds_loopback_only(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")

    def test_a_live_link_serves_the_file_as_the_plugin_builds_it(self):
        path = self.file("a b#1.txt", b"\x00\xffbinary\n")
        self.share({"token": T, "path": path, "expiresAt": LATER})
        url = node("links", SHARE_URL, json.dumps([BASE, T, path]))
        status, headers, body = self.request(url[len(BASE):])
        self.assertEqual((status, body), (200, b"\x00\xffbinary\n"))
        self.assertEqual(headers["Content-Type"], "text/plain; charset=utf-8")
        self.assertEqual(headers["Content-Length"], "9")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(headers["Referrer-Policy"], "no-referrer")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertNotIn("Server", headers)

    def test_markdown_displays_as_text_and_a_page_runs_sandboxed(self):
        md, html, pdf = self.file("a.md"), self.file("b.html"), self.file("c.pdf")
        self.share({"token": T, "path": md, "expiresAt": LATER}, {"token": T[::-1], "path": html, "expiresAt": LATER}, {"token": "f" * 32, "path": pdf, "expiresAt": LATER})
        self.assertEqual(self.request(f"/{T}/a.md")[1]["Content-Type"], "text/plain; charset=utf-8")
        page = self.request(f"/{T[::-1]}/b.html")[1]
        self.assertEqual(page["Content-Type"], "text/html; charset=utf-8")
        self.assertEqual(page["Content-Security-Policy"], "sandbox allow-scripts")
        doc = self.request(f"/{'f' * 32}/c.pdf")[1]
        self.assertEqual(doc["Content-Type"], "application/pdf")
        self.assertNotIn("Content-Security-Policy", doc)

    def test_a_large_file_comes_through_whole(self):
        data = os.urandom(1024) * 1024
        self.share({"token": T, "path": self.file("big.png", data), "expiresAt": LATER})
        self.assertEqual(self.request(f"/{T}/big.png")[2], data)

    def test_head_sends_the_headers_only(self):
        self.share({"token": T, "path": self.file("a.txt"), "expiresAt": LATER})
        status, headers, body = self.request(f"/{T}/a.txt", "HEAD")
        self.assertEqual((status, headers["Content-Length"], body), (200, "5", b""))

    def test_the_file_is_read_per_request(self):
        self.assert_plain_404(f"/{T}/a.txt")
        self.share({"token": T, "path": self.file("a.txt"), "expiresAt": LATER})
        self.assertEqual(self.request(f"/{T}/a.txt")[0], 200)
        self.share()
        self.assert_plain_404(f"/{T}/a.txt")

    def test_an_unknown_token_is_a_plain_404(self):
        self.share({"token": T, "path": self.file("a.txt"), "expiresAt": LATER})
        self.assert_plain_404(f"/{'e' * 32}/a.txt")

    def test_an_expired_token_is_a_plain_404(self):
        self.share({"token": T, "path": self.file("a.txt"), "expiresAt": int(time.time() * 1000) - 1})
        self.assert_plain_404(f"/{T}/a.txt")

    def test_a_secret_path_is_a_plain_404_even_when_the_file_lists_it(self):
        for name in (".env", ".env.local", "server.pem", "a.key", "id_rsa", "id_ed25519", "my-credentials.txt", "secret.txt"):
            with self.subTest(name=name):
                self.share({"token": T, "path": self.file(name), "expiresAt": LATER})
                self.assert_plain_404(f"/{T}/{name}")

    def test_a_link_to_a_secret_is_a_plain_404(self):
        target = self.file(".env")
        link = self.docs / "plan.md"
        link.symlink_to(target)
        self.share({"token": T, "path": str(link), "expiresAt": LATER})
        self.assert_plain_404(f"/{T}/plan.md")

    def test_a_traversal_attempt_is_a_plain_404(self):
        secret = self.file("other.txt")
        self.share({"token": T, "path": self.file("a.txt"), "expiresAt": LATER})
        name = os.path.basename(secret)
        for path in (f"/{T}/../{name}", f"/{T}/%2e%2e%2f{name}", f"/{T}/..%2F{name}", f"/{T}/{name}", f"/{T}/a.txt/../{name}", f"/{T}//a.txt", f"/../../{name}", f"/{T}/%2Fetc%2Fpasswd"):
            with self.subTest(path=path):
                self.assert_plain_404(path)

    def test_there_is_no_listing_and_nothing_else_answers(self):
        self.share({"token": T, "path": self.file("a.txt"), "expiresAt": LATER})
        for path in ("/", f"/{T}", f"/{T}/", "/favicon.ico", f"/{T}/a.txt/x"):
            with self.subTest(path=path):
                self.assert_plain_404(path)

    def test_a_file_gone_a_folder_and_a_relative_path_are_plain_404s(self):
        gone = self.file("gone.txt")
        os.remove(gone)
        for path, name in ((gone, "gone.txt"), (str(self.docs), "docs"), ("a.txt", "a.txt")):
            with self.subTest(path=path):
                self.share({"token": T, "path": path, "expiresAt": LATER})
                self.assert_plain_404(f"/{T}/{name}")

    def test_another_method_is_a_plain_404(self):
        self.share({"token": T, "path": self.file("a.txt"), "expiresAt": LATER})
        for method in ("POST", "PUT", "DELETE", "OPTIONS"):
            with self.subTest(method=method):
                self.assert_plain_404(f"/{T}/a.txt", method)

    def test_a_malformed_shares_file_serves_nothing(self):
        for text in ("not json", "{}", '[{"token": 7}, 3]'):
            with self.subTest(text=text):
                self.shares.write_text(text)
                self.assert_plain_404(f"/{T}/a.txt")

    def test_each_request_logs_a_firing_line_with_the_status_and_token_prefix_never_the_path(self):
        self.share({"token": T, "path": self.file("private-name.txt"), "expiresAt": LATER})
        self.request(f"/{T}/private-name.txt")
        self.request(f"/{'e' * 32}/private-name.txt")
        self.request("/private-name.txt")
        lines = self.access_lines()
        self.assertEqual(len(lines), 3)
        parsed = [call("shared/firing", "parseFiringLine", f"{line}\n") for line in lines]
        self.assertEqual([(p["outcome"], p["reason"]) for p in parsed], [("200", f"token={T[:8]}"), ("404", f"token={'e' * 8}"), ("404", "token=-")])
        self.assertTrue(all(re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", p["at"]) for p in parsed))
        self.assertNotIn("private-name", self.log.read_text())
        self.assertNotIn(T, self.log.read_text())


class ContractTest(unittest.TestCase):
    def test_the_secret_filter_matches_the_plugins(self):
        paths = [
            "/r/.env", "/r/.env.local", "/r/.ENV", "/r/x.pem", "/r/x.KEY", "/h/.ssh/id_rsa", "/h/.ssh/id_rsa.pub", "/h/.ssh/id_ed25519", "/h/.ssh/id_ecdsa", "/h/.ssh/id_dsa",
            "/h/.aws/credentials", "/r/my-Credentials.md", "/r/secret.md", "/r/Secrets/plan.md", "/r/.env.d/plan.md",
            "/r/plan.md", "/r/environment.md", "/r/keys.md", "/r/a.key.md", "/r/monkey.txt", "/r/id_card.png", "/r/pem.txt", "/r/a.pem.md", "",
        ]
        for path in paths:
            with self.subTest(path=path):
                self.assertEqual(file_server.is_secret(path), call("links", "isSecretPath", path))

    def test_a_token_the_plugin_makes_has_the_shape_the_server_takes(self):
        self.assertRegex(call("links", "newToken", None), file_server.TOKEN_SHAPE)

    def test_the_plist_runs_this_script_with_the_flags_it_parses(self):
        plist = call("links", "renderLinksPlist", {"python": "/usr/bin/python3", "dir": "/s", "home": "/h", "uid": "501"})
        self.assertIn(f"<string>/s/session-summary/{pathlib.Path(file_server.__file__).name}</string>", plist)
        for flag in ("--port", "--shares", "--log"):
            self.assertIn(f"<string>{flag}</string>", plist)

    def test_the_access_log_is_where_the_plugin_names_it(self):
        paths = call("links", "linksPaths", "/s")
        self.assertEqual(json.dumps(paths["accessLog"]), '"/s/logs/session-summary-links.log"')


if __name__ == "__main__":
    unittest.main()
