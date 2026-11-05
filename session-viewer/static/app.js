"use strict";
const API = "/_viewer/api";
const esc = MD.esc;
const $ = (s) => document.querySelector(s);

const state = {
  sessions: [],
  search: "",
  sid: null,
  session: null,
  events: new Map(),          // id -> event
  responding: new Map(),      // exchange_id -> {thread, parent}
  tab: "timeline",
  open: new Map(),            // key -> bool (user expand/collapse overrides)
  rawOpen: false,
  rawScope: "session",
  rawSelected: null,          // {type:'exchange', id} | {type:'event', id}
  rawList: [],
  newCount: 0,
};

// ---------------------------------------------------------------- utilities
const fmtTime = (ts) => ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
const fmtDate = (ts) => {
  if (!ts) return "";
  const d = new Date(ts * 1000), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};
const trunc = (s, n) => (s = String(s ?? "")).length > n ? s.slice(0, n - 1) + "…" : s;
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const base = (p) => String(p || "").split("/").filter(Boolean).pop() || p || "";
const getJSON = async (url) => (await fetch(url)).json();
const isOpen = (key, dflt = false) => state.open.has(key) ? state.open.get(key) : dflt;

function toolSummary(name, input) {
  input = input || {};
  if (typeof input.description === "string" && input.description) return input.description;
  switch (name) {
    case "Read": case "Write": case "Edit": case "MultiEdit": return base(input.file_path);
    case "NotebookEdit": return base(input.notebook_path);
    case "Bash": return input.command;
    case "Grep": return `${input.pattern}${input.path ? " in " + base(input.path) : ""}`;
    case "Glob": return input.pattern;
    case "WebFetch": return input.url;
    case "WebSearch": return input.query;
    case "TodoWrite": return `${(input.todos || []).length} todos`;
    case "Skill": return input.skill;
  }
  const first = Object.values(input).find((v) => typeof v === "string");
  return first ?? JSON.stringify(input);
}

function resultText(resp) {
  if (resp == null) return "";
  if (typeof resp === "string") return resp;
  if (Array.isArray(resp)) return resp.map((b) => b && typeof b === "object" ? (b.text ?? JSON.stringify(b, null, 2)) : String(b)).join("\n");
  if (typeof resp === "object") {
    if ("stdout" in resp || "stderr" in resp) {
      let s = resp.stdout || "";
      if (resp.stderr) s += (s ? "\n" : "") + "[stderr]\n" + resp.stderr;
      if (resp.interrupted) s += "\n[interrupted]";
      return s || "(no output)";
    }
    if (resp.file && typeof resp.file.content === "string") return resp.file.content;
    if (typeof resp.content === "string") return resp.content;
    if (Array.isArray(resp.content)) return resultText(resp.content);
    if (Array.isArray(resp.filenames)) return resp.filenames.join("\n") || "(no matches)";
    if (typeof resp.result === "string") return resp.result;
  }
  return JSON.stringify(resp, null, 2);
}

function inputView(name, input) {
  input = input || {};
  if (name === "Bash" && input.command) return input.command;
  if ((name === "Agent" || name === "Task") && input.prompt) return input.prompt;
  if (name === "Edit" && input.file_path) {
    return `${input.file_path}\n\n--- old\n${input.old_string ?? ""}\n\n+++ new\n${input.new_string ?? ""}`;
  }
  if (name === "Write" && input.file_path) return `${input.file_path}\n\n${input.content ?? ""}`;
  return JSON.stringify(input, null, 2);
}

