#!/usr/bin/env python3
"""permissions.py: a live page of Claude Code's permission prompts and modes.

Claude Code hooks (installed by install_hooks.py, run as hooks/forward.sh) post
each hook's JSON input here. This server keeps those raw events in memory and
streams them to permissions.html, which works out the permission mode, which
tool calls asked for permission, and whether each was allowed or denied
(SPEC D17). Standard library only; nothing goes to disk.

    python3 permissions.py                 # http://localhost:8043
    python3 install_hooks.py               # once: adds the hooks to ~/.claude/settings.json

It runs next to proxy.py but is independent of it: the proxy is not changed,
and either one works without the other.
"""

from __future__ import annotations

import argparse
import base64
import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

PAGE = Path(__file__).resolve().with_name("permissions.html")
HOSTS = {"localhost", "127.0.0.1"}
# The page handles data it did not write, so it may load nothing and may only
# talk back to this server.
CSP = (
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
    "connect-src 'self'; base-uri 'none'; form-action 'none'"
)
MAX_BYTES = 16 * 1024 * 1024  # a PostToolUse payload carries the tool's whole output
SSE_PING_SECONDS = 15


class HookLog:
    """Every hook event since startup, raw, in memory. Same rules as proxy.py's
    EventLog: appending is quick and never waits for a browser."""

    def __init__(self) -> None:
        self.boot = uuid.uuid4().hex  # lets a reconnecting page notice a restart
        self.events: list[dict] = []
        self.changed = threading.Condition()

    def add(self, body: bytes) -> None:
        with self.changed:
            self.events.append({"seq": len(self.events), "kind": "hook", "ts": time.time(), "body": body})
            self.changed.notify_all()

    def wait_after(self, start: int, timeout: float) -> list[dict]:
        with self.changed:
            if len(self.events) <= start:
                self.changed.wait(timeout)
            return self.events[start:]


LOG = HookLog()


def sse_message(event: dict) -> bytes:
    """One raw event as an SSE message; the body travels as base64, as in proxy.py."""
    wire = dict(event, body=base64.b64encode(event["body"]).decode("ascii"))
    return f"id: {LOG.boot}:{event['seq']}\ndata: {json.dumps(wire)}\n\n".encode()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass

    def allowed_host(self) -> bool:
        # Reject other Host names so a web page cannot use DNS rebinding.
        return urlsplit(f"//{self.headers.get('host', '')}").hostname in HOSTS

    def do_GET(self) -> None:
        if not self.allowed_host():
            self.send_plain(403, "forbidden host")
        elif self.path == "/":
            self.send_page()
        elif self.path == "/events":
            self.stream_events()
        else:
            self.send_plain(404, "not found")

    def do_POST(self) -> None:
        """POST /hooks: one hook's JSON input, stored raw.

        Only local tools may post. A browser always sends Origin on a cross-site
        POST, and cannot send application/json cross-site without a preflight
        this server never approves, so a web page cannot plant fake events."""
        self.close_connection = True  # a rejected body stays unread; never reuse the line
        if not self.allowed_host() or self.headers.get("origin"):
            self.send_plain(403, "forbidden")
        elif self.path != "/hooks":
            self.send_plain(404, "not found")
        elif self.headers.get_content_type() != "application/json":
            self.send_plain(415, "expected application/json")
        else:
            length = self.headers.get("content-length") or ""
            if not length.isdigit():
                self.send_plain(411, "content-length required")
            elif int(length) > MAX_BYTES:
                self.send_plain(413, "too large")
            else:
                LOG.add(self.rfile.read(int(length)))
                self.respond(204, "text/plain; charset=utf-8", b"")

    def send_plain(self, status: int, text: str) -> None:
        self.respond(status, "text/plain; charset=utf-8", text.encode())

    def send_page(self) -> None:
        try:
            page = PAGE.read_bytes()
        except OSError as e:
            self.send_plain(500, f"cannot read {PAGE.name}: {e}")
            return
        self.respond(200, "text/html; charset=utf-8", page)

    def respond(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def resume_point(self) -> int:
        """Where to continue after an EventSource reconnect; 0 for a fresh page or a restart."""
        boot, _, seq = (self.headers.get("last-event-id") or "").partition(":")
        return int(seq) + 1 if boot == LOG.boot and seq.isdigit() else 0

    def stream_events(self) -> None:
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(f"event: hello\ndata: {json.dumps({'boot': LOG.boot})}\n\n".encode())
        position = self.resume_point()
        synced = False
        while True:
            events = LOG.wait_after(position, 0 if not synced else SSE_PING_SECONDS)
            for event in events:
                self.wfile.write(sse_message(event))
            position += len(events)
            if not events:
                # Nothing left to replay: tell the page once, then keep the line alive.
                self.wfile.write(b"event: synced\ndata: {}\n\n" if not synced else b": ping\n\n")
                synced = True


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request: object, client_address: object) -> None:
        pass  # a closed tab is normal


def main() -> None:
    parser = argparse.ArgumentParser(description="Show Claude Code's permission prompts and modes, from hooks.")
    parser.add_argument("--port", type=int, default=8043,
                        help="where the page and /hooks are served (default 8043: the dashboard's port + 1)")
    args = parser.parse_args()
    server = Server(("127.0.0.1", args.port), Handler)
    print(f"  permissions  http://localhost:{args.port}", flush=True)
    print(f"  hooks post   http://localhost:{args.port}/hooks  (python3 install_hooks.py)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
