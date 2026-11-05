"""Session Viewer: a local proxy + hook receiver + website for watching Claude Code sessions live.

Run:  python server.py   (binds 127.0.0.1:8787)
See SPEC.md for the design.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sqlite3
import time
import zlib
from pathlib import Path
from typing import Any

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

HERE = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("VIEWER_DATA_DIR", HERE / "data"))
DB_PATH = DATA_DIR / "viewer.db"
STATIC_DIR = HERE / "static"
HOST = "127.0.0.1"
PORT = int(os.environ.get("VIEWER_PORT", "8787"))
UPSTREAM = os.environ.get("VIEWER_UPSTREAM", "https://api.anthropic.com").rstrip("/")
LIVE_WINDOW_S = 30 * 60

REDACT_HEADERS = {"x-api-key", "authorization", "proxy-authorization", "cookie", "set-cookie"}
HOP_BY_HOP = {"host", "content-length", "connection", "keep-alive", "transfer-encoding",
              "te", "trailer", "upgrade", "proxy-connection"}
AGENT_TOOLS = {"Agent", "Task"}
DENIAL_MARKERS = ("doesn't want to proceed", "permission to use", "was rejected", "denied")

log = logging.getLogger("session-viewer")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)

# --------------------------------------------------------------------------------------
# Database
# --------------------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions(
    id TEXT PRIMARY KEY, cwd TEXT, started_at REAL, ended_at REAL, title TEXT,
    current_permission_mode TEXT, last_activity REAL);
CREATE TABLE IF NOT EXISTS events(
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts REAL, kind TEXT,
    tool_use_id TEXT, parent_tool_use_id TEXT, payload_json TEXT);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS events_tool ON events(tool_use_id);
CREATE TABLE IF NOT EXISTS exchanges(
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NULL, ts REAL, duration_ms INTEGER,
    method TEXT, path TEXT, status INTEGER, req_headers_json TEXT, req_body TEXT,
    resp_headers_json TEXT, resp_body TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
    thread TEXT, parent_tool_use_id TEXT, hint_session_id TEXT);
CREATE INDEX IF NOT EXISTS exchanges_session ON exchanges(session_id, ts);
CREATE TABLE IF NOT EXISTS event_exchange(event_id INTEGER, exchange_id INTEGER,
    PRIMARY KEY(event_id, exchange_id));
CREATE TABLE IF NOT EXISTS exchange_tool_uses(tool_use_id TEXT PRIMARY KEY, exchange_id INTEGER);
"""

DATA_DIR.mkdir(parents=True, exist_ok=True)
db = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
db.row_factory = sqlite3.Row
db.execute("PRAGMA journal_mode=WAL")
db.executescript(SCHEMA)
# All DB access happens on the event loop thread (every handler is async), so one connection is safe.


def q(sql: str, *args) -> list[sqlite3.Row]:
    return db.execute(sql, args).fetchall()


def q1(sql: str, *args) -> sqlite3.Row | None:
    return db.execute(sql, args).fetchone()


# --------------------------------------------------------------------------------------
# Live updates (SSE)
# --------------------------------------------------------------------------------------

clients: set[asyncio.Queue] = set()
# exchange_id -> {"session_id", "thread", "parent"} for in-flight main/subagent requests
inflight: dict[int, dict] = {}


def broadcast(msg: dict) -> None:
    data = json.dumps(msg, default=str)
    for cq in list(clients):
        try:
            cq.put_nowait(data)
        except asyncio.QueueFull:
            pass


# --------------------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------------------

REMINDER_RE = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)


def clean_prompt(text: str) -> str:
    return REMINDER_RE.sub("", text or "").strip()


def redact_headers(items) -> list[list[str]]:
    return [[k, "[REDACTED]" if k.lower() in REDACT_HEADERS else v] for k, v in items]


def content_text(content: Any) -> str:
    """Concatenate text from a message content (string or list of blocks)."""
    if isinstance(content, str):
        return content
    out = []
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict):
                if b.get("type") == "text":
                    out.append(b.get("text", ""))
                elif b.get("type") == "tool_result":
                    out.append(content_text(b.get("content")))
    return "\n".join(out)


