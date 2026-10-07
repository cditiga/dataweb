/**
 * tools/lib/keyword-similarity.js
 *
 * Deteksi keyword/artikel yang "sama topik" untuk generate-articles.js.
 *
 * Kenapa menggantikan logika lama (overlapSimilarity + isSimilarPair):
 *   1. Tidak ada stemming  -> "memasang" / "pemasangan" / "pasang" dianggap kata berbeda.
 *   2. Tidak ada kanonisasi ejaan -> "bondex" != "bondek", "wire mesh" != "wiremesh".
 *   3. Jaccard menghukum judul panjang -> keyword pendek vs judul panjang hampir tidak pernah lolos.
 *   4. Syarat "min. 3 kata sama" terlalu ketat untuk keyword 2-4 kata.
 *   5. Tahun (2026) dan kata-kata hiasan judul ("panduan lengkap", "benar", "tepat") ikut dihitung.
 *   6. Kata generik situs (beton, cor, dak, besi) dihitung sama berat dengan kata spesifik (bondek).
 *
 * Pendekatan baru: token ter-stem + bobot (generik = 0.4, spesifik = 1) + overlap coefficient
 * + pengecekan intent (multi-intent) + pengecekan angka/mutu (K225 != K300).
 */
'use strict';

const STOPWORDS = new Set([
  'jual','jasa','harga','sewa','beli','biaya','tukang','pasang',
  'di','ke','dari','untuk','dan','yang','dengan','atau','per','apa','itu','ini',
  'terbaik','berkualitas','gratis','ongkir','murah','terpercaya','terdekat','bagus',
  'professional','profesional','area','lokasi','wilayah','daerah','kota','kabupaten',
  'kecamatan','jabodetabek','anda','kami','material','konstruksi','desain','interior',
  'bangunan','bangun','apakah','pengertian','alternatif','panduan','lengkap','cara','tips',
  'mengenal','kenali','memilih','adalah','dalam','pada','juga','akan','bisa','dapat',
  'kuat','awet','tahan','lama','baik','jenis','macam','model','membuat','buat','minimalis',
  'terbaru','contoh','proses','sederhana',
  // tambahan v3: kata hiasan judul & kata tanya yang tidak membawa topik
  'benar','tepat','efisien','hasil','presisi','optimal','solusi','estimasi','berapa',
  'sendiri','lainnya','tahun','mulai','sampai','sesuai','standar','praktis','cepat','mudah',
  'langkah','tutorial','mitra','cdi','creative','design',
]);

// Kata topik yang sangat umum di situs ini: boleh cocok, tapi bobotnya kecil.
const GENERIC = new Set([
  'beton','cor','dak','besi','rumah','lantai','kolom','balok','bata','batu','pasir',
  'semen','ukur','lantai','bekisting','pondasi',
]);
const GENERIC_WEIGHT = 0.4;

// Ejaan/variasi yang dianggap kata yang sama + bentuk imbuhan yang tidak bisa ditebak aturan umum.
const MANUAL = {
  bondex:'bondek', bondeck:'bondek', bonde:'bondek',
  herbel:'hebel', hebal:'hebel',
  ngecor:'cor', mengecor:'cor', pengecoran:'cor', coran:'cor', ngecoran:'cor',
  pengecatan:'cat', mengecat:'cat',
  dipasang:'pasang', terpasang:'pasang', dibuat:'buat', dihitung:'hitung',
  dilepas:'lepas', dibuka:'buka', dibongkar:'bongkar',
};
const NO_STEM = new Set(['ringan','jalan','tangan','pasangan']);

function stem(w) {
  if (MANUAL[w]) return MANUAL[w];
  if (w.length < 6 || /\d/.test(w) || NO_STEM.has(w)) return w;
  let s = w, m;
  if      ((m = s.match(/^(meny|peny)([aiueo].*)$/))) s = 's' + m[2];
  else if ((m = s.match(/^(mem|pem)([aiueo].*)$/)))   s = 'p' + m[2];
  else if ((m = s.match(/^(men|pen)([aiueo].*)$/)))   s = 't' + m[2];
  else if ((m = s.match(/^(meng|peng)(.{4,})$/)))     s = m[2];
  else if ((m = s.match(/^(mem|pem|men|pen|ber|ter|per)(.{4,})$/))) s = m[2];
  else if ((m = s.match(/^ke(.{4,})an$/)))            s = m[1];
  const t = s.replace(/(kan|an|nya)$/, '');
  if (t.length >= 4) s = t;
  return MANUAL[s] || s;
}

