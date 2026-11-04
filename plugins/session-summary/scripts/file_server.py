#!/usr/bin/env python3
"""The read-only file server behind /session-summary links, bound to 127.0.0.1; tailscale serve proxies the tailnet to it.

Serves /<token>/<basename> for a live entry of the shares file, which it re-reads per request. hooks/links.ts writes that
file; test_file_server.py runs the two against each other. Everything else is the same empty 404.
"""
import argparse
import hmac
import http.server
import json
import mimetypes
import os
import re
import shutil
import time
from urllib.parse import unquote, urlsplit

# Kept in step with SECRET_SEGMENT in hooks/links.ts; the test compares the two.
SECRET_SEGMENT = re.compile(r"^\.env|\.pem$|\.key$|^id_(rsa|ed25519|ecdsa|dsa)|credentials|secret", re.IGNORECASE)
TOKEN_SHAPE = re.compile(r"^[0-9a-f]{32}$")
TOKEN_PREFIX_CHARS = 8
SOCKET_TIMEOUT_S = 30
CHUNK_BYTES = 64 * 1024


def is_secret(path):
    return any(SECRET_SEGMENT.search(segment) for segment in path.split("/"))


def read_shares(path):
    try:
        with open(path, encoding="utf-8") as f:
            shares = json.load(f)
    except (OSError, ValueError):
        return []
    return shares if isinstance(shares, list) else []


def is_entry(share):
    return (
        isinstance(share, dict)
        and isinstance(share.get("token"), str)
        and isinstance(share.get("path"), str)
        and isinstance(share.get("expiresAt"), (int, float))
    )


def resolve(shares, token, name, now_ms):
    """The file /<token>/<name> serves, or None. The name is only compared, never joined to a path, so it cannot climb
    out; a link whose target looks secret is refused like a secret path."""
    for share in shares:
        if not is_entry(share) or not hmac.compare_digest(share["token"].encode(), token.encode()):
            continue
        path = share["path"]
        if share["expiresAt"] <= now_ms or not os.path.isabs(path) or os.path.basename(path) != name:
            return None
        real = os.path.realpath(path)
        return real if not is_secret(path) and not is_secret(real) and os.path.isfile(real) else None
    return None


def content_type(name):
    if name.lower().endswith(".md"):
        return "text/plain; charset=utf-8"
    guessed = mimetypes.guess_type(name)[0] or "application/octet-stream"
    return f"{guessed}; charset=utf-8" if guessed.startswith("text/") else guessed


def access_line(status, token, ms):
    """shared/firing.ts's line shape. Identifiers only: never the path, never more of a token than its prefix."""
    at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return f"{at} {status} session= ms={ms} reason=token={token[:TOKEN_PREFIX_CHARS] if token else '-'}\n"


def handler_for(shares_path, log_path):
    class Handler(http.server.BaseHTTPRequestHandler):
        timeout = SOCKET_TIMEOUT_S

        def setup(self):
            super().setup()
            self.started = time.monotonic()
            self.token = ""

        def log_message(self, *args):
            pass

        # No Server header: a 404 says nothing about what answered.
        def send_response(self, code, message=None):
            self.send_response_only(code, message)
            self.send_header("Date", self.date_time_string())

        def record(self, status):
            ms = int((time.monotonic() - self.started) * 1000)
            try:
                with open(log_path, "a", encoding="utf-8") as f:
                    f.write(access_line(status, self.token, ms))
            except OSError:
                pass

        def not_found(self):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.record(404)
            self.end_headers()
            self.close_connection = True

        # A malformed request or another method gets the same answer as an unknown token.
        def send_error(self, code, message=None, explain=None):
            self.not_found()

        def serve(self, with_body):
            parts = urlsplit(self.path).path.split("/")
            if len(parts) != 3 or parts[0] != "" or not TOKEN_SHAPE.match(parts[1]):
                return self.not_found()
            self.token = parts[1]
            name = unquote(parts[2])
            real = resolve(read_shares(shares_path), self.token, name, time.time() * 1000)
            if real is None:
                return self.not_found()
            try:
                f = open(real, "rb")
            except OSError:
                return self.not_found()
            with f:
                kind = content_type(name)
                self.send_response(200)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(os.fstat(f.fileno()).st_size))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Referrer-Policy", "no-referrer")
                self.send_header("X-Content-Type-Options", "nosniff")
                # A served page runs apart from this origin, so it cannot reach another file's link.
                if "html" in kind or "svg" in kind:
                    self.send_header("Content-Security-Policy", "sandbox allow-scripts")
                self.record(200)
                self.end_headers()
                if with_body:
                    try:
                        shutil.copyfileobj(f, self.wfile, CHUNK_BYTES)
                    except OSError:
                        self.close_connection = True

        def do_GET(self):
            self.serve(True)

        def do_HEAD(self):
            self.serve(False)

    return Handler


def make_server(port, shares_path, log_path):
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    return http.server.ThreadingHTTPServer(("127.0.0.1", port), handler_for(shares_path, log_path))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--shares", required=True)
    parser.add_argument("--log", required=True)
    args = parser.parse_args()
    make_server(args.port, args.shares, args.log).serve_forever()


if __name__ == "__main__":
    main()