def ensure_session(sid: str, cwd: str | None = None, mode: str | None = None, ts: float | None = None) -> None:
    ts = ts or time.time()
    if q1("SELECT 1 FROM sessions WHERE id=?", sid) is None:
        db.execute("INSERT INTO sessions(id, cwd, started_at, current_permission_mode, last_activity) VALUES(?,?,?,?,?)",
                   (sid, cwd, ts, mode, ts))
    elif cwd:
        db.execute("UPDATE sessions SET cwd=COALESCE(cwd, ?) WHERE id=?", (cwd, sid))


def session_summary(sid: str) -> dict | None:
    r = q1("SELECT * FROM sessions WHERE id=?", sid)
    if not r:
        return None
    d = dict(r)
    now = time.time()
    responding = any(v["session_id"] == sid for v in inflight.values())
    d["live"] = bool(d["ended_at"] is None and ((now - (d["last_activity"] or 0)) < LIVE_WINDOW_S or responding))
    return d


def touch_session(sid: str, ts: float | None = None) -> None:
    db.execute("UPDATE sessions SET last_activity=MAX(COALESCE(last_activity,0), ?) WHERE id=?", (ts or time.time(), sid))
    s = session_summary(sid)
    if s:
        broadcast({"type": "session", "session": s})


def event_dict(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["payload"] = json.loads(d.pop("payload_json") or "{}")
    d["exchange_ids"] = [x["exchange_id"] for x in q("SELECT exchange_id FROM event_exchange WHERE event_id=? ORDER BY exchange_id", d["id"])]
    return d


def get_event(eid: int) -> dict:
    return event_dict(q1("SELECT * FROM events WHERE id=?", eid))


def link(event_id: int, exchange_id: int | None) -> None:
    if exchange_id:
        db.execute("INSERT OR IGNORE INTO event_exchange(event_id, exchange_id) VALUES(?,?)", (event_id, exchange_id))


def add_event(sid: str, kind: str, payload: dict, tool_use_id: str | None = None,
              parent: str | None = None, ts: float | None = None, exchange_id: int | None = None) -> dict:
    ts = ts or time.time()
    cur = db.execute("INSERT INTO events(session_id, ts, kind, tool_use_id, parent_tool_use_id, payload_json) VALUES(?,?,?,?,?,?)",
                     (sid, ts, kind, tool_use_id, parent, json.dumps(payload, default=str)))
    eid = cur.lastrowid
    link(eid, exchange_id)
    ev = get_event(eid)
    broadcast({"type": "event", "event": ev})
    touch_session(sid, ts)
    return ev


def update_event_broadcast(eid: int) -> None:
    broadcast({"type": "event_update", "event": get_event(eid)})


def parent_for_tool_use(tool_use_id: str | None) -> str | None:
    if not tool_use_id:
        return None
    r = q1("SELECT e.parent_tool_use_id p FROM exchange_tool_uses t JOIN exchanges e ON e.id=t.exchange_id WHERE t.tool_use_id=?",
           tool_use_id)
    return r["p"] if r else None


def exchange_for_tool_use(tool_use_id: str | None) -> int | None:
    if not tool_use_id:
        return None
    r = q1("SELECT exchange_id FROM exchange_tool_uses WHERE tool_use_id=?", tool_use_id)
    return r["exchange_id"] if r else None


# --------------------------------------------------------------------------------------
# Hooks
# --------------------------------------------------------------------------------------

def handle_hook(h: dict) -> None:
    sid = h.get("session_id")
    name = h.get("hook_event_name")
    if not sid or not name:
        return
    now = time.time()
    mode = h.get("permission_mode")
    ensure_session(sid, h.get("cwd"), mode, now)

    # Permission mode changes (any hook carrying permission_mode)
    if mode:
        cur = q1("SELECT current_permission_mode m FROM sessions WHERE id=?", sid)["m"]
        if cur is None:
            db.execute("UPDATE sessions SET current_permission_mode=? WHERE id=?", (mode, sid))
        elif cur != mode:
            db.execute("UPDATE sessions SET current_permission_mode=? WHERE id=?", (mode, sid))
            add_event(sid, "permission_mode_change", {"from": cur, "to": mode, "hook": name}, ts=now)

    tuid = h.get("tool_use_id")

    if name == "SessionStart":
        db.execute("UPDATE sessions SET ended_at=NULL WHERE id=?", (sid,))
        touch_session(sid, now)
    elif name == "UserPromptSubmit":
        text = clean_prompt(h.get("prompt", ""))
        r = q1("SELECT title FROM sessions WHERE id=?", sid)
        if not r["title"] and text:
            db.execute("UPDATE sessions SET title=? WHERE id=?", (text[:120], sid))
        add_event(sid, "prompt", {"text": text, "hook": h}, ts=now)
    elif name == "PreToolUse":
        if tuid and q1("SELECT 1 FROM events WHERE kind='tool_call' AND tool_use_id=?", tuid):
            return
        add_event(sid, "tool_call", {"tool_name": h.get("tool_name"), "tool_input": h.get("tool_input"), "hook": h},
                  tool_use_id=tuid, parent=parent_for_tool_use(tuid), ts=now, exchange_id=exchange_for_tool_use(tuid))
    elif name in ("PostToolUse", "PostToolUseFailure"):
        if tuid and q1("SELECT 1 FROM events WHERE kind='tool_result' AND tool_use_id=?", tuid):
            return
        resp = h.get("tool_response")
        is_error = name == "PostToolUseFailure" or (isinstance(resp, dict) and bool(resp.get("is_error")))
        if name == "PostToolUseFailure" and resp is None:
            resp = h.get("error")
        add_event(sid, "tool_result", {"tool_name": h.get("tool_name"), "response": resp, "is_error": is_error, "hook": h},
                  tool_use_id=tuid, parent=parent_for_tool_use(tuid), ts=now)
    elif name == "PermissionRequest":
        tname, tinput = h.get("tool_name"), h.get("tool_input")
        if not tuid:  # match the most recent running call with the same tool + input
            for r in q("SELECT * FROM events WHERE session_id=? AND kind='tool_call' ORDER BY ts DESC LIMIT 50", sid):
                p = json.loads(r["payload_json"])
                if p.get("tool_name") == tname and p.get("tool_input") == tinput and not q1(
                        "SELECT 1 FROM events WHERE kind='tool_result' AND tool_use_id=?", r["tool_use_id"]):
                    tuid = r["tool_use_id"]
                    break
        add_event(sid, "permission_request", {"tool_name": tname, "tool_input": tinput, "hook": h},
                  tool_use_id=tuid, parent=parent_for_tool_use(tuid), ts=now)
    elif name == "Notification":
        add_event(sid, "notification", {"message": h.get("message"), "notification_type": h.get("notification_type"), "hook": h}, ts=now)
    elif name in ("Stop", "SubagentStop"):
        add_event(sid, "stop", {"subagent": name == "SubagentStop", "hook": h}, ts=now)
    elif name == "SessionEnd":
        db.execute("UPDATE sessions SET ended_at=? WHERE id=?", (now, sid))
        touch_session(sid, now)


# --------------------------------------------------------------------------------------
# Proxy correlation
# --------------------------------------------------------------------------------------

SESSION_IN_USERID = re.compile(r"session_([0-9a-fA-F-]{36})")


def session_from_request(headers: dict, body: dict) -> str | None:
    sid = headers.get("x-claude-code-session-id")
    if sid:
        return sid
    uid = (body.get("metadata") or {}).get("user_id")
    if isinstance(uid, str) and uid:
        try:
            j = json.loads(uid)
            if isinstance(j, dict) and j.get("session_id"):
                return j["session_id"]
        except ValueError:
            pass
        m = SESSION_IN_USERID.search(uid)
        if m:
            return m.group(1)
    return None


def classify(method: str, path: str, headers: dict, body_bytes: bytes) -> dict:
    """Return {"session_id", "thread": main|subagent|background, "parent", "hint"}."""
    ctx = {"session_id": None, "thread": "background", "parent": None, "hint": None}
    if method != "POST" or path.rstrip("/") != "v1/messages":
        return ctx
    try:
        body = json.loads(body_bytes)
    except ValueError:
        return ctx
    if not isinstance(body, dict):
        return ctx
    msgs = body.get("messages") or []
    sid = session_from_request(headers, body)
    ctx["hint"] = sid

    # Fallback: match tool_use ids in the history against hook events
    if not sid:
        ids = [b.get("id") or b.get("tool_use_id") for m in msgs if isinstance(m.get("content"), list)
               for b in m["content"] if isinstance(b, dict) and b.get("type") in ("tool_use", "tool_result")]
        for tid in reversed([i for i in ids if i]):
            r = q1("SELECT session_id FROM events WHERE tool_use_id=? LIMIT 1", tid)
            if r:
                sid = r["session_id"]
                break
    # Fallback: match the prompt text
    if not sid and msgs:
        texts = clean_prompt(" ".join(content_text(m.get("content")) for m in msgs if m.get("role") == "user"))
        for r in q("SELECT session_id, payload_json FROM events WHERE kind='prompt' ORDER BY ts DESC LIMIT 200"):
            t = json.loads(r["payload_json"]).get("text", "")
            if t and t in texts:
                sid = r["session_id"]
                break

    # Subagent: first user message carries an Agent tool's prompt
    first = content_text(msgs[0].get("content")) if msgs and msgs[0].get("role") == "user" else ""
    if first:
        sql = "SELECT * FROM events WHERE kind='tool_call' AND json_extract(payload_json,'$.tool_name') IN ('Agent','Task')"
        rows = q(sql + (" AND session_id=?" if sid else "") + " ORDER BY ts DESC LIMIT 100", *([sid] if sid else []))
        for r in rows:
            p = (json.loads(r["payload_json"]).get("tool_input") or {}).get("prompt") or ""
            if p.strip() and p.strip()[:2000] in first:
                ctx.update(session_id=r["session_id"], thread="subagent", parent=r["tool_use_id"])
                return ctx

    if sid and body.get("tools"):
        ctx.update(session_id=sid, thread="main")
    return ctx


def on_request_start(xid: int, ctx: dict, body_bytes: bytes) -> None:
    """Link prompts / tool results found in the request; synthesise error results the hooks missed."""
    sid = ctx["session_id"]
    ensure_session(sid)
    try:
        body = json.loads(body_bytes)
    except ValueError:
        return
    msgs = body.get("messages") or []
    if ctx["thread"] == "main":
        # Link unlinked prompts whose text is in this request
        users = " ".join(content_text(m.get("content")) for m in msgs if m.get("role") == "user")
        for r in q("SELECT e.id, e.payload_json FROM events e WHERE e.session_id=? AND e.kind='prompt' "
                   "AND NOT EXISTS (SELECT 1 FROM event_exchange x WHERE x.event_id=e.id) ORDER BY ts DESC LIMIT 5", sid):
            t = json.loads(r["payload_json"]).get("text", "")
            if t and t[:500] in users:
                link(r["id"], xid)
                update_event_broadcast(r["id"])
    # Tool results in the messages after the last assistant turn (the tail may also hold system messages)
    tail_blocks = []
    for m in reversed(msgs):
        if not isinstance(m, dict) or m.get("role") == "assistant":
            break
        if m.get("role") == "user" and isinstance(m.get("content"), list):
            tail_blocks = m["content"] + tail_blocks
    for b in tail_blocks:
        if not isinstance(b, dict) or b.get("type") != "tool_result":
            continue
        tid = b.get("tool_use_id")
        call = q1("SELECT * FROM events WHERE kind='tool_call' AND tool_use_id=?", tid)
        if not call:
            continue
        res = q1("SELECT id FROM events WHERE kind='tool_result' AND tool_use_id=?", tid)
        if res:
            if not q1("SELECT 1 FROM event_exchange WHERE event_id=?", res["id"]):
                link(res["id"], xid)
                update_event_broadcast(res["id"])
            continue
        text = content_text(b.get("content"))
        is_err = bool(b.get("is_error"))
        denied = is_err and any(m in text for m in DENIAL_MARKERS)
        add_event(call["session_id"], "tool_result",
                  {"tool_name": json.loads(call["payload_json"]).get("tool_name"), "response": text,
                   "is_error": is_err, "denied": denied, "source": "proxy"},
                  tool_use_id=tid, parent=call["parent_tool_use_id"], exchange_id=xid)


def assemble_sse(raw: str) -> dict:
    msg: dict = {}
    blocks: dict[int, dict] = {}
    complete = False
    for line in raw.splitlines():
        if not line.startswith("data:"):
            continue
        try:
            ev = json.loads(line[5:].strip())
        except ValueError:
            continue
        t = ev.get("type")
        if t == "message_start":
            msg = dict(ev.get("message") or {})
        elif t == "content_block_start":
            b = dict(ev.get("content_block") or {})
            if b.get("type") in ("tool_use", "server_tool_use"):
                b["_json"] = ""
            blocks[ev.get("index", len(blocks))] = b
        elif t == "content_block_delta":
            b = blocks.setdefault(ev.get("index", 0), {"type": "text", "text": ""})
            d = ev.get("delta") or {}
            dt = d.get("type")
            if dt == "text_delta":
                b["text"] = b.get("text", "") + d.get("text", "")
            elif dt == "input_json_delta":
                b["_json"] = b.get("_json", "") + d.get("partial_json", "")
            elif dt == "thinking_delta":
                b["thinking"] = b.get("thinking", "") + d.get("thinking", "")
            elif dt == "signature_delta":
                b["signature"] = d.get("signature")
        elif t == "content_block_stop":
            b = blocks.get(ev.get("index"))
            if b is not None and "_json" in b:
                s = b.pop("_json")
                try:
                    b["input"] = json.loads(s) if s else b.get("input", {})
                except ValueError:
                    b["input_raw"] = s
        elif t == "message_delta":
            msg.update({k: v for k, v in (ev.get("delta") or {}).items()})
            if ev.get("usage"):
                msg["usage"] = {**(msg.get("usage") or {}), **ev["usage"]}
        elif t == "message_stop":
            complete = True
        elif t == "error":
            msg["error"] = ev.get("error")
    for b in blocks.values():
        if "_json" in b:
            b["input_raw"] = b.pop("_json")
    msg["content"] = [blocks[i] for i in sorted(blocks)]
    msg["_complete"] = complete
    return msg


def assembled_response(resp_body: str | None, resp_headers: list) -> dict | None:
    if not resp_body:
        return None
    ctype = next((v for k, v in resp_headers if k.lower() == "content-type"), "")
    if "event-stream" in ctype or resp_body.lstrip().startswith("event:"):
        return assemble_sse(resp_body)
    try:
        return json.loads(resp_body)
    except ValueError:
        return None


def decode_body(raw: bytes, headers: list) -> str:
    enc = next((v for k, v in headers if k.lower() == "content-encoding"), "").lower()
    try:
        if enc in ("gzip", "deflate"):
            raw = zlib.decompress(raw, 47)
    except zlib.error:
        pass
    return raw.decode("utf-8", errors="replace")


def on_request_end(xid: int, ctx: dict, status: int, resp_headers: list, raw: bytes, started: float) -> None:
    body = decode_body(raw, resp_headers)
    msg = assembled_response(body, resp_headers) or {}
    usage = msg.get("usage") or {} if isinstance(msg, dict) else {}
    db.execute("UPDATE exchanges SET duration_ms=?, status=?, resp_headers_json=?, resp_body=?, model=COALESCE(?, model), "
               "input_tokens=?, output_tokens=? WHERE id=?",
               (int((time.time() - started) * 1000), status, json.dumps(redact_headers(resp_headers)), body,
                msg.get("model") if isinstance(msg, dict) else None,
                usage.get("input_tokens"), usage.get("output_tokens"), xid))
    sid = ctx["session_id"]
    if ctx["thread"] in ("main", "subagent") and sid and isinstance(msg, dict):
        for b in msg.get("content") or []:
            if b.get("type") == "tool_use" and b.get("id"):
                record_tool_use(b["id"], xid, ctx)
        text = "\n\n".join(b.get("text", "") for b in msg.get("content") or [] if b.get("type") == "text").strip()
        thinking = "\n\n".join(b.get("thinking", "") for b in msg.get("content") or [] if b.get("type") == "thinking").strip()
        if text or thinking:
            add_event(sid, "response", {"text": text, "thinking": thinking, "model": msg.get("model"),
                                        "stop_reason": msg.get("stop_reason"), "complete": msg.get("_complete", True)},
                      parent=ctx["parent"], ts=started, exchange_id=xid)
        elif msg.get("error"):
            add_event(sid, "response", {"text": "", "error": msg["error"]}, parent=ctx["parent"], ts=started, exchange_id=xid)
    inflight.pop(xid, None)
    if sid:
        broadcast({"type": "responding", "session_id": sid, "exchange_id": xid, "active": False})
        touch_session(sid)
    broadcast({"type": "exchange", "exchange": exchange_summary(xid)})


def record_tool_use(tool_use_id: str, xid: int, ctx: dict) -> None:
    db.execute("INSERT OR IGNORE INTO exchange_tool_uses(tool_use_id, exchange_id) VALUES(?,?)", (tool_use_id, xid))
    r = q1("SELECT id, parent_tool_use_id FROM events WHERE kind='tool_call' AND tool_use_id=?", tool_use_id)
    if r:
        link(r["id"], xid)
        if ctx["parent"] and not r["parent_tool_use_id"]:
            db.execute("UPDATE events SET parent_tool_use_id=? WHERE tool_use_id=? AND parent_tool_use_id IS NULL",
                       (ctx["parent"], tool_use_id))
            for e in q("SELECT id FROM events WHERE tool_use_id=?", tool_use_id):
                update_event_broadcast(e["id"])
        else:
            update_event_broadcast(r["id"])


TOOL_ID_RE = re.compile(r'"type"\s*:\s*"tool_use"\s*,\s*"id"\s*:\s*"([A-Za-z0-9_]+)"')


def exchange_summary(xid: int) -> dict:
    r = q1("SELECT id, session_id, ts, duration_ms, method, path, status, model, input_tokens, output_tokens, thread, "
           "parent_tool_use_id, hint_session_id FROM exchanges WHERE id=?", xid)
    return dict(r) if r else {}


# --------------------------------------------------------------------------------------
# App
# --------------------------------------------------------------------------------------

app = FastAPI(title="Session Viewer", docs_url=None, redoc_url=None, openapi_url=None)
http = httpx.AsyncClient(timeout=httpx.Timeout(connect=30, read=900, write=120, pool=60), follow_redirects=False)
app.mount("/_viewer/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-store"})