function normalize(text) {
  return String(text || '').toLowerCase()
    .replace(/wire\s*mesh/g, 'wiremesh')
    .replace(/ready\s*mix/g, 'readymix')
    .replace(/dry\s*mix/g, 'drymix')
    .replace(/u\s*ditch/g, 'uditch')
    .replace(/\bfc\s*(\d+)/g, 'fc$1')
    .replace(/\bk\s*(\d{2,3})\b/g, 'k$1')
    .replace(/(\d)[.,](\d)/g, '$1$2')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const INTENTS = [
  ['harga',       /\b(harga|biaya|ongkos|tarif|upah|borongan|rab)\b/],
  ['definisi',    /\b(apa itu|apakah|pengertian|arti|definisi|adalah)\b/],
  ['hitung',      /\b(menghitung|hitungan|perhitungan|hitung|rumus|kalkulasi|kebutuhan)\b/],
  ['carabuat',    /\b(cara|memasang|pemasangan|dipasang|pasang|membuat|pembuatan|memperbaiki|mengatasi|merawat|perawatan|menyambung|tutorial)\b/],
  ['jenis',       /\b(jenis|macam|tipe|ragam|perbedaan|dibanding\w*|vs|bagus mana)\b/],
  ['ukuran',      /\b(ukuran|dimensi|kapasitas|tebal|panjang|lebar|tinggi)\b/],
  ['masalah',     /\b(penyebab|bocor|retak|rusak|solusi)\b/],
  ['rekomendasi', /\b(terbaik|rekomendasi|pilihan|memilih)\b/],
];

function analyze(text) {
  const norm = normalize(text);
  const topic = new Map();
  const nums = new Set();
  for (const raw of norm.split(' ')) {
    if (!raw) continue;
    if (/^(19|20)\d{2}$/.test(raw)) continue;           // tahun bukan topik
    if (/\d/.test(raw)) { nums.add(raw); topic.set(raw, 1); continue; }
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    const s = stem(raw);
    if (s.length < 3 || STOPWORDS.has(s)) continue;
    topic.set(s, GENERIC.has(s) ? GENERIC_WEIGHT : 1);
  }
  const intents = new Set(INTENTS.filter(([, re]) => re.test(norm)).map(([n]) => n));
  return { topic, nums, intents };
}

const sum = m => { let t = 0; for (const w of m.values()) t += w; return t; };
const intersects = (a, b) => [...a].some(x => b.has(x));

/**
 * a = keyword baru, b = keyword/judul artikel yang sudah ada (hasil analyze()).
 * opts.strict : dipakai untuk membandingkan dengan JUDUL (judul panjang & penuh hiasan) ->
 *               threshold lebih tinggi, intent diabaikan.
 */
function isDuplicate(a, b, opts = {}) {
  if (!a.topic.size || !b.topic.size) return false;

  // Mutu/angka berbeda (K225 vs K300, 0.75 vs 1.0) = topik berbeda.
  if (a.nums.size && b.nums.size && !intersects(a.nums, b.nums)) return false;

  // Intent berbeda total (mis. "harga" vs "definisi") = artikel berbeda.
  if (!opts.strict && a.intents.size && b.intents.size && !intersects(a.intents, b.intents)) return false;

  let wShared = 0;
  for (const [t, w] of a.topic) if (b.topic.has(t)) wShared += w;
  if (wShared < 1) return false;   // minimal 1 kata spesifik (atau 3 kata generik) yang sama

  // Topik 1 kata saja (mis. "bondek") terlalu luas: wajib intent sama di kedua sisi.
  if (Math.min(a.topic.size, b.topic.size) <= 1 && !opts.strict) {
    if (!(a.intents.size && b.intents.size && intersects(a.intents, b.intents))) return false;
  }

  const overlap = wShared / Math.min(sum(a.topic), sum(b.topic));
  const sameIntent = a.intents.size && b.intents.size && intersects(a.intents, b.intents);
  const threshold = opts.strict ? 0.75 : (sameIntent ? 0.5 : 0.6);
  return overlap >= threshold;
}

function compareKeywords(kwA, kwB) {
  return isDuplicate(analyze(kwA), analyze(kwB));
}

// items: [{ file, title, keyword }]  -> dipra-hitung SEKALI per run.
function buildPool(items) {
  return items.map(it => ({
    ...it,
    _kw:    it.keyword ? analyze(it.keyword) : null,
    _title: it.title   ? analyze(it.title)   : null,
  }));
}

function findSimilar(keyword, pool) {
  const a = analyze(keyword);
  for (const it of pool) {
    if (it._kw    && isDuplicate(a, it._kw))                  return it;
    if (it._title && isDuplicate(a, it._title, { strict: true })) return it;
  }
  return null;
}

module.exports = { analyze, isDuplicate, compareKeywords, buildPool, findSimilar, normalize, stem };
