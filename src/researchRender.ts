// Renders a research/*.md into a self-contained HTML page, using the same renderer
// proven in the initiative-brief preview: a markdown → HTML pass, the reusable
// analytical block registry (```heatmap → Harvey-ball matrix), a report-header card,
// an "On this page" jump-nav, and reading-measure prose. This is the shared render
// module (research-format-render-v0 R-003) so the preview and `foo research view`
// cannot drift. Self-contained: no CDN, CSP-safe.

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// Escape the quote characters that would let a value break out of an href="…"
// attribute. Callers pass strings that have already had &<> escaped upstream.
function attr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Validate a markdown link target for use in an href. Returns an
// attribute-safe string, or null when the scheme is not allowed (so the caller
// renders the raw text instead of a clickable link). Only http(s), mailto, and
// scheme-less (relative/anchor) targets are permitted — `javascript:`, `data:`,
// `vbscript:`, etc. are rejected. Tab/newline/CR are stripped before the scheme
// check because browsers strip them from URLs before resolving the scheme.
function safeHref(h: string): string | null {
  const scheme = h.replace(/[\t\n\r]/g, "").trim().match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme && !/^(https?|mailto)$/i.test(scheme[1])) return null;
  return attr(h.trim());
}

// ---- reusable analytical block components (```<type> routes here) ----
function renderHeatmap(src: string): string {
  let dims: string[] = [];
  let legend = "";
  const rows: Array<{ tier?: string; name?: string; self?: boolean; vals?: number[] }> = [];
  src.split("\n").filter((s) => s.trim()).forEach((l) => {
    const t = l.trim();
    if (/^legend:/i.test(t)) { legend = t.replace(/^legend:/i, "").trim(); return; }
    if (/^dims:/i.test(t)) { dims = t.replace(/^dims:/i, "").split("|").map((x) => x.trim()); return; }
    if (/^tier:/i.test(t)) { rows.push({ tier: t.replace(/^tier:/i, "").trim() }); return; }
    const self = /^self:/i.test(t);
    const body = self ? t.replace(/^self:/i, "").trim() : t;
    const parts = body.split("|").map((x) => x.trim());
    const name = parts.shift();
    rows.push({ name, self, vals: parts.map((v) => parseInt(v, 10)) });
  });
  const ball = (lvl: number): string => {
    lvl = isNaN(lvl) ? 0 : Math.max(0, Math.min(4, lvl));
    const w: Record<number, string> = { 1: "M9,9 L9,1 A8,8 0 0 1 17,9 Z", 2: "M9,9 L9,1 A8,8 0 0 1 9,17 Z", 3: "M9,9 L9,1 A8,8 0 1 1 1,9 Z" };
    const inner = lvl >= 4 ? '<circle cx="9" cy="9" r="8" fill="currentColor"/>' : lvl > 0 ? `<path d="${w[lvl]}" fill="currentColor"/>` : "";
    return `<svg class="hb" width="15" height="15" viewBox="0 0 18 18" role="img" aria-label="${lvl} of 4"><circle cx="9" cy="9" r="8" fill="none" stroke="currentColor" stroke-width="1.4" opacity="0.4"/>${inner}</svg>`;
  };
  let html = `<div class="hmap"><table class="hm"><thead><tr><th></th>${dims.map((d) => `<th>${esc(d)}</th>`).join("")}</tr></thead><tbody>`;
  rows.forEach((r) => {
    if (r.tier) { html += `<tr class="hm-tier"><td colspan="${dims.length + 1}">${esc(r.tier)}</td></tr>`; return; }
    html += `<tr${r.self ? ' class="hm-self"' : ""}><td class="hm-name">${esc(r.name || "")}</td>${(r.vals || []).map((v) => `<td class="hm-cell" title="${isNaN(v) ? 0 : v} of 4">${ball(v)}</td>`).join("")}</tr>`;
  });
  html += `</tbody></table>${legend ? `<div class="hm-legend">${esc(legend)}</div>` : ""}</div>`;
  return html;
}
const BLOCKS: Record<string, (src: string) => string> = { heatmap: renderHeatmap };

