/**
 * tools/dedupe-articles.js  — SEKALI PAKAI
 *
 * 1. Cari artikel di content/<section>/ yang slug/keyword/judulnya mirip
 *    (memakai tools/lib/keyword-similarity.js).
 * 2. Per kelompok hanya SATU yang dipertahankan; sisanya dihapus.
 * 3. URL yang dihapus otomatis masuk ke static/redirects.js (format redirectMap).
 *
 * Yang dikerjakan --apply (selain menghapus file & menulis redirect):
 *   - Link internal [teks](/blog/yang-dihapus/) di SEMUA artikel diarahkan ke artikel yang dipertahankan
 *     (kalau ada di artikel pemenang itu sendiri -> jadi teks biasa, supaya tidak self-link).
 *   - Redirect lama yang menunjuk ke artikel terhapus di-repoint ke pemenang (tidak ada rantai).
 *   - Redirect lama yang source-nya adalah pemenang dibuang (mencegah loop).
 *   - Keyword artikel terhapus dimasukkan ke .excluded-keywords.json supaya generate-articles.js
 *     tidak membuatnya lagi.
 *
 * Cara memilih pemenang (berurutan): inbound link terbanyak -> isi terpanjang -> tanggal terlama.
 * Pengelompokan GREEDY terhadap pemenang (bukan transitif), jadi tidak ada efek "rantai" yang
 * menggabungkan topik yang sebenarnya berbeda.
 *
 * USAGE:
 *   node tools/dedupe-articles.js                  -> DRY-RUN (hanya laporan dedupe-report.json)
 *   node tools/dedupe-articles.js --apply          -> eksekusi
 *   --section=blog   --max-delete=40 (batas pengaman; apply dibatalkan jika melebihi)
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const KS   = require('./lib/keyword-similarity.js');

const ARGS       = process.argv.slice(2);
const APPLY      = ARGS.includes('--apply');
const arg        = (n, d) => { const a = ARGS.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const SECTION    = arg('section', 'blog');
const MAX_DELETE = parseInt(arg('max-delete', '40'), 10);
const ALGO_VERSION = 3; // harus sama dengan SIMILARITY_ALGO_VERSION di generate-articles.js (setelah patch)

const ROOT      = path.join(__dirname, '..');
const CONTENT   = path.join(ROOT, 'content');
const SEC_DIR   = path.join(CONTENT, SECTION);
const REDIRECTS = path.join(ROOT, 'static', 'redirects.js');
const EXCLUDED  = path.join(ROOT, '.excluded-keywords.json');
const REPORT    = path.join(ROOT, 'dedupe-report.json');

function walk(dir) {
  let out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(full));
    else if (e.name.endsWith('.md') && e.name !== '_index.md') out.push(full);
  }
  return out;
}
const toUrl = f => '/' + path.relative(CONTENT, f).replace(/\\/g, '/').replace(/\.md$/, '') + '/';

function parseFront(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const y = m[1];
  const get = k => {
    const r = y.match(new RegExp(`^${k}:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm')) || y.match(new RegExp(`^${k}:\\s*(.+?)\\s*$`, 'm'));
    return r ? r[1].replace(/\\"/g, '"').trim() : '';
  };
  return { title: get('title'), keyword: get('keywords'), date: get('date'), draft: /^draft:\s*true/m.test(y), body: m[2] || '' };
}

// ── 1. Muat artikel ──────────────────────────────────────────────────────────
const articles = [];
for (const file of walk(SEC_DIR)) {
  let p; try { p = parseFront(fs.readFileSync(file, 'utf8')); } catch { continue; }
  if (!p || !p.title || p.draft) continue;
  const slug = path.basename(file, '.md');
  articles.push({
    file, slug, url: toUrl(file), title: p.title, keyword: p.keyword, date: p.date || '9999',
    words: p.body.trim().split(/\s+/).length, body: p.body, inbound: 0,
    kw: KS.analyze(p.keyword || slug.replace(/-/g, ' ')),
    tt: KS.analyze(p.title),
  });
}
console.log(`\n📁 ${articles.length} artikel non-draft di content/${SECTION}/`);

const byUrl = new Map(articles.map(a => [a.url, a]));
for (const a of articles) {
  const seen = new Set();
  for (const m of a.body.matchAll(/(?<!!)\[[^\]]+\]\((\/[^)\s]+\/)\)/g)) {
    if (m[1] !== a.url && byUrl.has(m[1]) && !seen.has(m[1])) { seen.add(m[1]); byUrl.get(m[1]).inbound++; }
  }
}

// ── 2. Kelompokkan (greedy terhadap pemenang) ────────────────────────────────
const isDup = (a, b) => KS.isDuplicate(a.kw, b.kw) || KS.isDuplicate(a.tt, b.tt, { strict: true });
const ranked = [...articles].sort((a, b) => b.inbound - a.inbound || b.words - a.words || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
const used = new Set(), clusters = [];
for (const seed of ranked) {
  if (used.has(seed.url)) continue;
  used.add(seed.url);
  const losers = [];
  for (const o of ranked) if (!used.has(o.url) && isDup(seed, o)) { losers.push(o); used.add(o.url); }
  if (losers.length) clusters.push({ winner: seed, losers });
}
const totalLosers = clusters.reduce((n, c) => n + c.losers.length, 0);

console.log(`🔗 ${clusters.length} kelompok mirip, ${totalLosers} artikel akan dihapus.\n`);
for (const c of clusters) {
  console.log(`✅ PERTAHANKAN  ${c.winner.url}  (inbound ${c.winner.inbound}, ${c.winner.words} kata)\n   "${c.winner.title}"`);
  for (const l of c.losers) console.log(`   ❌ hapus  ${l.url}  (inbound ${l.inbound}, ${l.words} kata)\n      "${l.title}"`);
  console.log('');
}

const brief = a => ({ url: a.url, title: a.title, keyword: a.keyword, words: a.words, inbound: a.inbound });
fs.writeFileSync(REPORT, JSON.stringify({
  generatedAt: new Date().toISOString(), mode: APPLY ? 'apply' : 'dry-run', section: SECTION,
  clusterCount: clusters.length, deleteCount: totalLosers,
  clusters: clusters.map(c => ({ keep: brief(c.winner), remove: c.losers.map(brief) })),
}, null, 2));
console.log(`📝 Laporan: dedupe-report.json`);

if (!APPLY) { console.log('\nℹ️  DRY-RUN — tidak ada file diubah. Jalankan dengan --apply untuk eksekusi.'); process.exit(0); }
if (!totalLosers) { console.log('\n✅ Tidak ada yang perlu dihapus.'); process.exit(0); }
if (totalLosers > MAX_DELETE) {
  console.error(`\n🛑 ${totalLosers} artikel akan dihapus, melebihi --max-delete=${MAX_DELETE}. Dibatalkan. Periksa laporan dulu, lalu naikkan batas bila memang sesuai.`);
  process.exit(1);
}

// ── 3. redirects.js ──────────────────────────────────────────────────────────
const DEFAULT_TAIL = [
  '(function () {',
  '    function getCurrentPath() {',
  '        // Ambil path + query string',
  '        let path = window.location.pathname + window.location.search;',
  "        path = path.replace(/\\/$/, '') || '/';",
  '        return path;',
  '    }',
  "    document.addEventListener('DOMContentLoaded', () => {",
  '        const currentPath = getCurrentPath();',
  "        const redirectUrl = redirectMap[currentPath] || ",
  "                            redirectMap[currentPath + '/'] || ",
  "                            redirectMap[currentPath.replace(/\\/$/, '')];",
  '        if (redirectUrl) {',
  "            console.log(`Redirecting from ${currentPath} to ${redirectUrl}`);",
  '            window.location.replace(window.location.origin + redirectUrl);',
  '        }',
  '    });',
  '})();',
  '',
].join('\n');

function loadRedirects() {
  if (!fs.existsSync(REDIRECTS)) return { head: '// Redirect Map\n', map: {}, tail: '\n' + DEFAULT_TAIL };
  const raw = fs.readFileSync(REDIRECTS, 'utf8');
  const start = raw.indexOf('const redirectMap = {');
  const end = start >= 0 ? raw.indexOf('};', start) : -1;
  if (start < 0 || end < 0) throw new Error('Format static/redirects.js tidak dikenali (const redirectMap = { ... }; tidak ditemukan).');
  const block = raw.slice(start + 'const redirectMap = {'.length, end).replace(/^\s*\/\/.*$/gm, '');
  const map = {};
  for (const m of block.matchAll(/(["'])(.+?)\1\s*:\s*(["'])(.*?)\3/g)) map[m[2]] = m[4];
  return { head: raw.slice(0, start), map, tail: raw.slice(end + 2) };
}

const redirect = loadRedirects();
const map = redirect.map;
const loserToWinner = new Map();
for (const c of clusters) for (const l of c.losers) loserToWinner.set(l.url, c.winner.url);
const winnerUrls = new Set(clusters.map(c => c.winner.url));

for (const [src, dst] of Object.entries(map)) if (loserToWinner.has(dst)) map[src] = loserToWinner.get(dst); // hindari rantai
for (const w of winnerUrls) delete map[w];                                                                    // hindari loop
for (const [l, w] of loserToWinner) map[l] = w;
for (const [src, dst] of Object.entries(map)) if (src === dst) delete map[src];

// ── 4. Perbaiki link internal ke artikel yang akan dihapus ──────────────────
let rewrittenFiles = 0, rewrittenLinks = 0;
const loserFiles = new Set(clusters.flatMap(c => c.losers.map(l => path.resolve(l.file))));
for (const file of walk(CONTENT)) {
  if (loserFiles.has(path.resolve(file))) continue;
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.includes('](/')) continue;
  const self = toUrl(file);
  let changed = false;
  const out = raw.replace(/(?<!!)\[([^\]]+)\]\((\/[^)\s]+\/)\)/g, (m, text, url) => {
    if (!loserToWinner.has(url)) return m;
    changed = true; rewrittenLinks++;
    const w = loserToWinner.get(url);
    return w === self ? text : `[${text}](${w})`;
  });
  if (changed) { fs.writeFileSync(file, out); rewrittenFiles++; }
}

// ── 5. Hapus file, tulis redirects.js, update exclude-list ──────────────────
for (const f of loserFiles) fs.unlinkSync(f);

fs.mkdirSync(path.dirname(REDIRECTS), { recursive: true });
const entries = Object.entries(map).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n');
fs.writeFileSync(REDIRECTS, `${redirect.head}const redirectMap = {\n${entries}\n};${redirect.tail}`);

let excluded = {};
try { excluded = JSON.parse(fs.readFileSync(EXCLUDED, 'utf8')); } catch {}
for (const c of clusters) for (const l of c.losers) {
  const key = (l.keyword || l.slug.replace(/-/g, ' ')).toLowerCase().trim();
  excluded[key] = {
    reason: 'merged duplicate (dedupe-articles.js)',
    matchedFile: path.basename(c.winner.file), matchedTitle: c.winner.title,
    taggedAt: new Date().toISOString(), algoVersion: ALGO_VERSION,
  };
}
fs.writeFileSync(EXCLUDED, JSON.stringify(excluded, null, 2));

console.log(`\n✅ SELESAI: ${totalLosers} artikel dihapus, ${rewrittenLinks} link internal di ${rewrittenFiles} file dialihkan,`);
console.log(`   redirects.js sekarang berisi ${Object.keys(map).length} entri.`);
