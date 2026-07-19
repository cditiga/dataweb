/**
 * dedup-lapis1.js
 *
 * LAPIS 1 SAJA — cari kandidat pasangan judul mirip pakai bigram (offline,
 * tidak butuh internet/API/token sama sekali). Hasilnya disimpan ke
 * `candidates.json`, dipakai oleh `dedup-lapis2.js` di langkah berikutnya.
 *
 * Kenapa dipisah dari Lapis 2: supaya bisa dijalankan sekali (~1 menit),
 * hasilnya PERMANEN tersimpan di file, dan Lapis 2 (yang butuh AI + rentan
 * timeout/rate-limit) bisa dijalankan berkali-kali secara bertahap tanpa
 * pernah mengulang Lapis 1.
 *
 * PAKAI:
 *   node dedup-lapis1.js
 *   node dedup-lapis1.js --candidate-threshold=0.55
 *   node dedup-lapis1.js --dir=content/blog
 *
 * Jalankan ulang KAPAN SAJA setelah ada artikel baru/berubah — akan generate
 * ulang candidates.json dari kondisi content/ terkini.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const matter = require('gray-matter');

const ARGS = process.argv.slice(2);
const CAND_THRESHOLD = parseFloat((ARGS.find(a => a.startsWith('--candidate-threshold=')) || '').replace('--candidate-threshold=', '')) || 0.55;
const DIR_ARG = (ARGS.find(a => a.startsWith('--dir=')) || '--dir=content').replace('--dir=', '');
const CONTENT_DIR = path.join(process.cwd(), DIR_ARG);
const CANDIDATES_FILE = path.join(process.cwd(), 'candidates.json');

const STOPWORDS = new Set([
  'jual', 'jasa', 'harga', 'sewa', 'beli', 'biaya', 'tukang', 'pasang',
  'di', 'ke', 'dari', 'untuk', 'dan', 'yang', 'dengan', 'atau', 'per',
  'terbaik', 'berkualitas', 'gratis', 'ongkir', 'murah', 'terpercaya',
  'terdekat', 'professional', 'profesional', 'area', 'lokasi', 'wilayah',
  'daerah', 'kota', 'kabupaten', 'kecamatan', 'jabodetabek', 'anda', 'kami',
]);

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}d`;
  return `${Math.floor(s / 60)}m${s % 60}d`;
}

function walk(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(walk(full));
    else if (entry.name.endsWith('.md') && entry.name !== '_index.md') results.push(full);
  }
  return results;
}
function toUrl(filePath) {
  return '/' + path.relative(CONTENT_DIR, filePath).replace(/\\/g, '/').replace(/\.md$/, '') + '/';
}
function toSection(filePath) {
  const rel = path.relative(CONTENT_DIR, filePath).replace(/\\/g, '/');
  return rel.split('/')[0] || '(root)';
}

function bigrams(str) {
  const s = str.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const g = [];
  for (let i = 0; i < s.length - 1; i++) g.push(s.substring(i, i + 2));
  return g;
}
function diceCoefficient(a, b) {
  const ga = bigrams(a), gb = bigrams(b);
  if (!ga.length || !gb.length) return 0;
  const mapA = new Map(); ga.forEach(g => mapA.set(g, (mapA.get(g) || 0) + 1));
  const mapB = new Map(); gb.forEach(g => mapB.set(g, (mapB.get(g) || 0) + 1));
  let inter = 0;
  for (const [g, c] of mapA) if (mapB.has(g)) inter += Math.min(c, mapB.get(g));
  return (2 * inter) / (ga.length + gb.length);
}
function significantWords(title) {
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
    .filter(w => w.length > 3 && !STOPWORDS.has(w));
}

function computeSignature(allMeta) {
  const h = crypto.createHash('sha256');
  const sorted = allMeta.map(a => `${a.url}|${a.title}|${a.date || ''}`).sort();
  sorted.forEach(s => h.update(s + '\n'));
  h.update(`cand=${CAND_THRESHOLD}`);
  return h.digest('hex');
}

function main() {
  const t0 = Date.now();
  console.log(`\n🔍 LAPIS 1 — cari kandidat judul mirip (offline, tanpa AI)`);
  console.log(`   Direktori   : ${CONTENT_DIR}`);
  console.log(`   Threshold   : ${(CAND_THRESHOLD * 100).toFixed(0)}%`);
  console.log(`${'─'.repeat(60)}\n`);

  const files = walk(CONTENT_DIR);
  const allMeta = [];
  const articles = [];
  for (const f of files) {
    let parsed;
    try { parsed = matter(fs.readFileSync(f, 'utf8')); }
    catch { console.warn(`⚠️  Lewati (gagal parse): ${f}`); continue; }
    const title = (parsed.data.title || '').toString().trim();
    if (!title) continue;
    const date = parsed.data.date ? new Date(parsed.data.date).toISOString() : null;
    const url = toUrl(f);
    allMeta.push({ url, title, date });
    if (parsed.data.draft === true) continue;
    articles.push({ url, title, date, section: toSection(f), wordCount: (parsed.content || '').trim().split(/\s+/).length });
  }
  console.log(`📁 ${articles.length} artikel non-draft (dari total ${allMeta.length} file).\n`);
  if (articles.length < 2) { console.log('Tidak cukup artikel. Selesai.'); return; }

  const bySection = new Map();
  articles.forEach((art, i) => {
    if (!bySection.has(art.section)) bySection.set(art.section, []);
    bySection.get(art.section).push(i);
  });
  console.log(`📂 ${bySection.size} section terdeteksi.\n`);

  const candidatePairs = [];
  let processed = 0;
  for (const [section, idxs] of bySection) {
    processed++;
    if (idxs.length >= 2) {
      const wordIndex = new Map();
      idxs.forEach(i => {
        articles[i]._words = significantWords(articles[i].title);
        articles[i]._words.forEach(w => { if (!wordIndex.has(w)) wordIndex.set(w, []); wordIndex.get(w).push(i); });
      });
      const seen = new Set();
      idxs.forEach(i => {
        const candidates = new Set();
        articles[i]._words.forEach(w => (wordIndex.get(w) || []).forEach(j => { if (j > i) candidates.add(j); }));
        candidates.forEach(j => {
          const key = `${i}-${j}`;
          if (seen.has(key)) return;
          seen.add(key);
          const score = diceCoefficient(articles[i].title, articles[j].title);
          if (score >= CAND_THRESHOLD) {
            candidatePairs.push({ aUrl: articles[i].url, bUrl: articles[j].url, bigramScore: Math.round(score * 1000) / 1000 });
          }
        });
      });
    }
    process.stdout.write(`\r   ${processed}/${bySection.size} section diproses, ${candidatePairs.length} kandidat...   `);
  }
  console.log(`\n\n🔗 Selesai dalam ${fmtDuration(Date.now() - t0)}: ${candidatePairs.length} pasangan kandidat.\n`);

  // Cuma simpan judul yang benar-benar dipakai (hemat ukuran file + hemat kerja Lapis 2)
  const neededUrls = new Set(candidatePairs.flatMap(p => [p.aUrl, p.bUrl]));
  const titleMap = {};
  articles.forEach(a => { if (neededUrls.has(a.url)) titleMap[a.url] = { title: a.title, date: a.date, wordCount: a.wordCount }; });

  const out = {
    generatedAt: new Date().toISOString(),
    signature: computeSignature(allMeta),
    candidateThreshold: CAND_THRESHOLD,
    titles: titleMap,
    candidatePairs,
  };
  fs.writeFileSync(CANDIDATES_FILE, JSON.stringify(out));

  console.log(`💾 Tersimpan ke ${CANDIDATES_FILE}`);
  console.log(`   Judul unik yang perlu di-embed di Lapis 2 : ${neededUrls.size}`);
  console.log(`\n➡️  Lanjut jalankan: node dedup-lapis2.js --apply --limit=200`);
}

main();
