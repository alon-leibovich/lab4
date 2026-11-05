/* worktree.js — SPEC D22: working directory and update tree.
 *
 * Self-contained browser module (no dependencies, no network). It consumes the
 * monitor's raw events (D9a: request / response / chunk / end, byte fields in
 * base64) and rebuilds, per session:
 *   - the working directory (and every change of it), from the injected
 *     environment context ("Primary working directory: ...");
 *   - a folder tree of every file Claude wrote or edited, each file expanding
 *     into a timeline of its updates: time, status, the typed prompt that led
 *     to it, +/- line counts and a small diff.
 *
 * Integration (two calls):
 *   const tracker = WorkTree.createTracker();
 *   // for every raw event the page receives (replay and live):
 *   tracker.feed(rawEvent);
 *   const panel = WorkTree.createPanel(containerElement, tracker, { onRaw: id => openRawPanel(id) });
 *   panel.setSession(sessionId);   // optional; defaults to the most recently active session
 *
 * Observing only: a parsing failure is caught per event and never thrown to
 * the caller.
 */
(function (root) {
  "use strict";

  // ---------------------------------------------------------------- constants
  const EDIT_TOOLS = { Write: "write", Edit: "edit", MultiEdit: "edit", NotebookEdit: "notebook" };
  const READ_TOOLS = { Read: true, NotebookRead: true };
  const SHELL_TOOLS = { Bash: true, PowerShell: true };
  const CWD_LINE = /^[ \t]*-?[ \t]*Primary working directory:[ \t]*(.+?)(?:[ \t]+\(was[ \t][^)]*\))?[ \t]*$/gm;
  // Default injected-text rule (mirrors D3a). The integrated page should pass
  // its own D3a classifier as `typedText` so the patterns live in one place.
  const INJECTED_TAGS = ["system-reminder", "command-name", "command-message", "command-args",
    "local-command-stdout", "local-command-stderr", "user-prompt-submit-hook",
    "bash-input", "bash-stdout", "bash-stderr"];
  const INJECTED_HEADERS = [/^#\s*Environment\b/, /^You have been invoked in the following environment/,
    /^Caveat: The messages below were generated/];
  const DENIAL = /doesn't want to proceed|was rejected|Permission to use .* (?:has been|was) denied|permission .*denied/i;
  const DIFF_CELL_LIMIT = 4e6; // LCS table cap; larger diffs fall back to "all removed, all added"

  // ---------------------------------------------------------------- helpers
  function b64bytes(s) {
    if (!s) return new Uint8Array(0);
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const decoder = new TextDecoder("utf-8");
  function concatBytes(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function blocksOf(content) {
    if (typeof content === "string") return [{ type: "text", text: content }];
    return Array.isArray(content) ? content.filter((b) => b && typeof b === "object") : [];
  }
  function textOf(content) {
    return blocksOf(content).map((b) => (b.type === "text" ? b.text || "" : "")).join("\n");
  }
  function defaultTypedText(text) {
    let t = String(text || "");
    for (const tag of INJECTED_TAGS) t = t.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"), "");
    t = t.trim();
    if (INJECTED_HEADERS.some((re) => re.test(t))) return "";
    return t;
  }
  function splitLines(s) {
    if (s == null || s === "") return [];
    const lines = String(s).split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
  }
  /** Line diff: [{op: " " | "-" | "+", text}] */
  function lineDiff(before, after) {
    const a = splitLines(before), b = splitLines(after);
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    const A = a.slice(p, a.length - s), B = b.slice(p, b.length - s);
    const mid = [];
    if (A.length * B.length > DIFF_CELL_LIMIT) {
      A.forEach((t) => mid.push({ op: "-", text: t }));
      B.forEach((t) => mid.push({ op: "+", text: t }));
    } else {
      const n = A.length, m = B.length;
      const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
      for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
          L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      let i = 0, j = 0;
      while (i < n && j < m) {
        if (A[i] === B[j]) { mid.push({ op: " ", text: A[i] }); i++; j++; }
        else if (L[i + 1][j] >= L[i][j + 1]) mid.push({ op: "-", text: A[i++] });
        else mid.push({ op: "+", text: B[j++] });
      }
      while (i < n) mid.push({ op: "-", text: A[i++] });
      while (j < m) mid.push({ op: "+", text: B[j++] });
    }
    return a.slice(0, p).map((t) => ({ op: " ", text: t }))
      .concat(mid, a.slice(a.length - s).map((t) => ({ op: " ", text: t })));
  }
  function countDiff(diff) {
    let added = 0, removed = 0;
    for (const d of diff) { if (d.op === "+") added++; else if (d.op === "-") removed++; }
    return { added, removed };
  }
  function joinPath(dir, p) {
    if (!p) return p;
    if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) return p;
    return (dir ? dir.replace(/\/+$/, "") + "/" : "") + p.replace(/^\.\//, "");
  }
  function normPath(p) {
    const parts = [];
    const abs = p.startsWith("/");
    for (const seg of p.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") parts.pop(); else parts.push(seg);
    }
    return (abs ? "/" : "") + parts.join("/");
  }

  // ---------------------------------------------------------------- tracker
  function createTracker(options) {
    const opts = Object.assign({ typedText: defaultTypedText }, options || {});
    const sessions = new Map();     // id -> session
    const updates = new Map();      // tool_use id -> update (edits/writes)
    const others = new Map();       // tool_use id -> {kind:'read'|'shell', session}
    const exchanges = new Map();    // exchange id -> in-flight state
    const listeners = new Set();
    let version = 0, notifyQueued = false;

    function notify() {
      version++;
      if (notifyQueued) return;
      notifyQueued = true;
      Promise.resolve().then(() => {
        notifyQueued = false;
        for (const cb of listeners) { try { cb(); } catch (e) { /* listener errors stay local */ } }
      });
    }

    function session(id, ts) {
      let s = sessions.get(id);
      if (!s) {
        s = { id, cwd: null, cwdHistory: [], files: new Map(), known: new Map(), firstTs: ts, lastTs: ts,
              shellCalls: 0, lastPrompt: null };
        sessions.set(id, s);
      }
      if (ts) { s.lastTs = Math.max(s.lastTs || 0, ts); s.firstTs = Math.min(s.firstTs || ts, ts); }
      return s;
    }

    function sessionIdOf(body, headers) {
      // metadata.user_id first: the monitor redacts headers whose name looks secret ("session" included).
      const uid = body && body.metadata && body.metadata.user_id;
      if (typeof uid === "string" && uid) {
        try { const j = JSON.parse(uid); if (j && j.session_id) return String(j.session_id); } catch (e) { /* not JSON */ }
        const m = uid.match(/session_([0-9a-fA-F-]{36})/);
        if (m) return m[1];
      }
      for (const [k, v] of headers || []) {
        if (String(k).toLowerCase() === "x-claude-code-session-id" && v && !/redacted/i.test(v)) return v;
      }
      return "default";
    }

    function file(s, path) {
      let f = s.files.get(path);
      if (!f) { f = { path, updates: [], reads: 0 }; s.files.set(path, f); }
      return f;
    }

    function setCwd(s, path, ts, exchange) {
      path = normPath(path.trim());
      if (!path || s.cwd === path) return;
      s.cwdHistory.push({ path, from: s.cwd, ts, exchange });
      s.cwd = path;
      notify();
    }

    function addToolUse(s, block, prompt, ts, exchange) {
      const id = block.id;
      if (!id || updates.has(id) || others.has(id)) return;
      const name = block.name, input = block.input || {};
      if (READ_TOOLS[name]) {
        const p = input.file_path || input.notebook_path;
        if (p) { file(s, normPath(joinPath(s.cwd, p))).reads++; others.set(id, { kind: "read", s }); notify(); }
        return;
      }
      if (SHELL_TOOLS[name]) { s.shellCalls++; others.set(id, { kind: "shell", s }); notify(); return; }
      const kind = EDIT_TOOLS[name];
      if (!kind) return;
      const rawPath = input.file_path || input.notebook_path;
      if (!rawPath) return;
      const path = normPath(joinPath(s.cwd, rawPath));
      const u = { id, tool: name, kind, path, ts, exchange, resultExchange: null, prompt, status: "pending",
                  result: "", diff: [], lines: null, session: s.id, note: "" };
      const known = s.known.get(path);
      if (name === "Write") {
        const content = String(input.content ?? "");
        u.lines = splitLines(content).length;
        u.diff = known != null ? lineDiff(known, content) : lineDiff("", content);
        u.note = known != null ? "" : "previous content unknown";
        s.known.set(path, content);
      } else if (name === "Edit" || name === "MultiEdit") {
        const edits = name === "MultiEdit" ? (input.edits || []) : [input];
        let content = known;
        for (const e of edits) {
          u.diff = u.diff.concat(lineDiff(String(e.old_string ?? ""), String(e.new_string ?? "")));
          if (content != null && e.old_string) {
            content = e.replace_all ? content.split(e.old_string).join(e.new_string ?? "")
                                    : content.replace(e.old_string, () => e.new_string ?? "");
          }
        }
        if (edits.some((e) => e.replace_all)) u.note = "replace all";
        if (content != null) s.known.set(path, content);
      } else if (name === "NotebookEdit") {
        u.diff = lineDiff("", String(input.new_source ?? ""));
        u.note = [input.edit_mode || "replace", input.cell_id ? `cell ${input.cell_id}` : ""].filter(Boolean).join(" · ");
      }
      Object.assign(u, countDiff(u.diff));
      updates.set(id, u);
      file(s, path).updates.push(u);
      notify();
    }

    function applyResult(block, exchange) {
      const u = updates.get(block.tool_use_id);
      if (!u || u.status !== "pending") return;
      const text = typeof block.content === "string" ? block.content
        : blocksOf(block.content).map((b) => b.text || "").join("\n");
      u.result = text;
      u.resultExchange = exchange;
      if (block.is_error) u.status = DENIAL.test(text) ? "denied" : "error";
      else u.status = "ok";
      if (u.tool === "Write" && u.status === "ok") {
        if (/created successfully/i.test(text)) { u.kind = "create"; u.note = ""; }
        else if (/updated|overwr/i.test(text)) u.kind = "overwrite";
      }
      if (u.status !== "ok") {
        // A failed change did not happen: forget the content we assumed it produced.
        sessions.get(u.session)?.known.delete(u.path);
      }
      notify();
    }

    function processRequest(ex, bodyText) {
      let body;
      try { body = JSON.parse(bodyText); } catch (e) { return; }
      if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return;
      const s = session(sessionIdOf(body, ex.headers), ex.ts);
      ex.session = s.id;
      // Working directory: the last "Primary working directory" line wins.
      let cwd = null;
      const scan = (t) => { CWD_LINE.lastIndex = 0; let m; while ((m = CWD_LINE.exec(t))) cwd = m[1]; };
      scan(typeof body.system === "string" ? body.system : textOf(body.system));
      for (const m of body.messages) scan(textOf(m.content));
      if (cwd) setCwd(s, cwd, ex.ts, ex.id);
      // History: prompts, tool uses and results, in message order.
      let prompt = null;
      for (const m of body.messages) {
        for (const b of blocksOf(m.content)) {
          if (m.role === "user" && b.type === "text") {
            const typed = opts.typedText(b.text);
            if (typed) prompt = typed;
          } else if (m.role === "user" && b.type === "tool_result") {
            applyResult(b, ex.id);
          } else if (m.role === "assistant" && b.type === "tool_use") {
            addToolUse(s, b, prompt, ex.ts, ex.id);
          }
        }
      }
      ex.prompt = prompt;
      if (prompt) s.lastPrompt = prompt;
    }

    function processResponse(ex, text) {
      if (!ex.session) return;
      const s = sessions.get(ex.session);
      const blocks = {};
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
        if (ev.type === "content_block_start" && ev.content_block && ev.content_block.type === "tool_use") {
          blocks[ev.index] = { block: Object.assign({}, ev.content_block), json: "" };
        } else if (ev.type === "content_block_delta" && blocks[ev.index] && ev.delta && ev.delta.type === "input_json_delta") {
          blocks[ev.index].json += ev.delta.partial_json || "";
        } else if (ev.type === "content_block_stop" && blocks[ev.index]) {
          const { block, json } = blocks[ev.index];
          try { if (json) block.input = JSON.parse(json); } catch (e) { continue; }
          addToolUse(s, block, ex.prompt, ex.ts, ex.id);
        }
      }
      // Non-streamed replies
      if (!Object.keys(blocks).length && text.trim().startsWith("{")) {
        try {
          const msg = JSON.parse(text);
          for (const b of blocksOf(msg.content)) if (b.type === "tool_use") addToolUse(s, b, ex.prompt, ex.ts, ex.id);
        } catch (e) { /* not a message */ }
      }
    }

    function isMessages(path) {
      return /^\/v1\/messages(\?|$)/.test(String(path || ""));
    }

    function feed(ev) {
      try {
        if (!ev || typeof ev !== "object" || !ev.kind) return;
        if (ev.kind === "request") {
          if (ev.method !== "POST" || !isMessages(ev.path)) return;
          const ex = { id: ev.exchange, ts: ev.ts, headers: ev.headers, chunks: [], session: null, prompt: null };
          exchanges.set(ev.exchange, ex);
          processRequest(ex, decoder.decode(b64bytes(ev.body)));
        } else if (ev.kind === "chunk") {
          const ex = exchanges.get(ev.exchange);
          if (ex) ex.chunks.push(b64bytes(ev.data));
        } else if (ev.kind === "end") {
          const ex = exchanges.get(ev.exchange);
          if (!ex) return;
          exchanges.delete(ev.exchange);
          processResponse(ex, decoder.decode(concatBytes(ex.chunks)));
        }
      } catch (e) {
        if (root.console) console.warn("worktree: could not use event", ev && ev.seq, e);
      }
    }

    function snapshot(sessionId) {
      const s = sessionId ? sessions.get(sessionId) : latestSession();
      if (!s) return null;
      const files = [...s.files.values()].filter((f) => f.updates.length);
      return {
        session: s.id, cwd: s.cwd, cwdHistory: s.cwdHistory.slice(), shellCalls: s.shellCalls,
        // The tree is rooted at the directory the session started in (the project), so a later
        // `cd` into a subfolder does not push earlier files "outside".
        root: s.cwdHistory.length ? s.cwdHistory[0].path : s.cwd,
        files: files.map((f) => {
          const ups = f.updates.slice().sort((a, b) => a.ts - b.ts);
          const done = ups.filter((u) => u.status === "ok");
          return {
            path: f.path, reads: f.reads, updates: ups,
            created: done.some((u) => u.kind === "create"),
            added: done.reduce((n, u) => n + u.added, 0), removed: done.reduce((n, u) => n + u.removed, 0),
            lastTs: ups.length ? ups[ups.length - 1].ts : 0,
            failed: ups.filter((u) => u.status === "error" || u.status === "denied").length,
            pending: ups.filter((u) => u.status === "pending").length,
          };
        }),
      };
    }

    function latestSession() {
      let best = null;
      for (const s of sessions.values()) if (!best || (s.lastTs || 0) > (best.lastTs || 0)) best = s;
      return best;
    }

    return {
      feed,
      snapshot,
      sessions: () => [...sessions.values()].map((s) => ({ id: s.id, cwd: s.cwd, firstTs: s.firstTs, lastTs: s.lastTs }))
        .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0)),
      onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
      get version() { return version; },
    };
  }

  // ---------------------------------------------------------------- tree
  /** Groups snapshot files into a folder tree rooted at the working directory. */
  function buildTree(snap) {
    const base = snap.root || snap.cwd;
    const cwd = base ? base.replace(/\/+$/, "") : null;
    const inside = { name: cwd ? cwd.split("/").pop() || "/" : "files", dirs: new Map(), files: [] };
    const outside = { name: "outside the project", dirs: new Map(), files: [] };
    for (const f of snap.files) {
      let rel, rootNode;
      if (cwd && (f.path === cwd || f.path.startsWith(cwd + "/"))) { rel = f.path.slice(cwd.length + 1); rootNode = inside; }
      else if (!cwd) { rel = f.path.replace(/^\//, ""); rootNode = inside; }
      else { rel = f.path.replace(/^\//, ""); rootNode = outside; }
      const parts = rel.split("/");
      let node = rootNode;
      for (const dir of parts.slice(0, -1)) {
        if (!node.dirs.has(dir)) node.dirs.set(dir, { name: dir, dirs: new Map(), files: [] });
        node = node.dirs.get(dir);
      }
      node.files.push(Object.assign({ name: parts[parts.length - 1], rel }, f));
    }
    return { inside, outside };
  }

  // ---------------------------------------------------------------- panel
  const STYLE = `
.wt{font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--wt-text,inherit)}
.wt *{box-sizing:border-box}
.wt-head{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline;padding:6px 0 8px;border-bottom:1px solid var(--wt-border,#d8d4cc);margin-bottom:6px}
.wt-label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--wt-muted,#7a756c)}
.wt-cwd{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;word-break:break-all}
.wt-btn{background:none;border:1px solid var(--wt-border,#d8d4cc);border-radius:5px;padding:0 6px;font:inherit;font-size:11.5px;color:var(--wt-muted,#7a756c);cursor:pointer}
.wt-btn:hover{color:var(--wt-text,#222)}
.wt-hist{width:100%;font-size:12px;color:var(--wt-muted,#7a756c);font-family:ui-monospace,Menlo,Consolas,monospace}
.wt-sum{font-size:12px;color:var(--wt-muted,#7a756c);margin:2px 0 6px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.wt-tree{list-style:none;margin:0;padding:0}
.wt-tree .wt-tree{padding-left:14px;border-left:1px solid var(--wt-border,#d8d4cc);margin-left:6px}
.wt-row{display:flex;gap:8px;align-items:baseline;padding:2px 4px;border-radius:5px;cursor:pointer;user-select:none;min-width:0}
.wt-row:hover{background:var(--wt-hover,rgba(127,127,127,.12))}
.wt-caret{width:10px;font-size:9px;color:var(--wt-muted,#7a756c);flex:none}
.wt-dir{font-weight:600}
.wt-fname{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wt-meta{color:var(--wt-muted,#7a756c);font-size:11.5px;white-space:nowrap}
.wt-add{color:var(--wt-ok,#2f8a4c)}.wt-del{color:var(--wt-err,#c0392b)}
.wt-badge{font-size:11px;border:1px solid var(--wt-border,#d8d4cc);border-radius:999px;padding:0 6px;white-space:nowrap}
.wt-badge.created{color:var(--wt-ok,#2f8a4c)}.wt-badge.failed{color:var(--wt-err,#c0392b)}.wt-badge.pending{color:var(--wt-warn,#b7791f)}
.wt-ups{list-style:none;margin:2px 0 6px 22px;padding:0;border-left:2px solid var(--wt-border,#d8d4cc)}
.wt-up{padding:3px 0 3px 10px;position:relative}
.wt-up-line{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.wt-time{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;color:var(--wt-muted,#7a756c)}
.wt-st{font-size:11.5px;white-space:nowrap}
.wt-st.ok{color:var(--wt-ok,#2f8a4c)}.wt-st.error,.wt-st.denied{color:var(--wt-err,#c0392b)}.wt-st.pending{color:var(--wt-warn,#b7791f)}
.wt-up.failed .wt-tool,.wt-up.failed .wt-counts{text-decoration:line-through;opacity:.7}
.wt-tool{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;font-weight:600}
.wt-prompt{color:var(--wt-muted,#7a756c);font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:28em}
.wt-diff{margin:4px 0 2px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;background:var(--wt-code,rgba(127,127,127,.08));border:1px solid var(--wt-border,#d8d4cc);border-radius:6px;padding:4px 0;overflow-x:auto;max-height:360px;overflow-y:auto}
.wt-dl{white-space:pre;padding:0 8px}
.wt-dl.add{background:rgba(47,138,76,.12)}.wt-dl.del{background:rgba(192,57,43,.12)}
.wt-dl.skip{color:var(--wt-muted,#7a756c);font-style:italic}
.wt-result{font-size:12px;color:var(--wt-err,#c0392b);white-space:pre-wrap;margin:2px 0}
.wt-empty{color:var(--wt-muted,#7a756c);padding:10px 0}
.wt-foot{margin-top:8px;font-size:12px;color:var(--wt-muted,#7a756c)}
`;

  function el(tag, cls, ...children) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    for (const c of children) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
    return e;
  }
  const clock = (ts) => ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  const oneLine = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const STATUS = { ok: "✓ done", error: "✗ failed", denied: "⊘ denied", pending: "… pending" };
  const KIND = { create: "+ created", overwrite: "✎ overwritten", write: "✎ written", edit: "✎ edited", notebook: "✎ notebook" };

  function createPanel(container, tracker, options) {
    const opts = Object.assign({ onRaw: null, contextLines: 2 }, options || {});
    if (!document.getElementById("wt-style")) {
      const st = document.createElement("style");
      st.id = "wt-style";
      st.textContent = STYLE;
      document.head.appendChild(st);
    }
    const state = { session: null, open: new Set(), closed: new Set(), diffs: new Set(), showHistory: false };
    const root = el("div", "wt");
    container.appendChild(root);

    let queued = false;
    function schedule() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; render(); });
    }
    const unsubscribe = tracker.onChange(schedule);

    function toggle(set, key) { set.has(key) ? set.delete(key) : set.add(key); render(); }
    function dirOpen(key) { return !state.closed.has(key); }   // folders start open
    function fileOpen(key) { return state.open.has(key); }      // files start closed

    function rawButton(exchange) {
      if (!opts.onRaw || exchange == null) return null;
      const b = el("button", "wt-btn", "raw");
      b.title = `exchange #${exchange}`;
      b.addEventListener("click", (e) => { e.stopPropagation(); opts.onRaw(exchange); });
      return b;
    }

    function diffView(u) {
      const box = el("div", "wt-diff");
      const ctx = opts.contextLines;
      const d = u.diff;
      let lastShown = -1;
      d.forEach((line, i) => {
        const near = line.op !== " " || d.slice(Math.max(0, i - ctx), i + ctx + 1).some((x) => x.op !== " ");
        if (!near) return;
        if (lastShown >= 0 && i - lastShown > 1) box.append(el("div", "wt-dl skip", `  … ${i - lastShown - 1} unchanged lines`));
        lastShown = i;
        box.append(el("div", "wt-dl" + (line.op === "+" ? " add" : line.op === "-" ? " del" : ""), `${line.op} ${line.text}`));
      });
      if (!d.length) box.append(el("div", "wt-dl skip", "  (no line changes)"));
      return box;
    }

    function updateItem(u) {
      const failed = u.status === "error" || u.status === "denied";
      const li = el("li", "wt-up" + (failed ? " failed" : ""));
      const line = el("div", "wt-up-line",
        el("span", "wt-time", clock(u.ts)),
        el("span", "wt-st " + u.status, STATUS[u.status] || u.status),
        el("span", "wt-tool", u.tool),
        el("span", "wt-meta", KIND[u.kind] || u.kind),
        u.kind === "create" || (u.tool === "Write" && u.note) ? el("span", "wt-meta wt-counts", `${u.lines} lines`)
          : el("span", "wt-meta wt-counts", el("span", "wt-add", `+${u.added}`), " ", el("span", "wt-del", `−${u.removed}`)),
        u.note ? el("span", "wt-meta", u.note) : null);
      if (u.prompt) {
        const p = el("span", "wt-prompt", `“${oneLine(u.prompt)}”`);
        p.title = u.prompt;
        line.append(p);
      }
      const db = el("button", "wt-btn", state.diffs.has(u.id) ? "hide diff" : "diff");
      db.addEventListener("click", (e) => { e.stopPropagation(); toggle(state.diffs, u.id); });
      line.append(db);
      const rb = rawButton(u.exchange);
      if (rb) line.append(rb);
      li.append(line);
      if (failed && u.result) li.append(el("div", "wt-result", oneLine(u.result).slice(0, 300)));
      if (state.diffs.has(u.id)) li.append(diffView(u));
      return li;
    }

    function fileItem(f) {
      const key = "f:" + f.path;
      const open = fileOpen(key);
      const li = el("li");
      const badges = [];
      if (f.created) badges.push(el("span", "wt-badge created", "+ new"));
      if (f.failed) badges.push(el("span", "wt-badge failed", `✗ ${f.failed} failed`));
      if (f.pending) badges.push(el("span", "wt-badge pending", `… ${f.pending} pending`));
      const n = f.updates.length;
      const row = el("div", "wt-row",
        el("span", "wt-caret", open ? "▼" : "▶"),
        el("span", "wt-fname", f.name),
        el("span", "wt-meta", `✎ ${n} update${n === 1 ? "" : "s"}`),
        el("span", "wt-meta", el("span", "wt-add", `+${f.added}`), " ", el("span", "wt-del", `−${f.removed}`)),
        f.reads ? el("span", "wt-meta", `read ${f.reads}×`) : null,
        ...badges,
        el("span", "wt-meta", clock(f.lastTs)));
      row.title = f.path;
      row.addEventListener("click", () => toggle(state.open, key));
      li.append(row);
      if (open) li.append(el("ul", "wt-ups", ...f.updates.map(updateItem)));
      return li;
    }

    function dirItems(node, prefix) {
      const items = [];
      const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
      for (const d of dirs) {
        // Collapse single-child folder chains: a/b/c/
        let name = d.name, cur = d;
        while (cur.files.length === 0 && cur.dirs.size === 1) { cur = [...cur.dirs.values()][0]; name += "/" + cur.name; }
        const key = "d:" + prefix + "/" + name;
        const open = dirOpen(key);
        const li = el("li");
        const row = el("div", "wt-row", el("span", "wt-caret", open ? "▼" : "▶"), el("span", "wt-dir", name + "/"));
        row.addEventListener("click", () => toggle(state.closed, key));
        li.append(row);
        if (open) li.append(el("ul", "wt-tree", ...dirItems(cur, prefix + "/" + name)));
        items.push(li);
      }
      for (const f of node.files.slice().sort((a, b) => a.name.localeCompare(b.name))) items.push(fileItem(f));
      return items;
    }

    function render() {
      const snap = tracker.snapshot(state.session);
      root.replaceChildren();
      if (!snap) { root.append(el("div", "wt-empty", "No Claude Code traffic yet.")); return; }
      // Working directory
      const head = el("div", "wt-head", el("span", "wt-label", "Working directory"),
        el("span", "wt-cwd", snap.cwd || "unknown (no environment context seen yet)"));
      if (snap.cwdHistory.length > 1) {
        const hb = el("button", "wt-btn", `changed ${snap.cwdHistory.length - 1}× ${state.showHistory ? "▲" : "▼"}`);
        hb.addEventListener("click", () => { state.showHistory = !state.showHistory; render(); });
        head.append(hb);
        if (state.showHistory) {
          head.append(el("div", "wt-hist", ...snap.cwdHistory.map((h) =>
            el("div", null, `${clock(h.ts)}  ${h.from ? h.from + " → " : "start: "}${h.path}`))));
        }
      }
      if (snap.root && snap.cwd && snap.root !== snap.cwd) {
        head.append(el("div", "wt-hist", `Tree below is rooted at the project folder the session started in: ${snap.root}`));
      }
      root.append(head);
      // Summary
      const nUpdates = snap.files.reduce((n, f) => n + f.updates.length, 0);
      const nFailed = snap.files.reduce((n, f) => n + f.failed, 0);
      const sum = el("div", "wt-sum", el("span", "wt-label", "Update tree"),
        `${snap.files.length} file${snap.files.length === 1 ? "" : "s"} · ${nUpdates} update${nUpdates === 1 ? "" : "s"}`,
        nFailed ? el("span", "wt-del", `${nFailed} failed or denied`) : null);
      if (snap.files.length) {
        const all = el("button", "wt-btn", "expand all");
        all.addEventListener("click", () => { for (const f of snap.files) state.open.add("f:" + f.path); state.closed.clear(); render(); });
        const none = el("button", "wt-btn", "collapse all");
        none.addEventListener("click", () => { state.open.clear(); state.diffs.clear(); render(); });
        sum.append(all, none);
      }
      root.append(sum);
      if (!snap.files.length) root.append(el("div", "wt-empty", "No files written or edited in this session yet."));
      const tree = buildTree(snap);
      if (tree.inside.files.length || tree.inside.dirs.size) {
        root.append(el("ul", "wt-tree", ...dirItems(tree.inside, "in")));
      }
      if (tree.outside.files.length || tree.outside.dirs.size) {
        root.append(el("div", "wt-label", "Outside the project folder"));
        root.append(el("ul", "wt-tree", ...dirItems(tree.outside, "out")));
      }
      if (snap.shellCalls) {
        root.append(el("div", "wt-foot",
          `Shell: ${snap.shellCalls} command${snap.shellCalls === 1 ? "" : "s"} ran. Files changed by shell commands are not tracked here.`));
      }
    }

    render();
    return {
      setSession(id) { state.session = id || null; render(); },
      render,
      destroy() { unsubscribe(); root.remove(); },
    };
  }

  root.WorkTree = { createTracker, createPanel, buildTree, lineDiff, defaultTypedText };
})(typeof window !== "undefined" ? window : globalThis);
