/**
 * tools/lib/keyword-similarity.js   (algoritma v4)
 *
 * Deteksi keyword/artikel yang "satu topik" untuk generate-articles.js & dedupe-articles.js.
 *
 * Perbaikan v4 terhadap v3 (false positive massal pada dry-run 508 artikel):
 *  - Angka/satuan (1, 3, m2, m3, 10mm) TIDAK lagi jadi kata topik; hanya dipakai sebagai penanda
 *    konflik (m2 != m3). Mutu/ukuran (k225, fc20, 3x3) jadi "variant": beda variant = beda artikel.
 *  - Kata intent/struktur (hitung, butuh, arti, borongan, begini, inilah, takaran, ...) bukan topik.
 *  - Judul dibandingkan dengan intent milik KEYWORD-nya (judul terlalu bising untuk deteksi intent).
 *  - Intent berbeda => bukan duplikat, di semua mode (termasuk judul).
 *  - Syarat kata spesifik bersama: min(2, jumlah kata spesifik terkecil). Satu kata saja yang sama
 *    (mis. "tangga", "meja", "kayu") tidak cukup.
 *  - Topik hanya 1 kata spesifik => intent di kedua sisi wajib ada & sama.
 *  - "Pembeda": kalau KEDUA sisi punya kata spesifik yang tidak dimiliki sisi lain (sliding vs anak),
 *    atau kata generik yang tidak dimiliki sisi lain (pondasi vs bata), bukan duplikat.
 *  - beton == cor (sinonim di domain ini); bongkar/buka/lepas disatukan.
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
  'benar','tepat','efisien','hasil','presisi','optimal','solusi','estimasi','berapa',
  'sendiri','lainnya','tahun','mulai','sampai','sesuai','standar','praktis','cepat','mudah',
  'langkah','tutorial','mitra','cdi','creative','design',
  // v4: kata intent / struktur judul — bukan topik
  'arti','hitung','butuh','takar','borongan','upah','rab','begini','inilah','beberapa','berikut',
  'akurat','ciri','lebih','kurang','fungsi','manfaat','unggul','beda','banding','sebab','penyebab',
  'rekomendasi','tahap','daftar','terlengkap','kenapa','alasan','pilih','pilihan','kelebihan',
  'kekurangan','keunggulan','perbedaan','perbandingan','tahapan','kebutuhan',
  // v4: satuan
  'meter','segi','persegi','kilo','kg','gram','liter','buah','lembar','batang','unit','pcs','permeter',
]);

// Kata topik yang sangat umum di situs ini: boleh cocok, bobotnya kecil.
const GENERIC = new Set([
  'cor','dak','besi','rumah','lantai','kolom','balok','bata','batu','pasir','semen','ukur',
  'bekisting','pondasi',
]);
const GENERIC_WEIGHT = 0.4;

const MANUAL = {
  bondex:'bondek', bondeck:'bondek', bonde:'bondek',
  herbel:'hebel', hebal:'hebel',
  beton:'cor', ngecor:'cor', mengecor:'cor', pengecoran:'cor', coran:'cor', ngecoran:'cor',
  pengecatan:'cat', mengecat:'cat',
  bongkar:'buka', dibongkar:'buka', lepas:'buka', dilepas:'buka', dibuka:'buka',
  dipasang:'pasang', terpasang:'pasang', dibuat:'buat', dihitung:'hitung',
};
const NO_STEM = new Set(['ringan','jalan','tangan','pasangan']);
const VARIANT = /^(k|fc)\d+$|^\d+x\d+$|^\d+(mm|cm|kg|ton)$/;

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

// Multi-intent. "cara" saja (tanpa kata kerja) hanya jadi 'carabuat' bila tidak ada intent lain.
const INTENTS = [
  ['harga',    /\b(harga|biaya|ongkos|tarif|upah|borongan|rab)\b/],
  ['definisi', /\b(apa itu|apakah|pengertian|arti|definisi|adalah)\b/],
  ['hitung',   /\b(menghitung|hitungan|perhitungan|hitung|rumus|kalkulasi|kebutuhan|takaran|analisa)\b/],
  ['carabuat', /\b(memasang|pemasangan|dipasang|cara pasang|membuat|pembuatan|memperbaiki|mengatasi|merawat|perawatan|menyambung|mengecor|menambal|melapisi|finishing|tutorial)\b/],
  ['jenis',    /\b(jenis|macam|tipe|ragam|perbedaan|dibanding\w*|vs|bagus mana|perbandingan)\b/],
  ['ukuran',   /\b(ukuran|dimensi|kapasitas|tebal|panjang|lebar|tinggi)\b/],
  ['masalah',  /\b(penyebab|solusi)\b/],
  ['manfaat',  /\b(kelebihan|kekurangan|manfaat|fungsi|keunggulan|ciri|ciri ciri)\b/],
  ['waktu',    /\b(berapa lama|berapa hari|berapa jam|kapan)\b/],
  ['ukuran',   /\bberapa (kubik|kg|kilo|m2|m3|meter|besar|banyak|ukuran|kapasitas)\b/],
  ['rekomendasi', /\b(terbaik|rekomendasi|pilihan|memilih)\b/],
];

function analyze(text) {
  const norm = normalize(text);
  const topic = new Map();
  const nums = new Set();
  for (const raw of norm.split(' ')) {
    if (!raw) continue;
    if (/^(19|20)\d{2}$/.test(raw)) continue;                 // tahun
    if (/^\d+$/.test(raw)) { nums.add(raw); continue; }       // angka polos: hanya penanda konflik
    if (VARIANT.test(raw)) { topic.set(raw, 1); continue; }   // k225, fc20, 3x3: variant
    if (/\d/.test(raw)) { nums.add(raw); continue; }          // m2, m3, 10mm: satuan
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    const s = stem(raw);
    if (s.length < 3 || STOPWORDS.has(s)) continue;
    topic.set(s, GENERIC.has(s) ? GENERIC_WEIGHT : 1);
  }
  let intents = new Set(INTENTS.filter(([, re]) => re.test(norm)).map(([n]) => n));
  if (!intents.size && /\bcara\b/.test(norm)) intents = new Set(['carabuat']);
  return { topic, nums, intents };
}

const sum = m => { let t = 0; for (const w of m.values()) t += w; return t; };
const intersects = (a, b) => [...a].some(x => b.has(x));

function isDuplicate(a, b, opts = {}) {
  if (!a.topic.size || !b.topic.size) return false;

  if (a.nums.size && b.nums.size && !intersects(a.nums, b.nums)) return false;               // m2 vs m3, 1 vs 3
  if (a.intents.size && b.intents.size && !intersects(a.intents, b.intents)) return false;   // intent beda

  const shared = [...a.topic.keys()].filter(t => b.topic.has(t));
  const onlyA  = [...a.topic.keys()].filter(t => !b.topic.has(t));
  const onlyB  = [...b.topic.keys()].filter(t => !a.topic.has(t));

  if (onlyA.some(t => VARIANT.test(t)) || onlyB.some(t => VARIANT.test(t))) return false;    // K225 vs (tanpa mutu)

  // Topik identik (mis. "biaya dak per meter" vs "biaya dak permeter")
  if (!onlyA.length && !onlyB.length) return true;

  const spec = m => [...m.entries()].filter(([, w]) => w === 1).length;
  const specA = spec(a.topic), specB = spec(b.topic);
  const sharedSpec = shared.filter(t => a.topic.get(t) === 1).length;
  const need = Math.min(2, specA, specB);
  if (sharedSpec < need) return false;

  const wShared = shared.reduce((n, t) => n + a.topic.get(t), 0);
  if (wShared < 0.8) return false;

  const sameIntent = a.intents.size && b.intents.size && intersects(a.intents, b.intents);
  // Topik 1 kata spesifik: wajib intent sama — kecuali topik yang lebih kecil (>=2 kata) terkandung penuh di yang lebih besar
  const contained = !onlyA.length || !onlyB.length;
  if (Math.min(specA, specB) <= 1 && !sameIntent && !(contained && Math.min(a.topic.size, b.topic.size) >= 2)) return false;

  // Pembeda di kedua sisi => artikel berbeda (sliding vs anak, pondasi vs bata)
  const isSpec = (m, t) => m.get(t) === 1;
  if (onlyA.some(t => isSpec(a.topic, t)) && onlyB.some(t => isSpec(b.topic, t))) return false;
  if (onlyA.some(t => !isSpec(a.topic, t)) && onlyB.some(t => !isSpec(b.topic, t))) return false;

  const overlap = wShared / Math.min(sum(a.topic), sum(b.topic));
  const threshold = opts.strict ? 0.75 : (sameIntent ? 0.5 : 0.6);
  return overlap >= threshold;
}

// Satu artikel = analisa keyword (atau slug) + analisa judul. Judul memakai intent milik keyword.
function analyzeArticle({ keyword, title, slug }) {
  const kw = analyze(keyword || (slug ? String(slug).replace(/-/g, ' ') : title));
  const tt = analyze(title || keyword || '');
  if (kw.intents.size) tt.intents = kw.intents;
  return { kw, tt };
}
function articlesDuplicate(A, B) {
  return isDuplicate(A.kw, B.kw) || isDuplicate(A.tt, B.tt, { strict: true });
}

// Konflik KERAS yang tidak boleh dilanggar siapa pun (termasuk AI): satuan beda (m2 vs m3),
// angka beda (1 vs 3), mutu/ukuran beda (K225 vs K300, 3x3, 8mm).
function hardConflict(a, b) {
  if (a.nums.size && b.nums.size && !intersects(a.nums, b.nums)) return true;
  const onlyA = [...a.topic.keys()].filter(t => !b.topic.has(t));
  const onlyB = [...b.topic.keys()].filter(t => !a.topic.has(t));
  return onlyA.some(t => VARIANT.test(t)) || onlyB.some(t => VARIANT.test(t));
}

// Skor kandidat LONGGAR (untuk menyaring sebelum dinilai AI). 0 = bukan kandidat.
function candidateScore(a, b) {
  if (!a.topic.size || !b.topic.size || hardConflict(a, b)) return 0;
  let w = 0;
  for (const [t, wt] of a.topic) if (b.topic.has(t)) w += wt;
  if (w < 1) return 0;                       // minimal 1 kata spesifik, atau 3 kata generik
  return w / Math.min(sum(a.topic), sum(b.topic));
}

function compareKeywords(kwA, kwB) { return isDuplicate(analyze(kwA), analyze(kwB)); }

// items: [{ file, title, keyword }]  -> dipra-hitung SEKALI per run.
function buildPool(items) {
  return items.map(it => ({ ...it, _info: analyzeArticle({ keyword: it.keyword, title: it.title }) }));
}

// keyword baru vs pool artikel yang sudah ada
function findSimilar(keyword, pool) {
  const a = analyze(keyword);
  for (const it of pool) {
    if (isDuplicate(a, it._info.kw)) return it;
    const t = { ...it._info.tt };
    if (a.intents.size) { /* intent keyword baru tetap dipakai untuk guard disjoint */ }
    if (isDuplicate(a, t, { strict: true })) return it;
  }
  return null;
}

module.exports = { hardConflict, candidateScore, analyze, analyzeArticle, articlesDuplicate, isDuplicate, compareKeywords, buildPool, findSimilar, normalize, stem };
