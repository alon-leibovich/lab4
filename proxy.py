#!/usr/bin/env python3
"""proxy.py: the naive agent-traffic proxy for Lab 4.

A reverse proxy that prints every request and response and forwards them
unchanged. Standard library only; nothing to install.

    python3 proxy.py                       # listens on http://localhost:8041
    ANTHROPIC_BASE_URL=http://localhost:8041 claude

Everything Claude Code sends to the API now passes through this program and is
printed to the terminal. The proxy changes nothing: headers go through untouched
(a subscription login needs its bearer token and its `anthropic-beta` header),
and the reply is streamed back byte for byte as it arrives.

While it runs, http://localhost:8042 shows the same traffic as a live dashboard.
The proxy only records raw events and streams them to the page (dashboard.html),
which does all the parsing and rendering in the browser. Nothing goes to disk.

    python3 proxy.py --port 9000 --dashboard-port 9001
    python3 proxy.py --upstream https://chatgpt.com/backend-api/codex   # for Codex
"""

from __future__ import annotations

import argparse
import base64
import http.client
import itertools
import json
import re
import sys
import threading
import time
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

# Headers that describe one hop of the connection, not the message. They are
# never forwarded. `accept-encoding` is dropped too, so the API answers in plain
# text and what we print is readable.
SKIP = {
    "host", "connection", "keep-alive", "transfer-encoding", "te", "trailers",
    "upgrade", "proxy-authorization", "proxy-authenticate", "accept-encoding",
    "content-length",
}

UPSTREAM = "https://api.anthropic.com"

DASHBOARD_PAGE = Path(__file__).resolve().with_name("dashboard.html")
DASHBOARD_HOSTS = {"localhost", "127.0.0.1"}
# The page handles traffic it did not write, so it may load nothing and may only
# talk back to this server.
DASHBOARD_CSP = (
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
    "connect-src 'self'; base-uri 'none'; form-action 'none'"
)
SECRET_HEADER = re.compile(r"auth|api[-_]?key|token|secret|cookie|session|password", re.I)
BYTES_FIELDS = ("body", "data")
SSE_PING_SECONDS = 15


def stamp() -> str:
    return datetime.now().strftime("%H:%M:%S")


class EventLog:
    """Every exchange since startup, as raw events, in memory.

    Adding is a list append under a short lock, and readers never write to a
    socket while holding that lock, so a slow browser cannot delay forwarding.
    """

    def __init__(self) -> None:
        self.boot = uuid.uuid4().hex  # lets a reconnecting page notice a restart
        self.events: list[dict] = []
        self.changed = threading.Condition()
        self.exchange_ids = itertools.count(1)

    def add(self, kind: str, exchange: int, **fields: object) -> None:
        """Record one event. Never raises: observing must not break forwarding."""
        try:
            if "headers" in fields:
                fields["headers"] = [
                    [k, "[redacted]" if SECRET_HEADER.search(k) else v] for k, v in fields["headers"]
                ]
            with self.changed:
                self.events.append({
                    "seq": len(self.events), "kind": kind, "exchange": exchange, "ts": time.time(), **fields,
                })
                self.changed.notify_all()
        except Exception:
            pass

    def wait_after(self, start: int, timeout: float) -> list[dict]:
        """Events from index `start` on, waiting up to `timeout` if there are none."""
        with self.changed:
            if len(self.events) <= start:
                self.changed.wait(timeout)
            return self.events[start:]


LOG = EventLog()