// ---------------------------------------------------------------- model
function buildModel() {
  const evs = [...state.events.values()].sort((a, b) => a.ts - b.ts || a.id - b.id);
  const calls = new Map();
  const card = (tid) => {
    if (!calls.has(tid)) calls.set(tid, { tid, call: null, result: null, perm: null, children: [] });
    return calls.get(tid);
  };
  const boundaries = []; // ts of prompts and stops (for denial inference)
  for (const e of evs) {
    if (e.tool_use_id && ["tool_call", "tool_result", "permission_request"].includes(e.kind)) {
      const c = card(e.tool_use_id);
      if (e.kind === "tool_call") c.call = e;
      else if (e.kind === "tool_result") c.result = e;
      else c.perm = e;
    }
    if (e.kind === "prompt" || (e.kind === "stop" && !e.payload.subagent)) boundaries.push(e.ts);
  }
  const later = (ts) => boundaries.some((b) => b > ts);

  for (const c of calls.values()) {
    const res = c.result;
    if (res) {
      c.status = res.payload.denied ? "denied" : res.payload.is_error ? "err" : "ok";
    } else if (c.perm && later(c.perm.ts)) {
      c.status = "denied";
    } else if (c.call && later(c.call.ts)) {
      c.status = "unknown";
    } else {
      c.status = "running";
    }
    if (c.perm) c.permOutcome = res && !res.payload.denied ? "allowed" : (c.status === "denied" ? "denied" : "pending");
  }

  // Group renderable items by parent tool_use_id ('' = top level)
  const groups = new Map();
  const push = (parent, item) => {
    const k = parent && calls.has(parent) && calls.get(parent).call ? parent : "";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(item);
  };
  for (const e of evs) {
    switch (e.kind) {
      case "prompt": case "response": case "permission_mode_change": case "notification":
        push(e.parent_tool_use_id, { type: e.kind, ev: e, key: "e" + e.id }); break;
      case "tool_call": {
        const c = calls.get(e.tool_use_id);
        if (c && c.call === e) push(e.parent_tool_use_id, { type: "tool", c, key: "t" + e.tool_use_id });
        else if (!e.tool_use_id) push(e.parent_tool_use_id, { type: "tool", c: { call: e, status: "unknown", children: [] }, key: "e" + e.id });
        break;
      }
      case "permission_request":
        if (!e.tool_use_id || !calls.get(e.tool_use_id)?.call) push(e.parent_tool_use_id, { type: "perm-orphan", ev: e, key: "e" + e.id });
        break;
    }
  }
  return { calls, groups };
}

// ---------------------------------------------------------------- rendering
function rawLink(e) {
  if (!e) return "";
  const x = e.exchange_ids && e.exchange_ids[0];
  return x ? `<button class="rawlink" data-act="raw-x" data-id="${x}">raw</button>`
    : `<button class="rawlink" data-act="raw-e" data-id="${e.id}" title="No API exchange linked; shows the hook event">raw</button>`;
}

function renderItem(it, m) {
  const e = it.ev;
  switch (it.type) {
    case "prompt":
      return `<div class="item prompt"><div class="who">${rawLink(e)}<span class="time">${fmtTime(e.ts)}</span>You</div>` +
        `<div class="bubble">${esc(e.payload.text || "")}</div></div>`;
    case "response": {
      const p = e.payload;
      const think = p.thinking ? `<details class="thinking" data-key="th${e.id}" ${isOpen("th" + e.id) ? "open" : ""}><summary>Thinking</summary><div class="md">${MD.render(p.thinking)}</div></details>` : "";
      const err = p.error ? `<div class="resp-error">API error: ${esc(p.error.message || JSON.stringify(p.error))}</div>` : "";
      const inc = p.complete === false ? ` <span class="badge pending">incomplete</span>` : "";
      return `<div class="item response"><div class="who">Claude<span class="time">${fmtTime(e.ts)}</span>${rawLink(e)}${inc}</div>` +
        `${think}<div class="body md">${MD.render(p.text || "")}</div>${err}</div>`;
    }
    case "permission_mode_change":
      return `<div class="item divider" title="${esc(fmtTime(e.ts))}">permission mode: ${esc(e.payload.from)} → ${esc(e.payload.to)} ${rawLink(e)}</div>`;
    case "notification":
      return `<div class="item note"><span>🔔 ${esc(e.payload.message || e.payload.notification_type || "notification")}</span><span class="time">${fmtTime(e.ts)}</span>${rawLink(e)}</div>`;
    case "perm-orphan":
      return `<div class="item note"><span>permission asked: ${esc(e.payload.tool_name)} · ${esc(trunc(oneLine(toolSummary(e.payload.tool_name, e.payload.tool_input)), 100))}</span>${rawLink(e)}</div>`;
    case "tool":
      return renderCard(it.c, m);
  }
  return "";
}