function mdToHtml(md: string): string {
  const e = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inl = (s: string) =>
    e(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, h) => { const href = safeHref(h); return href === null ? `[${t}](${h})` : `<a href="${href}"${/^https?:/i.test(href) ? ' target="_blank" rel="noopener"' : ""}>${t}</a>`; })
      .replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (_m, pre, u) => { let tl = ""; const mt = u.match(/[.,;:)\]]+$/); if (mt) { tl = mt[0]; u = u.slice(0, -tl.length); } return `${pre}<a href="${attr(u)}" target="_blank" rel="noopener">${u}</a>${tl}`; });
  const L = md.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let n = 0;
  const cells = (r: string) => r.replace(/^\s*\|?|\|?\s*$/g, "").split("|").map((c) => c.trim());
  const cont = (s: string, nx: string) => !!s && !!s.trim() && !/^\s*([-*+]|\d+\.)\s+/.test(s) && !/^\s*(#{1,6}\s|>|```|---)/.test(s) && !(/\|/.test(s) && /^\s*\|?\s*:?-{2,}/.test(nx || ""));
  while (n < L.length) {
    const line = L[n];
    if (/^\s*```/.test(line)) {
      const lang = line.trim().slice(3).trim().toLowerCase();
      const buf: string[] = [];
      n++;
      while (n < L.length && !/^\s*```/.test(L[n])) { buf.push(L[n]); n++; }
      n++;
      out.push(lang && BLOCKS[lang] ? BLOCKS[lang](buf.join("\n")) : `<pre class="cb"><code>${e(buf.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { out.push("<hr>"); n++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const d = h[1].length; const id = "s-" + h[2].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 48); out.push(`<h${d}${d >= 2 && d <= 3 ? ` id="${id}"` : ""}>${inl(h[2])}</h${d}>`); n++; continue; }
    if (/^\s*>\s?/.test(line)) { const buf: string[] = []; while (n < L.length && /^\s*>\s?/.test(L[n])) { buf.push(L[n].replace(/^\s*>\s?/, "")); n++; } out.push(`<blockquote>${mdToHtml(buf.join("\n"))}</blockquote>`); continue; }
    if (/\|/.test(line) && n + 1 < L.length && /^\s*\|?\s*:?-{2,}/.test(L[n + 1])) {
      const head = line; const trows: string[] = []; n += 2;
      while (n < L.length && /\|/.test(L[n]) && L[n].trim()) { trows.push(L[n]); n++; }
      let t = `<table><thead><tr>${cells(head).map((c) => `<th>${inl(c)}</th>`).join("")}</tr></thead><tbody>`;
      trows.forEach((r) => { t += `<tr>${cells(r).map((c) => `<td>${inl(c)}</td>`).join("")}</tr>`; });
      out.push(`<div class="tblw">${t}</tbody></table></div>`);
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) { const items: string[] = []; while (n < L.length && /^\s*[-*+]\s+/.test(L[n])) { let txt = L[n].replace(/^\s*[-*+]\s+/, ""); n++; while (n < L.length && cont(L[n], L[n + 1])) { txt += " " + L[n].trim(); n++; } items.push(`<li>${inl(txt)}</li>`); } out.push(`<ul>${items.join("")}</ul>`); continue; }
    if (/^\s*\d+\.\s+/.test(line)) { const items: string[] = []; while (n < L.length && /^\s*\d+\.\s+/.test(L[n])) { let txt = L[n].replace(/^\s*\d+\.\s+/, ""); n++; while (n < L.length && cont(L[n], L[n + 1])) { txt += " " + L[n].trim(); n++; } items.push(`<li>${inl(txt)}</li>`); } out.push(`<ol>${items.join("")}</ol>`); continue; }
    if (!line.trim()) { n++; continue; }
    const buf = [line]; n++;
    while (n < L.length && L[n].trim() && !/^\s*(#{1,6}\s|>|[-*+]\s|\d+\.\s|```|---)/.test(L[n]) && !(/\|/.test(L[n]) && /^\s*\|?\s*:?-{2,}/.test(L[n + 1] || ""))) { buf.push(L[n]); n++; }
    out.push(`<p>${inl(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}

function reportChrome(md: string): { card: string; rest: string } {
  const inl = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>");
  const lines = md.replace(/\r/g, "").split("\n");
  let n = 0;
  let title: string | null = null;
  let kicker: string | null = null;
  const rows: Array<[string, string]> = [];
  if (/^#\s+/.test(lines[0] || "")) { title = lines[0].replace(/^#\s+/, ""); n = 1; }
  while (n < lines.length) {
    const ln = lines[n].trim();
    if (!ln) { n++; continue; }
    if (/^---+$/.test(ln)) { n++; break; }
    const m = ln.match(/^\*\*(.+?):\*\*\s*(.*)$/);
    if (m) { rows.push([m[1], m[2]]); n++; continue; }
    const k = ln.match(/^\*\*(.+?)\*\*$/);
    if (k && !kicker && !rows.length) { kicker = k[1]; n++; continue; }
    break;
  }
  if (!rows.length && !title) return { card: "", rest: md };
  let card = '<div class="rpt-head">';
  if (kicker) card += `<div class="rpt-kicker">${inl(kicker)}</div>`;
  if (title) card += `<h1 class="rpt-title">${inl(title)}</h1>`;
  if (rows.length) card += `<dl class="rpt-meta">${rows.map((r) => `<div><dt>${inl(r[0])}</dt><dd>${inl(r[1])}</dd></div>`).join("")}</dl>`;
  card += "</div>";
  return { card, rest: lines.slice(n).join("\n") };
}

function docToc(md: string): string {
  const heads: string[] = [];
  md.replace(/\r/g, "").split("\n").forEach((l) => { const m = l.match(/^##\s+(.+)$/); if (m) heads.push(m[1].trim()); });
  if (heads.length < 4) return "";
  const slug = (t: string) => "s-" + t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 48);
  return `<nav class="toc"><div class="toc-k">On this page</div><ul>${heads.map((h) => `<li><a href="#${slug(h)}">${esc(h)}</a></li>`).join("")}</ul></nav>`;
}

const CSS = `
:root{--bg:#fff;--ink:#252525;--muted:#6b6b6b;--border:#e8e8e8;--border-2:#d8d8d8;--oxblood:#8a2b28;--oxblood-soft:#faf3f2;--oxblood-line:#e6c9c6;--proof:#177f86;--proof-soft:#f0f8f8;--code-bg:#201b1a;--code-ink:#f3efee;--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
@media(prefers-color-scheme:dark){:root{--bg:#161311;--ink:#f0ece9;--muted:#a49c98;--border:#2c2725;--border-2:#3a3431;--oxblood:#d98a86;--oxblood-soft:#241a19;--oxblood-line:#4a302e;--proof:#6fc6cc;--proof-soft:#14201f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans)}
.doc{max-width:min(1000px,92vw);margin:40px auto;padding:0 24px;font-size:14.5px;line-height:1.62}
.doc h1{font-size:25px;font-weight:720;letter-spacing:-.02em;line-height:1.2;margin:2px 0 6px}
.doc h2{font-size:19px;font-weight:680;letter-spacing:-.01em;line-height:1.25;margin:30px 0 10px;padding-top:16px;border-top:1px solid var(--border)}
.doc hr + h2{border-top:0;padding-top:0;margin-top:18px}
.doc h3{font-size:16px;font-weight:660;margin:22px 0 8px;max-width:74ch}
.doc h4{font-size:13.5px;font-weight:660;margin:16px 0 6px;max-width:74ch}
.doc h5,.doc h6{font-size:12px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:14px 0 4px}
.doc p{margin:0 0 12px;max-width:74ch}.doc ul,.doc ol{margin:0 0 12px;padding-left:22px}.doc li{margin:0 0 6px;max-width:72ch}.doc li::marker{color:var(--muted)}
.doc a{color:var(--oxblood);text-underline-offset:2px}.doc strong{font-weight:680}
.doc code{font-family:var(--mono);font-size:.87em;background:#00000008;padding:1px 5px;border-radius:4px}
.doc pre.cb{background:var(--code-bg);color:var(--code-ink);border-radius:9px;padding:12px 14px;overflow-x:auto;margin:0 0 14px;font-size:12.5px;line-height:1.5}.doc pre.cb code{background:none;padding:0;color:inherit}
.doc blockquote{margin:0 0 14px;padding:11px 15px;background:var(--oxblood-soft);border:1px solid var(--oxblood-line);border-radius:9px}.doc blockquote p:last-child{margin-bottom:0}
.doc hr{border:0;border-top:1px solid var(--border);margin:24px 0}
.doc table{border-collapse:collapse;width:100%;margin:0;font-size:13px}.doc .tblw{overflow-x:auto;margin:0 0 16px}
.doc th,.doc td{border:1px solid var(--border);padding:7px 10px;text-align:left;vertical-align:top}.doc th{background:#00000006;font-weight:660;font-size:12px}.doc tbody tr:nth-child(even){background:#00000003}
.rpt-kicker{font-family:var(--mono);font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--oxblood);font-weight:700;margin-bottom:7px}
.rpt-title{font-size:26px;font-weight:720;letter-spacing:-.02em;line-height:1.18;margin:0 0 14px}
.rpt-meta{display:grid;gap:9px;border:1px solid var(--border);border-radius:10px;padding:13px 15px;background:#00000003;margin:0 0 6px}.rpt-meta>div{display:grid;grid-template-columns:120px 1fr;gap:12px;font-size:13px;line-height:1.5}.rpt-meta dt{font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:700}.rpt-meta dd{margin:0}
.toc{border:1px solid var(--border);border-radius:10px;padding:11px 15px;margin:16px 0 22px;background:#00000003}.toc-k{font-family:var(--mono);font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);font-weight:700;margin-bottom:7px}.toc ul{margin:0;padding:0;list-style:none;columns:2;column-gap:30px}.toc li{margin:0 0 4px;font-size:12.5px}.toc a{color:var(--oxblood);text-decoration:none}
.plainbox{background:var(--proof-soft);border:1px solid var(--proof-soft);border-radius:10px;padding:12px 15px;margin:2px 0 18px;font-size:14.5px;line-height:1.58}.plainbox .pb-k{font-family:var(--mono);font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--proof);font-weight:700;margin-bottom:5px}
.hmap{margin:0 0 16px;overflow-x:auto}.hmap .hm{display:table;width:auto;border-collapse:collapse;font-size:12.5px}.hmap .hm thead th{font-weight:600;font-size:11px;color:var(--muted);text-align:center;padding:7px 8px;vertical-align:bottom;line-height:1.2;min-width:94px;max-width:120px;white-space:normal}.hmap .hm thead th:first-child{min-width:0;text-align:left}.hmap .hm .hm-name{text-align:left;font-weight:600;padding:8px 16px 8px 4px;white-space:nowrap}.hmap .hm .hm-cell{text-align:center;padding:6px 8px}.hmap .hm .hb{color:var(--ink);vertical-align:middle}.hmap .hm-self{background:var(--oxblood-soft)}.hmap .hm-self .hm-name,.hmap .hm-self .hb{color:var(--oxblood)}.hmap .hm-tier td{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding:14px 4px 4px;font-weight:700}.hmap .hm-legend{font-size:11.5px;color:var(--muted);margin-top:10px}
`;

/** Render a research report markdown into a self-contained HTML page. */
export function renderReportHtml(md: string): string {
  const { card, rest } = reportChrome(md);
  const toc = docToc(rest);
  const body = mdToHtml(rest);
  const titleMatch = md.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].replace(/[`*]/g, "") : "Research report";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><article class="doc">${card}${toc}${body}</article></body></html>`;
}
