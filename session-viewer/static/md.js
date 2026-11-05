// Minimal, dependency-free Markdown renderer (HTML is always escaped).
// Covers what Claude's responses use: fenced code, headings, lists (nested),
// tables, blockquotes, hr, paragraphs, inline code, bold, italic, strike, links.
const MD = (() => {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = esc(s);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) =>
      /^(https?:|mailto:|#|\/)/i.test(u) ? `<a href="${u}" target="_blank" rel="noopener">${t}</a>` : m);
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
  }

  const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)/;
  const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const splitRow = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const indentOf = (l) => l.match(/^\s*/)[0].replace(/\t/g, "    ").length;
  const isBlockStart = (l, next) => FENCE.test(l) || /^#{1,6}\s/.test(l) || HR.test(l) || /^\s*>/.test(l) ||
    LIST.test(l) || (l.includes("|") && next !== undefined && TABLE_SEP.test(next));

  function list(lines) {
    const base = indentOf(lines[0]);
    const first = lines[0].match(LIST);
    const ordered = /\d/.test(first[2]);
    const items = [];
    for (const l of lines) {
      const m = l.match(LIST);
      if (m && indentOf(l) <= base + 1) items.push([m[3]]);
      else items[items.length - 1].push(l.replace(new RegExp(`^\\s{0,${base + 4}}`), ""));
    }
    const start = ordered ? parseInt(first[2], 10) : 1;
    const tag = ordered ? "ol" : "ul";
    const body = items.map((it) => {
      const inner = render(it.join("\n"));
      return `<li>${inner}</li>`;
    }).join("");
    return `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ""}>${body}</${tag}>`;
  }

  function render(src) {
    const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      let m;
      if ((m = l.match(FENCE))) {
        const fence = m[1], lang = m[2], buf = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
        i++;
        out.push(`<pre class="code">${lang ? `<span class="lang">${esc(lang)}</span>` : ""}<code>${esc(buf.join("\n"))}</code></pre>`);
        continue;
      }
      if (!l.trim()) { i++; continue; }
      if ((m = l.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/))) {
        out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue;
      }
      if (HR.test(l)) { out.push("<hr>"); i++; continue; }
      if (/^\s*>/.test(l)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*> ?/, ""));
        out.push(`<blockquote>${render(buf.join("\n"))}</blockquote>`);
        continue;
      }
      if (l.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        const head = splitRow(l);
        const aligns = splitRow(lines[i + 1]).map((c) => c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "");
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
        const cell = (tag, c, j) => `<${tag}${aligns[j] ? ` style="text-align:${aligns[j]}"` : ""}>${inline(c)}</${tag}>`;
        out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c, j) => cell("th", c, j)).join("")}</tr></thead><tbody>${
          rows.map((r) => `<tr>${head.map((_, j) => cell("td", r[j] || "", j)).join("")}</tr>`).join("")}</tbody></table></div>`);
        continue;
      }
      if (LIST.test(l)) {
        const base = indentOf(l);
        const buf = [l];
        i++;
        while (i < lines.length) {
          const cur = lines[i];
          if (!cur.trim()) {
            const nxt = lines[i + 1];
            if (nxt !== undefined && nxt.trim() && (indentOf(nxt) > base || (LIST.test(nxt) && indentOf(nxt) >= base))) { buf.push(""); i++; continue; }
            break;
          }
          if (indentOf(cur) > base || (LIST.test(cur) && indentOf(cur) >= base)) { buf.push(cur); i++; continue; }
          if (FENCE.test(cur) || /^#{1,6}\s/.test(cur)) break;
          if (!LIST.test(cur) && indentOf(cur) <= base && buf.length) { buf[buf.length - 1] += " " + cur.trim(); i++; continue; }
          break;
        }
        out.push(list(buf));
        continue;
      }
      const buf = [l.trim()];
      i++;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) buf.push(lines[i++].trim());
      out.push(`<p>${buf.map(inline).join("<br>")}</p>`);
    }
    return out.join("\n");
  }

  return { render, esc };
})();