function statusIcon(s) {
  switch (s) {
    case "running": return `<span class="status"><span class="spinner"></span></span>`;
    case "ok": return `<span class="status ok" title="done">✓</span>`;
    case "err": return `<span class="status err" title="error">✗</span>`;
    case "denied": return `<span class="status denied" title="denied">⊘</span>`;
    default: return `<span class="status unknown" title="no result recorded">–</span>`;
  }
}

function renderCard(c, m) {
  const e = c.call;
  const name = e.payload.tool_name || "tool";
  const input = e.payload.tool_input;
  const key = "c" + (c.tid || e.id);
  const isAgent = name === "Agent" || name === "Task";
  const errored = c.status === "err" || c.status === "denied";
  const open = isOpen(key, errored && !isAgent);
  const badge = c.perm ? `<span class="badge ${c.permOutcome}">asked → ${c.permOutcome === "pending" ? "…" : c.permOutcome}</span>` : "";
  const children = isAgent && c.tid ? (m.groups.get(c.tid) || []) : [];
  const subInflight = isAgent && [...state.responding.values()].some((r) => r.parent === c.tid);
  const count = isAgent && children.length ? `<span class="badge">${children.filter((x) => x.type === "tool").length} tools</span>` : "";

  let body = "";
  if (open) {
    const text = c.result ? resultText(c.result.payload.response) : "";
    const lines = text.split("\n");
    const full = isOpen("f" + key);
    const shown = full ? text : lines.slice(0, 20).join("\n");
    const more = lines.length > 20 ? `<button class="showall" data-act="toggle" data-key="f${key}">${full ? "show less" : `show all ${lines.length} lines`}</button>` : "";
    body = `<div class="card-body">
      <div class="label">${isAgent ? "Prompt" : "Input"} ${rawLink(e)}</div><pre class="io">${esc(inputView(name, input))}</pre>
      ${isAgent ? `<div class="label agent-label">Subagent</div><div class="nested">${children.map((ch) => renderItem(ch, m)).join("") ||
        (subInflight ? "" : `<div class="note">No subagent activity captured.</div>`)}${subInflight ? respondingRow() : ""}</div>` : ""}
      ${c.result ? `<div class="label">${c.status === "denied" ? "Denied" : c.status === "err" ? "Error" : "Result"} ${rawLink(c.result)}</div><pre class="io result">${esc(shown)}</pre>${more}`
        : c.status === "running" ? `<div class="label">Running…</div>` : c.status === "denied" ? `<div class="label">Denied (no result)</div>` : ""}
    </div>`;
  }
  return `<div class="item card${errored ? " error" : ""}${open ? " open" : ""}">
    <div class="card-head" data-act="toggle" data-key="${key}" data-default="${errored && !isAgent ? 1 : 0}">
      <span class="caret">▶</span><span class="tname">${esc(name)}</span><span class="tsum">${esc(trunc(oneLine(toolSummary(name, input)), 160))}</span>
      ${count}${badge}${statusIcon(c.status)}
    </div>${body}</div>`;
}

function respondingRow() {
  return `<div class="item responding"><span class="spinner"></span><span class="dots">Claude is responding</span></div>`;
}