@app.post("/hooks")
async def hooks(request: Request):
    try:
        h = json.loads(await request.body())
        if isinstance(h, dict):
            handle_hook(h)
    except Exception:  # never fail the hook script
        log.exception("hook handling failed")
    return Response(status_code=204)


@app.get("/_viewer/events")
async def events_stream(request: Request):
    cq: asyncio.Queue = asyncio.Queue(maxsize=5000)
    clients.add(cq)

    async def gen():
        try:
            yield "retry: 1000\n\n"
            while True:
                try:
                    data = await asyncio.wait_for(cq.get(), timeout=15)
                    yield f"data: {data}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                if await request.is_disconnected():
                    break
        finally:
            clients.discard(cq)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@app.get("/_viewer/api/sessions")
async def api_sessions(q_: str | None = None, search: str | None = None):
    term = (search or q_ or "").strip()
    if term:
        rows = q("SELECT DISTINCT s.id FROM sessions s JOIN events e ON e.session_id=s.id AND e.kind='prompt' "
                 "WHERE json_extract(e.payload_json,'$.text') LIKE ? ORDER BY s.last_activity DESC", f"%{term}%")
    else:
        rows = q("SELECT id FROM sessions ORDER BY last_activity DESC")
    return [session_summary(r["id"]) for r in rows]


