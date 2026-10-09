/**
 * tools/dedupe-articles.js  — SEKALI PAKAI, penilaian oleh AI, eksekusi oleh script
 *
 * Alur 3 tahap:
 *   1. SCRIPT (offline)  : urutkan artikel dari yang terbaik (inbound link, panjang, umur), lalu untuk tiap
 *                          artikel "utama" cari KANDIDAT mirip secara longgar (lib/keyword-similarity.js).
 *   2. AI (Cloudflare)   : menilai kandidat mana yang benar-benar DUPLIKAT dari artikel utama
 *                          (topik + maksud pencarian sama). Keputusan disimpan di .dedupe-decisions.json
 *                          sehingga bisa dilanjutkan di run berikutnya (--limit per run).
 *   3. SCRIPT (--apply)  : memvalidasi keputusan AI, lalu hapus artikel, tulis static/redirects.js,
 *                          alihkan link internal, dan masukkan keyword ke .excluded-keywords.json.
 *
 * Pengaman: AI hanya boleh memilih dari kandidat yang ditawarkan; konflik keras (m2 vs m3, K225 vs K300,
 * 8mm vs 10mm) membatalkan keputusan AI; kelompok > --max-cluster dilewati; total hapus > --max-delete
 * dibatalkan; --apply menolak jika masih ada artikel yang belum dinilai (kecuali --allow-partial).
 *
 * USAGE:
 *   node tools/dedupe-articles.js --judge --limit=40     → AI menilai (dilanjutkan di run berikutnya)
 *   node tools/dedupe-articles.js                        → LAPORAN dari keputusan yang ada (tanpa AI)
 *   node tools/dedupe-articles.js --apply                → eksekusi
 *   opsi: --section=blog --max-delete=40 --max-cluster=8 --retry-errors --allow-partial
 *         --ai-only  (percaya AI saja; DEFAULT = konsensus: AI dan aturan kata harus sama-sama setuju)
 *   file manual (opsional, satu slug/URL per baris): .dedupe-approve.txt (setujui usulan AI yg disengketakan),
 *                                                    .dedupe-protect.txt (JANGAN pernah hapus)
 *         --mock-ai  (uji offline TANPA AI: memakai aturan kata sebagai "juri"; hanya untuk pengujian)
 *
 * REQUIRES (hanya --judge): CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (boleh multi-baris, berpasangan 1:1).
 */
'use strict';
const fs    = require('fs');
const path  = require('path');
const https = require('https');
const KS    = require('./lib/keyword-similarity.js');
const J     = require('./lib/dedupe-judge.js');
const PROMPTS = require('./prompts/dedupe-articles.json');