class Tap(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass  # we print our own lines

    def do_POST(self) -> None:
        self.relay()

    def do_GET(self) -> None:
        self.relay()

    def do_HEAD(self) -> None:
        self.relay()

    def relay(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else b""
        exchange = next(LOG.exchange_ids)
        LOG.add("request", exchange, method=self.command, path=self.path, headers=self.headers.items(), body=body)
        try:
            self.forward(exchange, body)
        except Exception as e:
            LOG.add("end", exchange, error=f"{type(e).__name__}: {e}")
            raise
        LOG.add("end", exchange)

    def forward(self, exchange: int, body: bytes) -> None:
        # 1. Print what the agent sent.
        print(f"\n{'=' * 78}\n[{stamp()}] >>> {self.command} {self.path}", flush=True)
        for name, value in self.headers.items():
            if name.lower() in ("authorization", "x-api-key"):
                value = value[:16] + "..."
            print(f"    {name}: {value}")
        if body:
            try:
                print(json.dumps(json.loads(body), indent=2, ensure_ascii=False))
            except ValueError:
                print(body.decode("utf-8", "replace"))

        # 2. Forward it, headers intact.
        target = urlsplit(UPSTREAM)
        conn_cls = http.client.HTTPSConnection if target.scheme == "https" else http.client.HTTPConnection
        # Connect with a short timeout (a lost SYN must not stall the agent for
        # minutes); the long timeout is for reading a slow stream.
        upstream = conn_cls(target.netloc, timeout=10)
        try:
            upstream.connect()
        except OSError as e:
            print(f"\n[{stamp()}] !!! cannot reach {UPSTREAM}: {e}", flush=True)
            LOG.add("response", exchange, status=502, reason="Bad Gateway", headers=[])
            LOG.add("chunk", exchange, data=f"proxy: cannot reach {UPSTREAM}: {e}".encode())
            self.send_error(502, f"proxy: cannot reach {UPSTREAM}: {e}")
            self.close_connection = True
            return
        upstream.sock.settimeout(600)
        headers = {k: v for k, v in self.headers.items() if k.lower() not in SKIP}
        upstream.request(self.command, target.path.rstrip("/") + self.path, body=body or None, headers=headers)
        reply = upstream.getresponse()

        # 3. Stream the reply back as it arrives, printing it on the way.
        print(f"\n[{stamp()}] <<< {reply.status} {reply.reason}", flush=True)
        LOG.add("response", exchange, status=reply.status, reason=reply.reason, headers=reply.getheaders())
        self.send_response(reply.status, reply.reason)
        for name, value in reply.getheaders():
            if name.lower() not in SKIP and name.lower() != "content-encoding":
                self.send_header(name, value)
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command == "HEAD":
            self.close_connection = True
            return
        while chunk := reply.read1(4096):  # read1: pass on each chunk as it lands, don't wait for 4096 bytes
            self.wfile.write(chunk)
            self.wfile.flush()
            LOG.add("chunk", exchange, data=chunk)
            sys.stdout.write(chunk.decode("utf-8", "replace"))
            sys.stdout.flush()
        self.close_connection = True
        print(f"\n[{stamp()}] --- done", flush=True)


def sse_message(event: dict) -> bytes:
    """One raw event as an SSE message. Byte fields travel as base64: a chunk can
    end in the middle of a UTF-8 character, so only the browser can decode them."""
    wire = dict(event)
    for field in BYTES_FIELDS:
        if field in wire:
            wire[field] = base64.b64encode(wire[field]).decode("ascii")
    return f"id: {LOG.boot}:{event['seq']}\ndata: {json.dumps(wire)}\n\n".encode()


class Dashboard(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass  # the terminal stays about agent traffic

    def do_GET(self) -> None:
        # Reject other Host names so a web page cannot use DNS rebinding to read
        # the traffic through the browser.
        if urlsplit(f"//{self.headers.get('host', '')}").hostname not in DASHBOARD_HOSTS:
            self.send_plain(403, "forbidden host")
        elif self.path == "/":
            self.send_page()
        elif self.path == "/events":
            self.stream_events()
        else:
            self.send_plain(404, "not found")

    def send_plain(self, status: int, text: str) -> None:
        self.respond(status, "text/plain; charset=utf-8", text.encode())

    def send_page(self) -> None:
        try:
            page = DASHBOARD_PAGE.read_bytes()
        except OSError as e:
            self.send_plain(500, f"cannot read {DASHBOARD_PAGE.name}: {e}")
            return
        self.respond(200, "text/html; charset=utf-8", page)

    def respond(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", DASHBOARD_CSP)
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


class DashboardServer(ThreadingHTTPServer):
    def handle_error(self, request: object, client_address: object) -> None:
        pass  # a closed tab is normal, and must not print to the terminal


def start_dashboard(port: int) -> bool:
    """Serve the dashboard in the background. Failing to must not stop the proxy."""
    try:
        server = DashboardServer(("127.0.0.1", port), Dashboard)
    except OSError as e:
        print(f"  dashboard  not available on port {port}: {e}")
        return False
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"  dashboard  http://localhost:{port}")
    return True


def main() -> None:
    global UPSTREAM
    parser = argparse.ArgumentParser(description="Print and forward an agent's API traffic.")
    parser.add_argument("--port", type=int, default=8041)
    parser.add_argument("--dashboard-port", type=int, default=8042, help="where the live dashboard is served")
    parser.add_argument("--upstream", default=UPSTREAM, help="where to forward (default: the Anthropic API)")
    args = parser.parse_args()
    UPSTREAM = args.upstream.rstrip("/")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Tap)
    print(f"  proxy      http://localhost:{args.port} -> {UPSTREAM.split('://', 1)[-1]}", flush=True)
    start_dashboard(args.dashboard_port)
    print(f"run the agent with:  ANTHROPIC_BASE_URL=http://localhost:{args.port} claude", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