@app.get("/_viewer/api/sessions/{sid}/events")
async def api_events(sid: str):
    evs = [event_dict(r) for r in q("SELECT * FROM events WHERE session_id=? ORDER BY ts, id", sid)]
    return {"session": session_summary(sid), "events": evs,
            "responding": [{"exchange_id": k, **v} for k, v in inflight.items() if v["session_id"] == sid]}


@app.get("/_viewer/api/sessions/{sid}/exchanges")
async def api_exchanges(sid: str):
    cols = ("id, session_id, ts, duration_ms, method, path, status, model, input_tokens, output_tokens, thread, "
            "parent_tool_use_id, hint_session_id")
    if sid == "unattributed":
        rows = q(f"SELECT {cols} FROM exchanges WHERE session_id IS NULL ORDER BY ts DESC LIMIT 1000")
    else:
        rows = q(f"SELECT {cols} FROM exchanges WHERE session_id=? ORDER BY ts", sid)
    return [dict(r) for r in rows]


def exchange_full(xid: int) -> dict | None:
    r = q1("SELECT * FROM exchanges WHERE id=?", xid)
    if not r:
        return None
    d = dict(r)
    d["req_headers"] = json.loads(d.pop("req_headers_json") or "[]")
    d["resp_headers"] = json.loads(d.pop("resp_headers_json") or "[]")
    try:
        d["req_json"] = json.loads(d["req_body"]) if d["req_body"] else None
    except ValueError:
        d["req_json"] = None
    d["resp_json"] = assembled_response(d["resp_body"], d["resp_headers"])
    d["streamed"] = any(k.lower() == "content-type" and "event-stream" in v for k, v in d["resp_headers"])
    return d


