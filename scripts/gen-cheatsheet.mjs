#!/usr/bin/env node
// Render the deliberately small Markdown subset used by the quick reference.
// No remote assets, raw HTML, or JavaScript enter the printable document.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'docs/CHEATSHEET.md');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const output = path.join(root, 'docs/cheatsheet.html');
const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function inline(text) {
  const tokens = [];
  const token = html => `\u0000${tokens.push(html) - 1}\u0000`;
  let value = escape(text).replace(/`([^`]+)`/g, (_, code) => token(`<code>${code}</code>`));
  value = value.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_, label, href) => {
    if (/^(?:javascript|data|vbscript):/i.test(href)) throw new Error('Unsupported link scheme');
    return `<a href="${href}">${label}</a>`;
  }).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return value.replace(/\u0000(\d+)\u0000/g, (_, n) => tokens[Number(n)]);
}
const lines = readFileSync(source, 'utf8').split('\n');
const html = [];
for (let i = 0; i < lines.length;) {
  const line = lines[i];
  if (!line.trim()) { i++; continue; }
  if (line.startsWith('```')) {
    const code = [];
    for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i]);
    if (i === lines.length) throw new Error('Unclosed code fence');
    i++;
    html.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
  } else if (/^#{1,6} /.test(line)) {
    const [, marks, title] = line.match(/^(#{1,6}) (.*)$/);
    html.push(`<h${marks.length}>${inline(title)}</h${marks.length}>`); i++;
  } else if (line.startsWith('|')) {
    const rows = [];
    while (i < lines.length && lines[i].startsWith('|')) {
      rows.push(lines[i++].replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(s => s.trim().replace(/\\\|/g, '|')));
    }
    const [head, separator, ...body] = rows;
    if (!separator?.every(cell => /^:?-+:?$/.test(cell))) throw new Error('Table needs a header separator');
    html.push(`<div class="table-wrap"><table><thead><tr>${head.map(cell => `<th scope="col">${inline(cell)}</th>`).join('')}</tr></thead><tbody>${body.map(row => `<tr>${row.map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
  } else if (/^- /.test(line)) {
    const items = [];
    while (i < lines.length && /^- /.test(lines[i])) items.push(`<li>${inline(lines[i++].slice(2))}</li>`);
    html.push(`<ul>${items.join('')}</ul>`);
  } else {
    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !/^(?:#|```|\||- )/.test(lines[i])) paragraph.push(lines[i++]);
    html.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }
}
const rendered = `<!doctype html>
<!-- Generated from docs/CHEATSHEET.md by scripts/gen-cheatsheet.mjs. -->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>productfoo quick reference</title>
<style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#fff;color:#202124;font:17px/1.6 system-ui,sans-serif}main{max-width:900px;margin:auto;padding:40px 24px 64px}h1{font-size:2rem;line-height:1.2}h2{font-size:1.3rem;margin-top:2.4em}a{color:#164d8d;text-underline-offset:3px}a:focus-visible{outline:3px solid #164d8d;outline-offset:3px}code{font:0.9em ui-monospace,monospace;overflow-wrap:anywhere}pre{padding:16px;background:#f3f4f5;overflow:auto;border:1px solid #d9dcdf;border-radius:4px}pre code{overflow-wrap:normal}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;font-size:.95rem}th,td{border-bottom:1px solid #d9dcdf;text-align:left;vertical-align:top;padding:10px 12px}th{background:#f3f4f5}footer{overflow-wrap:anywhere;border-top:1px solid #d9dcdf;margin-top:40px;padding-top:16px;font-size:.85rem}@media(max-width:600px){main{padding:24px 16px}body{font-size:16px}th,td{padding:8px}}@media print{main{padding:0;max-width:none}body{font-size:10pt}h2{break-after:avoid}pre,table{break-inside:avoid}pre{white-space:pre-wrap}a{color:inherit}.table-wrap{overflow:visible}}
</style></head><body><main>
${html.join('\n')}
<footer>productfoo ${escape(version)} · Generated from the <a href="CHEATSHEET.md">Markdown quick reference</a>.<br>Current reference: <a href="https://github.com/rwo572/productfoo/blob/main/docs/CHEATSHEET.md">github.com/rwo572/productfoo/blob/main/docs/CHEATSHEET.md</a><br>Use your browser’s print command for a paper copy.</footer>
</main></body></html>
`;
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== rendered) { console.error('Printable cheatsheet is stale. Run node scripts/gen-cheatsheet.mjs.'); process.exit(1); }
  console.log('Printable cheatsheet is up to date.');
} else { writeFileSync(output, rendered); console.log('Generated docs/cheatsheet.html.'); }