const nodeHTML = new WeakMap();
function reconcile(container, items) {
  const existing = new Map();
  for (const n of container.children) existing.set(n.dataset.key, n);
  let prev = null, added = 0;
  for (const it of items) {
    let n = existing.get(it.key);
    if (n && nodeHTML.get(n) === it.html) existing.delete(it.key);
    else {
      const t = document.createElement("div");
      t.innerHTML = it.html.trim();
      const nn = t.firstElementChild || document.createElement("div");
      nn.dataset.key = it.key;
      nodeHTML.set(nn, it.html);
      if (n) { n.replaceWith(nn); existing.delete(it.key); } else added++;
      n = nn;
    }
    const want = prev ? prev.nextSibling : container.firstChild;
    if (n !== want) container.insertBefore(n, want);
    prev = n;
  }
  existing.forEach((n) => n.remove());
  return added;
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function atBottom() {
  const s = $("#scroller");
  return s.scrollHeight - s.scrollTop - s.clientHeight < 40;
}

function render() {
  renderStatus();
  const empty = $("#empty");
  if (!state.sid) {
    $("#timeline").innerHTML = ""; $("#permissions").hidden = true;
    empty.hidden = false;
    empty.innerHTML = state.sessions.length ? "Select a session." :
      `No sessions yet.<br><br>Start Claude Code with<br><code>ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude</code>`;
    return;
  }
  empty.hidden = true;
  const m = buildModel();
  if (state.tab === "permissions") {
    $("#timeline").hidden = true; $("#permissions").hidden = false;
    renderPermissions(m);
    return;
  }
  $("#timeline").hidden = false; $("#permissions").hidden = true;
  const stick = atBottom();
  const items = (m.groups.get("") || []).map((it) => ({ key: it.key, html: renderItem(it, m) }));
  const mainInflight = [...state.responding.values()].some((r) => r.thread === "main");
  if (mainInflight) items.push({ key: "responding", html: respondingRow() });
  if (!items.length) items.push({ key: "nothing", html: `<div class="empty">Waiting for activity…</div>` });
  const added = reconcile($("#timeline"), items);
  if (stick) { $("#scroller").scrollTop = $("#scroller").scrollHeight; state.newCount = 0; }
  else if (added && !firstRender) state.newCount += added;
  firstRender = false;
  $("#new-pill").hidden = state.newCount === 0;
  $("#new-pill span").textContent = state.newCount;
}
let firstRender = true;

function renderPermissions(m) {
  const rows = [];
  const evs = [...state.events.values()].sort((a, b) => a.ts - b.ts || a.id - b.id);
  for (const e of evs) {
    if (e.kind === "permission_mode_change") {
      rows.push(`<tr><td>${fmtTime(e.ts)}</td><td>mode change</td><td class="mono">${esc(e.payload.from)} → ${esc(e.payload.to)}</td><td></td><td>${rawLink(e)}</td></tr>`);
    } else if (e.kind === "permission_request") {
      const c = e.tool_use_id && m.calls.get(e.tool_use_id);
      const outcome = c ? c.permOutcome : "unknown";
      rows.push(`<tr><td>${fmtTime(e.ts)}</td><td>request</td><td><span class="tname">${esc(e.payload.tool_name)}</span> · ${esc(trunc(oneLine(toolSummary(e.payload.tool_name, e.payload.tool_input)), 120))}</td>` +
        `<td><span class="badge ${outcome}">${outcome}</span></td><td>${rawLink(e)}</td></tr>`);
    } else if (e.kind === "notification" && /permission/i.test((e.payload.notification_type || "") + (e.payload.message || ""))) {
      rows.push(`<tr><td>${fmtTime(e.ts)}</td><td>notification</td><td>${esc(e.payload.message || "")}</td><td></td><td>${rawLink(e)}</td></tr>`);
    }
  }
  $("#permissions").innerHTML = rows.length
    ? `<table class="ptable"><thead><tr><th>Time</th><th>Event</th><th>Detail</th><th>Outcome</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>`
    : `<div class="empty">No permission events in this session.<br><br>Current mode: <code>${esc(state.session?.current_permission_mode || "unknown")}</code></div>`;
}

function renderStatus() {
  const s = state.session;
  $("#s-title").textContent = s ? trunc(s.title || "(untitled session)", 90) : "No session selected";
  $("#s-cwd").textContent = s?.cwd || "";
  $("#s-live").hidden = !s?.live;
  const mode = $("#s-mode");
  mode.hidden = !s?.current_permission_mode;
  mode.textContent = s?.current_permission_mode ? `mode: ${s.current_permission_mode}` : "";
}

function renderSessions() {
  const ul = $("#sessions");
  ul.innerHTML = state.sessions.map((s) => `<li data-sid="${esc(s.id)}" class="${s.id === state.sid ? "active" : ""}">
    <div class="s-row1">${s.live ? '<span class="dot">●</span>' : ""}<span class="t">${esc(trunc(s.title || "(untitled)", 80))}</span></div>
    <div class="s-row2">${esc(fmtDate(s.started_at))} · ${esc(s.cwd || "")}</div></li>`).join("") ||
    `<li class="muted" style="cursor:default">${state.search ? "No matches." : "No sessions yet."}</li>`;
}

// ---------------------------------------------------------------- data loading
async function loadSessions() {
  state.sessions = await getJSON(`${API}/sessions${state.search ? "?search=" + encodeURIComponent(state.search) : ""}`);
  renderSessions();
}

async function selectSession(sid) {
  state.sid = sid;
  state.events.clear(); state.responding.clear();
  state.newCount = 0; firstRender = true;
  $("#timeline").innerHTML = "";
  if (sid) {
    history.replaceState(null, "", "#session=" + encodeURIComponent(sid));
    const d = await getJSON(`${API}/sessions/${encodeURIComponent(sid)}/events`);
    if (state.sid !== sid) return;
    state.session = d.session;
    for (const e of d.events) state.events.set(e.id, e);
    for (const r of d.responding) state.responding.set(r.exchange_id, r);
  } else state.session = null;
  renderSessions();
  render();
  $("#scroller").scrollTop = $("#scroller").scrollHeight;
  if (state.rawOpen) loadRawList();
  $("#sidebar").classList.remove("open");
}

// ---------------------------------------------------------------- live updates
function connect() {
  const es = new EventSource("/_viewer/events");
  let dropped = false;
  es.onerror = () => { dropped = true; };
  es.onopen = () => {
    if (dropped) { dropped = false; loadSessions(); if (state.sid) selectSession(state.sid); }
  };
  es.onmessage = (msg) => {
    const d = JSON.parse(msg.data);
    if (d.type === "event" || d.type === "event_update") {
      if (d.event.session_id === state.sid) { state.events.set(d.event.id, d.event); scheduleRender(); }
    } else if (d.type === "session") {
      const s = d.session;
      const i = state.sessions.findIndex((x) => x.id === s.id);
      if (i >= 0) state.sessions[i] = s; else if (!state.search) state.sessions.push(s);
      state.sessions.sort((a, b) => (b.last_activity || 0) - (a.last_activity || 0));
      renderSessions();
      if (s.id === state.sid) { state.session = s; renderStatus(); }
      if (!state.sid && !state.search) selectSession(s.id);
    } else if (d.type === "responding") {
      if (d.session_id === state.sid) {
        if (d.active) state.responding.set(d.exchange_id, { thread: d.thread, parent: d.parent });
        else state.responding.delete(d.exchange_id);
        scheduleRender();
      }
    } else if (d.type === "exchange") {
      const x = d.exchange;
      if (state.rawOpen && ((state.rawScope === "session" && x.session_id === state.sid) || (state.rawScope === "unattributed" && !x.session_id))) {
        const i = state.rawList.findIndex((y) => y.id === x.id);
        if (i >= 0) state.rawList[i] = x; else state.rawScope === "session" ? state.rawList.push(x) : state.rawList.unshift(x);
        renderRawList();
      }
    }
  };
}

// ---------------------------------------------------------------- raw panel
function openRaw(sel) {
  state.rawOpen = true;
  $("#raw").classList.add("open");
  $("#raw").setAttribute("aria-hidden", "false");
  if (sel) state.rawSelected = sel;
  loadRawList().then(() => { if (state.rawSelected) showRawDetail(state.rawSelected); });
}
function closeRaw() {
  state.rawOpen = false;
  $("#raw").classList.remove("open");
  $("#raw").setAttribute("aria-hidden", "true");
}

async function loadRawList() {
  const scope = state.rawScope === "unattributed" ? "unattributed" : state.sid;
  document.querySelectorAll(".rtab").forEach((b) => b.classList.toggle("active", b.dataset.scope === state.rawScope));
  state.rawList = scope ? await getJSON(`${API}/sessions/${encodeURIComponent(scope)}/exchanges`) : [];
  renderRawList();
}

function renderRawList() {
  const sel = state.rawSelected?.type === "exchange" ? state.rawSelected.id : null;
  $("#raw-list").innerHTML = state.rawList.map((x) => `<li data-xid="${x.id}" class="${x.id === sel ? "active" : ""}">
      <span>${fmtTime(x.ts)}</span><span>${esc(x.method)}</span><span class="x-path">${esc(x.path)}</span>
      <span class="x-thread">${esc(x.thread || "")}</span><span>${x.status ?? "…"}</span>
      <span class="muted">${x.input_tokens ?? "-"}/${x.output_tokens ?? "-"} tok</span><span class="muted">${x.duration_ms != null ? (x.duration_ms / 1000).toFixed(1) + "s" : ""}</span></li>`).join("")
    || `<li class="muted" style="cursor:default">No exchanges recorded${state.rawScope === "session" ? " for this session" : ""}.</li>`;
}

function headersTable(h) {
  return `<table class="htable">${(h || []).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>`;
}

// Lazy collapsible JSON tree
function jsonTree(value, key, open) {
  const k = key != null ? `<span class="k">${esc(JSON.stringify(key))}</span>: ` : "";
  if (value === null || typeof value !== "object") {
    let cls = "z", txt = String(value);
    if (typeof value === "string") { cls = "s"; txt = JSON.stringify(value); }
    else if (typeof value === "number") cls = "n";
    else if (typeof value === "boolean") cls = "b";
    if (typeof value === "string" && value.length > 400) {
      const d = document.createElement("details");
      d.innerHTML = `<summary>${k}<span class="s">${esc(JSON.stringify(value.slice(0, 120)))}…</span> <span class="cnt">(${value.length} chars)</span></summary>`;
      const row = document.createElement("div"); row.className = "row s"; row.textContent = value;
      d.appendChild(row);
      return d;
    }
    const div = document.createElement("div");
    div.className = "row";
    div.innerHTML = `${k}<span class="${cls}">${esc(txt)}</span>`;
    return div;
  }
  const isArr = Array.isArray(value);
  const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
  const d = document.createElement("details");
  const preview = isArr ? `[${entries.length}]` : `{${entries.length}}`;
  d.innerHTML = `<summary>${k}<span class="cnt">${preview}</span></summary>`;
  let filled = false;
  const fill = () => {
    if (filled) return; filled = true;
    for (const [ck, cv] of entries) d.appendChild(jsonTree(cv, isArr ? ck : ck, false));
  };
  d.addEventListener("toggle", () => { if (d.open) fill(); });
  if (open) { d.open = true; fill(); }
  return d;
}

function section(title, content, open = false) {
  const d = document.createElement("details");
  d.className = "sec"; d.open = open;
  d.innerHTML = `<summary>${esc(title)}</summary>`;
  if (typeof content === "string") d.insertAdjacentHTML("beforeend", content); else d.appendChild(content);
  return d;
}
const jt = (v, open = true) => { const w = document.createElement("div"); w.className = "jt"; w.appendChild(jsonTree(v, null, open)); return w; };

async function showRawDetail(sel) {
  state.rawSelected = sel;
  renderRawList();
  const box = $("#raw-detail");
  box.innerHTML = `<div class="muted">Loading…</div>`;
  if (sel.type === "event") {
    const e = await getJSON(`${API}/events/${sel.id}`);
    box.innerHTML = `<div class="x-meta"><b>Hook event #${e.id}</b><span>${esc(e.kind)}</span><span>${fmtTime(e.ts)}</span>
      <span>No API exchange is linked to this item; showing the recorded hook data.</span></div>`;
    box.appendChild(jt(e.payload));
    return;
  }
  const x = await getJSON(`${API}/exchanges/${sel.id}`);
  if (x.error) { box.innerHTML = `<div class="muted">Exchange not found.</div>`; return; }
  const usage = x.resp_json && x.resp_json.usage;
  const cache = usage ? ` · cache read ${usage.cache_read_input_tokens ?? 0} · cache write ${usage.cache_creation_input_tokens ?? 0}` : "";
  box.innerHTML = `<div class="x-meta"><b>#${x.id}</b><span>${esc(x.method)} ${esc(x.path)}</span><span>status <b>${x.status ?? "…"}</b></span>
    <span>${esc(x.model || "")}</span><span>in ${x.input_tokens ?? "-"} · out ${x.output_tokens ?? "-"}${cache}</span>
    <span>${x.duration_ms != null ? (x.duration_ms / 1000).toFixed(2) + "s" : "in progress"}</span><span>${esc(x.thread || "")}</span>
    <a class="dl" href="${API}/exchanges/${x.id}/download" download>Download JSON</a></div>`;
  box.appendChild(section("Request headers", headersTable(x.req_headers)));
  box.appendChild(section("Request body", x.req_json != null ? jt(x.req_json) : `<pre class="rawstream">${esc(x.req_body || "")}</pre>`, true));
  box.appendChild(section("Response headers", headersTable(x.resp_headers)));
  if (x.resp_json != null) box.appendChild(section(x.streamed ? "Response (reassembled from stream)" : "Response body", jt(x.resp_json), true));
  if (x.streamed || x.resp_json == null) box.appendChild(section(x.streamed ? "Raw event stream" : "Raw response", `<pre class="rawstream">${esc(x.resp_body || "")}</pre>`));
}

// ---------------------------------------------------------------- events
document.addEventListener("click", (ev) => {
  const t = ev.target.closest("[data-act]");
  if (t) {
    const act = t.dataset.act;
    if (act === "toggle") {
      const key = t.dataset.key;
      const dflt = t.dataset.default === "1";
      state.open.set(key, !isOpen(key, dflt));
      scheduleRender();
    } else if (act === "raw-x") { ev.stopPropagation(); state.rawScope = "session"; openRaw({ type: "exchange", id: +t.dataset.id }); }
    else if (act === "raw-e") { ev.stopPropagation(); openRaw({ type: "event", id: +t.dataset.id }); }
    return;
  }
  const li = ev.target.closest("#sessions li[data-sid]");
  if (li) { selectSession(li.dataset.sid); return; }
  const xl = ev.target.closest("#raw-list li[data-xid]");
  if (xl) { showRawDetail({ type: "exchange", id: +xl.dataset.xid }); return; }
  const tab = ev.target.closest(".tab");
  if (tab) {
    state.tab = tab.dataset.tab;
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === tab));
    render(); return;
  }
  const rtab = ev.target.closest(".rtab");
  if (rtab) { state.rawScope = rtab.dataset.scope; state.rawSelected = null; $("#raw-detail").innerHTML = ""; loadRawList(); return; }
});
document.addEventListener("toggle", (ev) => {
  const d = ev.target;
  if (d.matches && d.matches("details[data-key]")) state.open.set(d.dataset.key, d.open);
}, true);
$("#open-raw").onclick = () => state.rawOpen ? closeRaw() : openRaw();
$("#close-raw").onclick = closeRaw;
$("#toggle-side").onclick = () => $("#sidebar").classList.toggle("open");
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && state.rawOpen) closeRaw(); });
$("#new-pill").onclick = () => { const s = $("#scroller"); s.scrollTo({ top: s.scrollHeight, behavior: "smooth" }); };
$("#scroller").addEventListener("scroll", () => {
  if (atBottom() && state.newCount) { state.newCount = 0; $("#new-pill").hidden = true; }
});
let searchTimer;
$("#search").addEventListener("input", (ev) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.search = ev.target.value.trim(); loadSessions(); }, 200);
});

// ---------------------------------------------------------------- boot
(async () => {
  await loadSessions();
  const m = location.hash.match(/session=([^&]+)/);
  const sid = m ? decodeURIComponent(m[1]) : state.sessions[0]?.id;
  await selectSession(sid || null);
  connect();
})();