@app.get("/_viewer/api/exchanges/{xid}")
async def api_exchange(xid: int):
    d = exchange_full(xid)
    return d if d else JSONResponse({"error": "not found"}, status_code=404)


@app.get("/_viewer/api/exchanges/{xid}/download")
async def api_exchange_download(xid: int):
    d = exchange_full(xid)
    if not d:
        return JSONResponse({"error": "not found"}, status_code=404)
    return Response(json.dumps(d, indent=2, default=str), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="exchange-{xid}.json"'})


@app.get("/_viewer/api/events/{eid}")
async def api_event(eid: int):
    r = q1("SELECT * FROM events WHERE id=?", eid)
    return event_dict(r) if r else JSONResponse({"error": "not found"}, status_code=404)


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
async def proxy(path: str, request: Request):
    """Forward everything else (Claude Code's /v1/* traffic) to the real API."""
    started = time.time()
    body = await request.body()
    method = request.method
    in_headers = list(request.headers.items())
    fwd = [(k, v) for k, v in in_headers if k.lower() not in HOP_BY_HOP and k.lower() != "accept-encoding"]
    fwd.append(("accept-encoding", "identity"))
    url = f"{UPSTREAM}/{path}" + (f"?{request.url.query}" if request.url.query else "")

    # Record + classify; any failure here must not affect forwarding.
    xid, ctx = None, {"session_id": None, "thread": "background", "parent": None, "hint": None}
    try:
        ctx = classify(method, path, {k.lower(): v for k, v in in_headers}, body)
        model = None
        try:
            model = json.loads(body).get("model") if body else None
        except (ValueError, AttributeError):
            pass
        cur = db.execute("INSERT INTO exchanges(session_id, ts, method, path, req_headers_json, req_body, model, thread, "
                         "parent_tool_use_id, hint_session_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
                         (ctx["session_id"], started, method, "/" + path + (f"?{request.url.query}" if request.url.query else ""),
                          json.dumps(redact_headers(in_headers)), body.decode("utf-8", errors="replace"), model,
                          ctx["thread"], ctx["parent"], ctx["hint"]))
        xid = cur.lastrowid
        if ctx["session_id"]:
            on_request_start(xid, ctx, body)
            inflight[xid] = {"session_id": ctx["session_id"], "thread": ctx["thread"], "parent": ctx["parent"]}
            broadcast({"type": "responding", "session_id": ctx["session_id"], "exchange_id": xid,
                       "thread": ctx["thread"], "parent": ctx["parent"], "active": True})
    except Exception:
        log.exception("recording request failed")

    try:
        upstream = await http.send(http.build_request(method, url, headers=fwd, content=body), stream=True)
    except httpx.HTTPError as e:
        if xid:
            try:
                inflight.pop(xid, None)
                on_request_end(xid, ctx, 502, [], str(e).encode(), started)
            except Exception:
                log.exception("recording failure failed")
        return JSONResponse({"type": "error", "error": {"type": "proxy_error", "message": str(e)}}, status_code=502)

    resp_headers = [(k, v) for k, v in upstream.headers.multi_items() if k.lower() not in HOP_BY_HOP]
    chunks: list[bytes] = []

    def finish():
        if xid is None:
            return
        try:
            on_request_end(xid, ctx, upstream.status_code, resp_headers, b"".join(chunks), started)
        except Exception:
            log.exception("recording response failed")
            inflight.pop(xid, None)

    async def gen():
        tail = ""
        seen: set[str] = set()
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
                chunks.append(chunk)
                # Spot tool_use ids early so subagent tool hooks can be nested before the stream ends.
                if xid and ctx["thread"] in ("main", "subagent"):
                    try:
                        s = tail + chunk.decode("utf-8", errors="ignore")
                        for tid in TOOL_ID_RE.findall(s):
                            if tid not in seen:
                                seen.add(tid)
                                record_tool_use(tid, xid, ctx)
                        tail = s[-300:]
                    except Exception:
                        log.exception("tool id scan failed")
        finally:
            finish()
            try:
                await upstream.aclose()
            except Exception:
                pass

    resp = StreamingResponse(gen(), status_code=upstream.status_code)
    resp.raw_headers = [(k.encode("latin-1"), v.encode("latin-1")) for k, v in resp_headers]
    return resp


if __name__ == "__main__":
    log.info("Session Viewer on http://%s:%d  (proxy -> %s, db %s)", HOST, PORT, UPSTREAM, DB_PATH)
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
