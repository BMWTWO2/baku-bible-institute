// Class notes ("Dərs xülasələri") are content files in content/notes/*.md, committed to the repo,
// so they survive restarts (the SQLite DB is reseeded on every boot).
const fs = require('fs'); const path = require('path');
const DIR = path.join(__dirname, '..', 'content', 'notes');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// Inline: escape first, then **bold** and *italic*. No links or raw HTML.
const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
function render(md) {
  const out = []; let para = []; let list = null;
  const flushP = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const flushL = () => { if (list) { out.push('<ul>' + list.map(i => '<li>' + inline(i) + '</li>').join('') + '</ul>'); list = null; } };
  for (const raw of String(md).split(/\r?\n/)) {
    const line = raw.trim(); let m;
    if (!line) { flushP(); flushL(); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushP(); flushL(); const lvl = Math.min(4, m[1].length + 1); out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`); continue; }
    if ((m = line.match(/^[-*]\s+(.*)$/))) { flushP(); (list ||= []).push(m[1]); continue; }
    if (list) { list[list.length - 1] += ' ' + line; continue; }
    para.push(line);
  }
  flushP(); flushL(); return out.join('\n');
}
function parse(file) {
  const text = fs.readFileSync(file, 'utf8'); const meta = {}; let body = text;
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) { body = text.slice(m[0].length); for (const l of m[1].split(/\r?\n/)) { const i = l.indexOf(':'); if (i > 0) meta[l.slice(0, i).trim()] = l.slice(i + 1).trim(); } }
  const slug = path.basename(file, '.md');
  return { slug, title: meta.title || slug, title_az: meta.title_az || '', course: meta.course || '', date: meta.date || '', source: meta.source || '', body, html: render(body),
    excerpt: body.replace(/^#.*$/gm, '').replace(/[*_#>-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 220) };
}
function all() {
  let files = []; try { files = fs.readdirSync(DIR).filter(f => /^[a-z0-9-]+\.md$/.test(f)); } catch { return []; }
  return files.map(f => parse(path.join(DIR, f))).sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.title.localeCompare(b.title));
}
function get(slug) { if (!/^[a-z0-9-]+$/.test(String(slug))) return null; const f = path.join(DIR, slug + '.md'); return fs.existsSync(f) ? parse(f) : null; }
module.exports = { all, get, render, esc };