const ARGS = process.argv.slice(2);
const has  = f => ARGS.includes(f);
const arg  = (n, d) => { const a = ARGS.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const JUDGE = has('--judge'), APPLY = has('--apply'), MOCK = has('--mock-ai');
const RETRY = has('--retry-errors'), ALLOW_PARTIAL = has('--allow-partial');
const AI_ONLY = has('--ai-only'); // default: KONSENSUS (AI DAN aturan kata harus sama-sama setuju)
const SECTION = arg('section', 'blog');
const LIMIT = parseInt(arg('limit', '40'), 10);
const MAX_DELETE = parseInt(arg('max-delete', '40'), 10);
const MAX_CLUSTER = parseInt(arg('max-cluster', '8'), 10);
const MAX_CANDIDATES = 7;
const MIN_CAND_SCORE = 0.34;
const ALGO_VERSION = 4; // sama dengan SIMILARITY_ALGO_VERSION di generate-articles.js

const ROOT = path.join(__dirname, '..');
const CONTENT = path.join(ROOT, 'content');
const SEC_DIR = path.join(CONTENT, SECTION);
const REDIRECTS = path.join(ROOT, 'static', 'redirects.js');
const EXCLUDED = path.join(ROOT, '.excluded-keywords.json');
const DECISIONS = path.join(ROOT, '.dedupe-decisions.json');
const REPORT = path.join(ROOT, 'dedupe-report.json');
const APPROVE_FILE = path.join(ROOT, '.dedupe-approve.txt'); // slug/URL korban yang disetujui manual walau aturan kata tidak setuju
const PROTECT_FILE = path.join(ROOT, '.dedupe-protect.txt'); // slug/URL yang TIDAK BOLEH dihapus

if (JUDGE && APPLY) { console.error('Pilih salah satu: --judge ATAU --apply.'); process.exit(1); }

// ── Cloudflare Workers AI (salinan sendiri, pola sama dgn revise/fix-orphans) ─────────────
const parseTokens = raw => (raw || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
const CF = {
  IDS: parseTokens(process.env.CLOUDFLARE_ACCOUNT_ID), TOKENS: parseTokens(process.env.CLOUDFLARE_API_TOKEN),
  HOST: 'api.cloudflare.com', MODEL: '@cf/aisingapore/gemma-sea-lion-v4-27b-it',
};
let tokenIdx = 0;
const curToken = () => CF.TOKENS[tokenIdx] || '';
const curPath = () => `/client/v4/accounts/${CF.IDS[tokenIdx] || CF.IDS[0] || ''}/ai/v1/chat/completions`;
const rotate = () => { tokenIdx = (tokenIdx + 1) % CF.TOKENS.length; };

function httpPost(pathname, token, body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: CF.HOST, path: pathname, method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(d)); } catch { resolve(d); } return; }
        const e = new Error(`HTTP ${res.statusCode}: ${d.slice(0, 200)}`);
        e.isRateLimit = res.statusCode === 429;
        e.isAuthError = res.statusCode === 401 || res.statusCode === 403;
        e.retryAfterSec = res.headers['retry-after'] ? parseInt(res.headers['retry-after'], 10) : null;
        reject(e);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout ${timeoutMs / 1000}s`)));
    req.on('error', reject); req.write(body); req.end();
  });
}

async function callAI(messages, retries = 3) {
  const body = JSON.stringify({ model: CF.MODEL, messages, temperature: 0.1, max_tokens: 600 });
  let rotated = 0;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const r = await httpPost(curPath(), curToken(), body);
      const c = r?.choices?.[0]?.message?.content;
      if (!c) throw new Error('respons AI kosong');
      return c;
    } catch (err) {
      if (err.isRateLimit || err.isAuthError) {
        if (CF.TOKENS.length > 1 && rotated < CF.TOKENS.length - 1) { rotated++; rotate(); attempt--; continue; }
        if (err.isRateLimit && err.retryAfterSec && err.retryAfterSec <= 90 && attempt < retries) {
          await new Promise(r => setTimeout(r, err.retryAfterSec * 1000 + 500)); continue;
        }
        throw err;
      }
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, attempt * 3000));
    }
  }
}

// ── Muat artikel ─────────────────────────────────────────────────────────────
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

const articles = [];
for (const file of walk(SEC_DIR)) {
  let p; try { p = parseFront(fs.readFileSync(file, 'utf8')); } catch { continue; }
  if (!p || !p.title || p.draft) continue;
  const slug = path.basename(file, '.md');
  articles.push({
    file, slug, url: toUrl(file), title: p.title, keyword: p.keyword, date: p.date || '9999',
    words: p.body.trim().split(/\s+/).length, body: p.body, inbound: 0,
    excerpt: J.excerptOf(p.body), info: KS.analyzeArticle({ keyword: p.keyword, title: p.title, slug }),
  });
}
console.log(`\n📁 ${articles.length} artikel non-draft di content/${SECTION}/`);
const byUrl = new Map(articles.map(a => [a.url, a]));
for (const a of articles) {
  const seen = new Set();
  for (const m of a.body.matchAll(/(?<!!)\[[^\]]+\]\((\/[^)\s]+\/)\)/g))
    if (m[1] !== a.url && byUrl.has(m[1]) && !seen.has(m[1])) { seen.add(m[1]); byUrl.get(m[1]).inbound++; }
}
// Urutan "terbaik dulu": inbound link terbanyak → isi terpanjang → tanggal terlama. Yang pertama jadi PEMENANG.
const ranked = [...articles].sort((a, b) => b.inbound - a.inbound || b.words - a.words || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

// ── Keputusan (cache lintas-run) ─────────────────────────────────────────────
const DECISIONS_VERSION = 2; // v2 = format penilaian per-kandidat (OBJEK/MAKSUD/VONIS); keputusan v1 (prompt lama, terlalu longgar) dibuang
function loadDecisions() {
  try {
    const j = JSON.parse(fs.readFileSync(DECISIONS, 'utf8'));
    if (j.version !== DECISIONS_VERSION) { console.log('♻️  .dedupe-decisions.json versi lama dibuang (prompt penilaian diperbarui) — semua dinilai ulang.'); return {}; }
    return j.decisions || {};
  } catch { return {}; }
}
const readList = f => { try { return new Set(fs.readFileSync(f, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.startsWith('/') ? l : `/${SECTION}/${l.replace(/\.md$/, '')}/`)); } catch { return new Set(); } };
function saveDecisions(d) { fs.writeFileSync(DECISIONS, JSON.stringify({ version: DECISIONS_VERSION, updatedAt: new Date().toISOString(), decisions: d }, null, 1)); }
const decisions = loadDecisions();

function candidatesFor(seed, pool) {
  return pool.filter(o => o.url !== seed.url)
    .map(o => ({ o, s: Math.max(KS.candidateScore(seed.info.kw, o.info.kw), KS.candidateScore(seed.info.tt, o.info.tt)) }))
    .filter(x => x.s >= MIN_CAND_SCORE).sort((a, b) => b.s - a.s).slice(0, MAX_CANDIDATES).map(x => x.o);
}
// juri tiruan untuk pengujian offline
const mockJudge = (seed, cands) => ({ ids: cands.map((c, i) => KS.articlesDuplicate(seed.info, c.info) ? i + 1 : 0).filter(Boolean), reason: 'mock (aturan kata)' });

async function judgeOne(seed, cands) {
  if (MOCK) return mockJudge(seed, cands);
  const raw = await callAI(J.buildMessages(PROMPTS, seed, cands));
  return J.parseVerdict(raw, cands.length);
}

// ── Susun rencana (+ penilaian AI bila --judge) ──────────────────────────────
async function main() {
  if (JUDGE && !MOCK) {
    if (!CF.TOKENS.length || !CF.IDS.length) throw new Error('CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID belum diset (diperlukan untuk --judge).');
    if (CF.IDS.length > 1 && CF.IDS.length !== CF.TOKENS.length) console.warn('⚠️  Jumlah baris CLOUDFLARE_ACCOUNT_ID dan CLOUDFLARE_API_TOKEN tidak sama — pasangan bisa salah.');
  }

  const used = new Set(), allClusters = [], undecided = [], vetoed = [], disputed = [];
  const approved = readList(APPROVE_FILE), protectedUrls = readList(PROTECT_FILE);
  // Konfirmasi file manual terbaca (nama file harus persis .dedupe-approve.txt / .dedupe-protect.txt di root repo)
  const known = u => (byUrl.has(u) ? '' : ' (tidak ditemukan di content!)');
  console.log(`🛡️  ${protectedUrls.size} URL dilindungi (${path.basename(PROTECT_FILE)}${fs.existsSync(PROTECT_FILE) ? '' : ' — file TIDAK ada'}), ✅ ${approved.size} URL disetujui manual (${path.basename(APPROVE_FILE)}${fs.existsSync(APPROVE_FILE) ? '' : ' — file TIDAK ada'})`);
  for (const u of [...protectedUrls, ...approved]) if (!byUrl.has(u)) console.log(`   ⚠️  ${u}${known(u)}`);
  for (const u of protectedUrls) if (approved.has(u)) console.log(`   ⚠️  ${u} ada di KEDUA daftar — protect menang (tidak akan dihapus)`);
  let judged = 0, stop = false, stopReason = '';

  for (const seed of ranked) {
    if (used.has(seed.url)) continue;
    used.add(seed.url);
    let d = decisions[seed.url];
    if (d && d.error && JUDGE && RETRY) d = null;

    if (!d) {
      const pool = ranked.filter(o => !used.has(o.url));
      const cands = candidatesFor(seed, pool);
      if (!cands.length) d = { candidates: [], duplicates: [] };            // tidak perlu AI
      else if (JUDGE && !stop && judged < LIMIT) {
        process.stdout.write(`\r🤖 AI menilai ${judged + 1}/${LIMIT}: ${seed.slug.slice(0, 50).padEnd(50)}`);
        try {
          const v = await judgeOne(seed, cands);
          judged++;
          d = v.error
            ? { candidates: cands.map(c => c.url), duplicates: [], error: v.error, judgedAt: new Date().toISOString() }
            : { candidates: cands.map(c => c.url), duplicates: v.ids.map(i => cands[i - 1].url), reason: v.reason, judgedAt: new Date().toISOString() };
          decisions[seed.url] = d;
          if (judged % 5 === 0) saveDecisions(decisions);
        } catch (err) {
          stop = true; stopReason = err.isRateLimit ? 'rate limit (semua key)' : err.isAuthError ? 'auth error (semua pasangan)' : err.message;
          undecided.push(seed); continue;
        }
      } else { undecided.push(seed); continue; }
    }

    const losers = [];
    for (const u of d.duplicates || []) {
      const o = byUrl.get(u);
      if (!o || used.has(o.url)) continue;
      if (protectedUrls.has(o.url)) continue;                                                                    // dilindungi manual
      if (KS.hardConflict(seed.info.kw, o.info.kw)) { vetoed.push({ keep: seed.url, drop: o.url }); continue; } // veto script
      if (!AI_ONLY && !approved.has(o.url) && !KS.articlesDuplicate(seed.info, o.info)) {                         // konsensus
        disputed.push({ keep: seed.url, drop: o.url, aiReason: d.reason || '' }); continue;
      }
      losers.push({ ...o, reason: d.reason || '' }); used.add(o.url);
    }
    if (losers.length) allClusters.push({ winner: seed, losers, reason: d.reason || '' });
  }
  if (JUDGE) { saveDecisions(decisions); process.stdout.write('\n'); }

  const clusters = allClusters.filter(c => c.losers.length <= MAX_CLUSTER);
  const reviewClusters = allClusters.filter(c => c.losers.length > MAX_CLUSTER);
  const totalLosers = clusters.reduce((n, c) => n + c.losers.length, 0);
  const errors = Object.entries(decisions).filter(([, d]) => d.error);

  console.log(`\n🔗 ${clusters.length} kelompok duplikat, ${totalLosers} artikel akan dihapus.`);
  if (reviewClusters.length) console.log(`⚠️  ${reviewClusters.length} kelompok dilewati (> ${MAX_CLUSTER} artikel) — tinjau manual.`);
  if (disputed.length) console.log(`🤝 ${disputed.length} usulan AI TIDAK dieksekusi karena aturan kata tidak setuju (konsensus) — lihat "disputedAiOnly" di laporan; setujui manual lewat .dedupe-approve.txt bila memang benar.`);
  if (vetoed.length) console.log(`🛑 ${vetoed.length} keputusan AI dibatalkan script (konflik satuan/mutu/ukuran).`);
  if (errors.length) console.log(`⚠️  ${errors.length} penilaian gagal diparse (dianggap BUKAN duplikat). Ulangi dengan --judge --retry-errors.`);
  if (undecided.length) console.log(`⏳ ${undecided.length} artikel utama belum dinilai AI${stopReason ? ` (berhenti: ${stopReason})` : ''}. Jalankan --judge lagi.`);
  console.log('');
  for (const c of clusters) {
    console.log(`✅ PERTAHANKAN  ${c.winner.url}  (inbound ${c.winner.inbound}, ${c.winner.words} kata)\n   "${c.winner.title}"\n   💬 ${c.reason}`);
    for (const l of c.losers) console.log(`   ❌ hapus  ${l.url}  (inbound ${l.inbound}, ${l.words} kata)\n      "${l.title}"`);
    console.log('');
  }

  const brief = a => ({ url: a.url, title: a.title, keyword: a.keyword, words: a.words, inbound: a.inbound });
  fs.writeFileSync(REPORT, JSON.stringify({
    generatedAt: new Date().toISOString(), mode: APPLY ? 'apply' : JUDGE ? 'judge' : 'report', section: SECTION,
    clusterCount: clusters.length, deleteCount: totalLosers, undecidedSeeds: undecided.length, judgeErrors: errors.length,
    clusters: clusters.map(c => ({ keep: brief(c.winner), reason: c.reason, remove: c.losers.map(brief) })),
    skippedForManualReview: reviewClusters.map(c => ({ keep: brief(c.winner), reason: c.reason, remove: c.losers.map(brief) })),
    vetoedByScript: vetoed,
    disputedAiOnly: disputed,
  }, null, 2));
  console.log('📝 Laporan: dedupe-report.json');

  if (!APPLY) { console.log(JUDGE ? '\nℹ️  Selesai menilai. Ulangi --judge sampai tidak ada yang tertunda, lalu tinjau laporan, lalu --apply.' : '\nℹ️  LAPORAN saja — tidak ada file diubah.'); return; }

  // ── Guard sebelum eksekusi ──
  if (undecided.length && !ALLOW_PARTIAL) { console.error(`\n🛑 ${undecided.length} artikel utama belum dinilai AI. Selesaikan --judge dulu (atau pakai --allow-partial).`); process.exit(1); }
  if (!totalLosers) { console.log('\n✅ Tidak ada yang perlu dihapus.'); return; }
  if (totalLosers > MAX_DELETE) { console.error(`\n🛑 ${totalLosers} artikel akan dihapus, melebihi --max-delete=${MAX_DELETE}. Dibatalkan.`); process.exit(1); }
  execute(clusters, totalLosers);
}

// ── Eksekusi ─────────────────────────────────────────────────────────────────
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

function execute(clusters, totalLosers) {
  const redirect = loadRedirects(), map = redirect.map;
  const loserToWinner = new Map();
  for (const c of clusters) for (const l of c.losers) loserToWinner.set(l.url, c.winner.url);
  const winnerUrls = new Set(clusters.map(c => c.winner.url));

  for (const [src, dst] of Object.entries(map)) if (loserToWinner.has(dst)) map[src] = loserToWinner.get(dst); // hindari rantai
  for (const w of winnerUrls) delete map[w];                                                                    // hindari loop
  for (const [l, w] of loserToWinner) map[l] = w;
  for (const [src, dst] of Object.entries(map)) if (src === dst) delete map[src];

  let rewrittenFiles = 0, rewrittenLinks = 0;
  const loserFiles = new Set(clusters.flatMap(c => c.losers.map(l => path.resolve(l.file))));
  for (const file of walk(CONTENT)) {
    if (loserFiles.has(path.resolve(file))) continue;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.includes('](/')) continue;
    const self = toUrl(file); let changed = false;
    const out = raw.replace(/(?<!!)\[([^\]]+)\]\((\/[^)\s]+\/)\)/g, (m, text, url) => {
      if (!loserToWinner.has(url)) return m;
      changed = true; rewrittenLinks++;
      const w = loserToWinner.get(url);
      return w === self ? text : `[${text}](${w})`;
    });
    if (changed) { fs.writeFileSync(file, out); rewrittenFiles++; }
  }
  for (const f of loserFiles) fs.unlinkSync(f);

  fs.mkdirSync(path.dirname(REDIRECTS), { recursive: true });
  const entries = Object.entries(map).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n');
  fs.writeFileSync(REDIRECTS, `${redirect.head}const redirectMap = {\n${entries}\n};${redirect.tail}`);

  let excluded = {}; try { excluded = JSON.parse(fs.readFileSync(EXCLUDED, 'utf8')); } catch {}
  for (const c of clusters) for (const l of c.losers) {
    const key = (l.keyword || l.slug.replace(/-/g, ' ')).toLowerCase().trim();
    excluded[key] = { reason: 'merged duplicate (dedupe-articles.js, AI-judged)', matchedFile: path.basename(c.winner.file),
      matchedTitle: c.winner.title, taggedAt: new Date().toISOString(), algoVersion: ALGO_VERSION };
  }
  fs.writeFileSync(EXCLUDED, JSON.stringify(excluded, null, 2));

  console.log(`\n✅ SELESAI: ${totalLosers} artikel dihapus, ${rewrittenLinks} link internal di ${rewrittenFiles} file dialihkan,`);
  console.log(`   redirects.js sekarang berisi ${Object.keys(map).length} entri.`);
}

main().catch(err => { console.error('\n💥 Fatal error:', err.message); process.exit(1); });
