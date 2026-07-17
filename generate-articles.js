/**
 * generate-articles.js
 *
 * Mode:
 *   node generate-articles.js            → production (butuh GSC_CREDENTIALS + GITHUB_TOKEN)
 *   node generate-articles.js --dry-run  → test lokal (gunakan keyword dummy, skip API calls)
 *   node generate-articles.js --dry-run --keyword="harga kitchen set minimalis"
 */

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const crypto = require('crypto');

// ─── Mode ────────────────────────────────────────────────────────────────────
const IS_DRY_RUN   = process.argv.includes('--dry-run');
const CUSTOM_KW    = (process.argv.find(a => a.startsWith('--keyword=')) || '').replace('--keyword=', '');

// ─── Konfigurasi ─────────────────────────────────────────────────────────────
const CONFIG = {
  GSC_CREDENTIALS : (() => {
    try { return JSON.parse(process.env.GSC_CREDENTIALS || '{}'); } catch { return {}; }
  })(),
  GSC_SITE_URL    : process.env.GSC_SITE_URL || 'https://www.creativedesigninterior.com/',
  GITHUB_TOKEN    : process.env.GITHUB_TOKEN || '',

  // Endpoint lama (models.inference.ai.azure.com) resmi dimatikan GitHub
  // sejak 17 Oktober 2025. Endpoint aktif sekarang: models.github.ai
  MODELS_API_HOST : 'models.github.ai',
  MODELS_API_PATH : '/inference/chat/completions',
  API_VERSION     : '2022-11-28',
  AI_MODEL        : 'openai/gpt-4o', // format wajib "vendor/nama-model" di endpoint baru

  CONTENT_DIR     : path.join(__dirname, 'content', 'blog'),
  IMAGES_DIR      : path.join(__dirname, 'static', 'images'),

  // Filter GSC
  MIN_IMPRESSIONS : 5,
  MAX_POSITION    : 20,
  MAX_ARTICLES    : 3,
  DATE_RANGE_DAYS : 90,

  // Site info — sesuai config.toml
  SITE_NAME       : 'Creative Design Interior',
  SITE_URL        : 'https://www.creativedesigninterior.com/',
  AUTHOR          : 'Ibnu Koesnady',
  SITE_TITLE      : 'Creative Design Interior | Jasa Kitchen Set dan Furniture Interior',

  // Schema defaults dari config.toml
  BASE_PRICE      : 850000,
  PRICE_MAX       : 3850000,
  SITE_RATING     : '4.8',
  RATING_COUNT    : '247',
  POSTAL_CODE     : '16680',
  PHONE           : '0857-7678-6091',
  ADDRESS         : 'Jl. Sersan Muhtar Dramaga, Bogor – Jabar',

  // Keyword dummy untuk dry-run
  DRY_RUN_KEYWORDS: [
    { keyword: 'harga kitchen set minimalis', impressions: 68, clicks: 2, ctr: 0.029, position: 8.3  },
    { keyword: 'jasa pasang keramik lantai',  impressions: 45, clicks: 1, ctr: 0.022, position: 11.5 },
    { keyword: 'ukuran balok beton standar',  impressions: 32, clicks: 0, ctr: 0.0,   position: 6.1  },
  ],
};
// ─────────────────────────────────────────────────────────────────────────────

// ─── Helper: HTTP request ─────────────────────────────────────────────────────
function httpRequest(hostname, path, options, body = null, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, path, ...options };
    const req  = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else if (res.statusCode === 429) {
          const err = new Error(`Rate limited (429) ${hostname}${path}: ${data.slice(0, 200)}`);
          err.isRateLimit = true;
          err.retryAfterSec = res.headers['retry-after'] ? parseInt(res.headers['retry-after'], 10) : null;
          reject(err);
        } else {
          reject(new Error(`HTTP ${res.statusCode} ${hostname}${path}: ${data.slice(0, 200)}`));
        }
      });
    });
    // ⏱ Tanpa ini, 1 request yang macet bikin SELURUH proses (termasuk cron harian)
    // menggantung tanpa batas waktu dan tanpa pesan error apapun.
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout setelah ${timeoutMs/1000}d tanpa respons dari ${hostname}`)));
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── GSC: Access Token via Service Account JWT ───────────────────────────────
async function getGSCAccessToken() {
  const creds = CONFIG.GSC_CREDENTIALS;
  if (!creds.client_email || !creds.private_key) {
    throw new Error('GSC_CREDENTIALS tidak valid.');
  }
  const now     = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss  : creds.client_email,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud  : 'https://oauth2.googleapis.com/token',
    iat  : now, exp: now + 3600,
  })).toString('base64url');

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const jwt = `${header}.${payload}.${sign.sign(creds.private_key, 'base64url')}`;

  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const res  = await httpRequest('oauth2.googleapis.com', '/token', {
    method : 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  }, body);
  return res.access_token;
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Fetch keyword dari GSC ───────────────────────────────────────────────────
async function fetchKeywordsFromGSC() {
  if (IS_DRY_RUN) {
    const kws = CUSTOM_KW
      ? [{ keyword: CUSTOM_KW, impressions: 50, clicks: 1, ctr: 0.02, position: 9 }]
      : CONFIG.DRY_RUN_KEYWORDS;
    console.log(`🧪 DRY-RUN: Menggunakan ${kws.length} keyword dummy.`);
    return kws;
  }

  console.log('📊 Mengambil keyword dari Google Search Console...');
  const token   = await getGSCAccessToken();
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - CONFIG.DATE_RANGE_DAYS);
  const fmt = d => d.toISOString().split('T')[0];

  const body = JSON.stringify({
    startDate : fmt(startDate),
    endDate   : fmt(endDate),
    dimensions: ['query'],
    rowLimit  : 200,
  });

  const siteEnc = encodeURIComponent(CONFIG.GSC_SITE_URL);
  const result  = await httpRequest(
    'searchconsole.googleapis.com',
    `/webmasters/v3/sites/${siteEnc}/searchAnalytics/query`,
    {
      method : 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type' : 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    body
  );

  if (!result.rows?.length) { console.log('⚠️  Tidak ada data keyword.'); return []; }

  const filtered = result.rows
    .filter(r => r.impressions >= CONFIG.MIN_IMPRESSIONS && r.position <= CONFIG.MAX_POSITION)
    .map(r => ({ keyword: r.keys[0], impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, position: r.position }));

  console.log(`✅ ${filtered.length} keyword potensial dari ${result.rows.length} total.`);
  return filtered;
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Slug & existing articles ─────────────────────────────────────────────────
function toSlug(kw) {
  return kw.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-');
}

function getExistingSlugs() {
  if (!fs.existsSync(CONFIG.CONTENT_DIR)) {
    fs.mkdirSync(CONFIG.CONTENT_DIR, { recursive: true });
    return new Set();
  }
  const slugs = new Set();
  function scan(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
      if (e.isDirectory()) scan(path.join(dir, e.name));
      else if (e.name.endsWith('.md')) slugs.add(path.basename(e.name, '.md'));
    });
  }
  scan(CONFIG.CONTENT_DIR);
  return slugs;
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Pilih gambar: cocokkan minimal 2 kata keyword dengan nama file ───────────
function pickImage(keyword) {
  const imgDir = CONFIG.IMAGES_DIR;
  if (!fs.existsSync(imgDir)) return '/images/admin/featured-image.png';

  // Kumpulkan semua file gambar rekursif
  function getImages(dir) {
    let res = [];
    try {
      fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) res = res.concat(getImages(full));
        else if (/\.(jpg|jpeg|png|webp)$/i.test(e.name)) res.push(full);
      });
    } catch {}
    return res;
  }

  const allImages = getImages(imgDir);
  if (!allImages.length) return '/images/admin/featured-image.png';

  // Ambil kata bermakna (panjang > 3 karakter)
  const stopWords = new Set(['yang', 'untuk', 'dari', 'dengan', 'pada', 'dalam', 'atau', 'juga', 'adalah', 'cara', 'harga', 'ukuran', 'jenis']);
  const words = keyword.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !stopWords.has(w));

  // Score tiap gambar: hitung berapa kata keyword cocok dengan nama file
  const scored = allImages.map(img => {
    const name = path.basename(img).toLowerCase().replace(/[-_]/g, ' ');
    const matchCount = words.filter(w => name.includes(w)).length;
    return { img, matchCount };
  });

  // Filter minimal 2 kata cocok
  const good = scored.filter(s => s.matchCount >= 2);

  let chosen;
  if (good.length > 0) {
    // Pilih yang paling banyak cocok, jika seri ambil acak
    const maxMatch = Math.max(...good.map(s => s.matchCount));
    const best = good.filter(s => s.matchCount === maxMatch);
    chosen = best[Math.floor(Math.random() * best.length)].img;
    console.log(`   🖼️  Gambar cocok (${maxMatch} kata): ${path.basename(chosen)}`);
  } else {
    // Fallback: minimal 1 kata cocok
    const ok = scored.filter(s => s.matchCount >= 1);
    if (ok.length > 0) {
      chosen = ok[Math.floor(Math.random() * ok.length)].img;
      console.log(`   🖼️  Gambar fallback (1 kata): ${path.basename(chosen)}`);
    } else {
      // Total fallback: gambar acak
      chosen = allImages[Math.floor(Math.random() * allImages.length)];
      console.log(`   🖼️  Gambar acak (tidak ada yang cocok): ${path.basename(chosen)}`);
    }
  }

  return chosen.replace(path.join(__dirname, 'static'), '').replace(/\\/g, '/');
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Tentukan type artikel dari keyword ───────────────────────────────────────
function detectType(keyword) {
  const kl = keyword.toLowerCase();
  const serviceWords = ['jasa', 'layanan', 'sewa', 'rental', 'pasang', 'instalasi', 'bangun', 'renovasi', 'cor'];
  return serviceWords.some(w => kl.includes(w)) ? 'service' : 'product';
}

// ─── Tentukan categories dari keyword ─────────────────────────────────────────
function detectCategories(keyword) {
  const kl = keyword.toLowerCase();
  if (/kitchen|dapur|lemari|furniture|mebel|meja|kursi|tempat tidur/.test(kl)) return ['Furniture', 'Interior'];
  if (/pasir|batu|split|hebel|batako|bata|semen|material|bangunan/.test(kl)) return ['Material Bangunan'];
  if (/cor|pengecoran|beton|pondasi|lantai/.test(kl)) return ['Jasa Pengecoran'];
  if (/sewa|rental|pump|pompa/.test(kl)) return ['Sewa Alat'];
  if (/desain|interior|ruang|kamar/.test(kl)) return ['Desain Interior'];
  return ['Tips & Informasi'];
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Generate artikel via GitHub Models API ───────────────────────────────────
async function generateArticle(keyword) {
  const type = detectType(keyword);

  const prompt = `Kamu adalah penulis konten blog untuk website "${CONFIG.SITE_NAME}" — perusahaan jasa desain interior, furniture custom, material bangunan, dan jasa pengecoran di wilayah Jabodetabek.

Kamu menulis dengan GAYA KHAS blog ini:
- Sapaan audiens: "Mitra CDI" (bukan "Anda" atau "kamu") di awal artikel dan di beberapa paragraf
- Penulis menyebut diri sebagai "Kami" (bukan "Saya" atau "Saya pribadi")
- Gaya bahasa: hangat, akrab, conversational — seperti teman yang ahli di bidangnya
- Boleh pakai kata-kata informal sesekali: "gimana", "yuk", "nah", "lho", "nih"
- Paragraf pembuka WAJIB dimulai dengan: "**${keyword.split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ')}** - Mitra CDI dimana saja berada,"

KETENTUAN ARTIKEL:
- Keyword utama: "${keyword}"
- Panjang: 900–1100 kata
- Struktur: pembuka conversational → 3-4 H2 (masing-masing ada 2-3 paragraf) → penutup
- Setiap H2 mengandung variasi keyword atau kata kunci turunan
- Sisipkan 1 gambar inline di tengah artikel dengan format: ![deskripsi gambar](IMAGE_PLACEHOLDER)
  (IMAGE_PLACEHOLDER akan diganti otomatis oleh sistem)
- CTA di akhir: JANGAN tulis nomor telepon. Cukup tulis:
  "Silakan hubungi kami melalui tombol **Telepon** atau **WhatsApp** yang tersedia di bawah halaman ini."

Output HARUS dalam format berikut (tanpa teks tambahan apapun):
JUDUL: [judul artikel menarik, mengandung keyword, tanpa tanda #]
DESCRIPTION: [meta description 120–155 karakter, mengandung keyword, diawali keyword]
TAGS: [3–5 tag relevan, pisah koma]
ARTIKEL_MULAI
[isi artikel dalam Markdown, gunakan ## H2 dan ### H3]

PENTING: JANGAN tambahkan penanda, kata, atau baris apapun setelah artikel selesai
(misalnya jangan tulis "ARTIKEL_SELESAI", "SELESAI", "[END]", "---", atau sejenisnya).
Artikel berakhir begitu saja setelah kalimat penutup/CTA, tanpa penanda tambahan.`;

  if (IS_DRY_RUN) {
    console.log(`   🧪 DRY-RUN: Simulasi generate artikel untuk "${keyword}"...`);
    const kwTitle = keyword.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return `JUDUL: ${kwTitle} - Panduan Lengkap dari ${CONFIG.SITE_NAME}
DESCRIPTION: ${keyword.charAt(0).toUpperCase() + keyword.slice(1)} terbaik untuk hunian dan proyek konstruksi Anda. Temukan tips, harga, dan solusi dari ${CONFIG.SITE_NAME}.
TAGS: ${keyword.split(' ').slice(0, 3).join(', ')}, jasa interior bogor, CDI
ARTIKEL_MULAI
**${kwTitle}** - Mitra CDI dimana saja berada, salah satu pertanyaan yang sering kami terima adalah seputar ${keyword}. Nah, di artikel ini kami akan membahas tuntas hal tersebut buat Mitra semua. Yuk simak sampai selesai ya!

![${kwTitle}](IMAGE_PLACEHOLDER)

## Apa Itu ${kwTitle}?

Mitra CDI perlu tahu bahwa ${keyword} adalah salah satu elemen penting dalam dunia konstruksi dan desain interior modern. Di ${CONFIG.SITE_NAME}, kami sudah menangani ratusan proyek yang berkaitan dengan ${keyword} dan hasilnya selalu memuaskan klien kami.

Gimana caranya kami bisa memberikan hasil terbaik? Jawabannya ada pada pengalaman dan dedikasi tim kami yang sudah lebih dari 10 tahun berkecimpung di bidang ini.

## Keunggulan Layanan ${kwTitle} dari Kami

Nah, ini yang sering Mitra CDI tanyakan — apa bedanya layanan kami dengan yang lain? Berikut beberapa keunggulan yang bisa kami tawarkan:

- **Kualitas material terjamin** — kami hanya menggunakan bahan pilihan terbaik
- **Harga transparan** — tidak ada biaya tersembunyi, semua sudah termasuk dalam penawaran
- **Pengerjaan tepat waktu** — kami menghargai waktu Mitra sama seperti menghargai waktu kami sendiri
- **Garansi hasil pekerjaan** — kami berdiri di belakang setiap pekerjaan yang kami lakukan

## Tips Memilih Layanan ${kwTitle} yang Tepat

Mitra CDI harus cermat dalam memilih penyedia layanan ${keyword}. Berikut beberapa tips dari kami yang bisa membantu Mitra dalam mengambil keputusan yang tepat:

1. Pastikan penyedia jasa memiliki portofolio yang jelas dan bisa diverifikasi
2. Tanyakan tentang material yang digunakan — kualitas material sangat menentukan hasil akhir
3. Minta estimasi biaya tertulis agar tidak ada kesalahpahaman di kemudian hari
4. Cek ulasan dari pelanggan sebelumnya

## Penutup

Demikian pembahasan kami seputar ${keyword}. Kami berharap artikel ini bermanfaat buat Mitra CDI semua dalam mengambil keputusan terbaik untuk proyek hunian maupun konstruksi Mitra.

Kalau Mitra masih ada pertanyaan atau ingin konsultasi lebih lanjut, silakan hubungi kami melalui tombol **Telepon** atau **WhatsApp** yang tersedia di bawah halaman ini. Kami siap membantu!
`;
  }

  const body = JSON.stringify({
    model      : CONFIG.AI_MODEL,
    messages   : [
      { role: 'system', content: 'Kamu adalah penulis artikel SEO profesional berbahasa Indonesia.' },
      { role: 'user',   content: prompt },
    ],
    temperature: 0.72,
    max_tokens : 2800,
  });

  let result;
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      result = await httpRequest(
        CONFIG.MODELS_API_HOST,
        CONFIG.MODELS_API_PATH,
        {
          method : 'POST',
          headers: {
            'Authorization'       : `Bearer ${CONFIG.GITHUB_TOKEN}`,
            'Content-Type'        : 'application/json',
            'Accept'              : 'application/vnd.github+json',
            'X-GitHub-Api-Version': CONFIG.API_VERSION,
            'Content-Length'      : Buffer.byteLength(body),
          },
        },
        body
      );
      break;
    } catch (err) {
      if (err.isRateLimit) {
        if (err.retryAfterSec && err.retryAfterSec <= 90 && attempt < maxRetries) {
          console.log(`   ⏳ Rate limit, menunggu ${err.retryAfterSec}d...`);
          await new Promise(r => setTimeout(r, err.retryAfterSec * 1000 + 500));
          continue;
        }
        throw err;
      }
      if (attempt === maxRetries) throw err;
      const waitMs = attempt * 3000;
      console.log(`   ⚠️  Gagal (percobaan ${attempt}/${maxRetries}): ${err.message}. Coba lagi ${waitMs/1000}d...`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  return result.choices?.[0]?.message?.content || '';
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Escape string untuk dimasukkan ke YAML double-quoted ────────────────────
function yamlEscape(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Buang penanda "penutup" yang kadang tetap ditambahkan AI meski dilarang ──
// Prompt sudah eksplisit melarang ini, tapi LLM tidak selalu patuh 100% — jadi
// ini jaring pengaman di kode, bukan cuma mengandalkan instruksi prompt.
function stripTrailingMarkers(text) {
  const markerPatterns = [
    /^ARTIKEL[_\s]?SELESAI$/i,
    /^SELESAI$/i,
    /^\[?END\]?$/i,
    /^TAMAT$/i,
    /^---+$/,
    /^===+$/,
  ];
  const lines = text.split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  while (lines.length && markerPatterns.some(p => p.test(lines[lines.length - 1].trim()))) {
    lines.pop();
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  }
  return lines.join('\n');
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Parse output AI → simpan .md dengan front matter SEO lengkap ─────────────
function parseAndSave(raw, keyword, slug, imagePath) {
  const lines  = raw.split('\n');
  let title    = keyword.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  let desc     = '';
  let tags     = [keyword];
  let body     = '';
  let inBody   = false;

  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('JUDUL:'))        { title = t.replace('JUDUL:', '').trim(); continue; }
    if (t.startsWith('DESCRIPTION:'))  { desc  = t.replace('DESCRIPTION:', '').trim(); continue; }
    if (t.startsWith('CATEGORIES:'))   { /* diabaikan — selalu "blog" */ continue; }
    if (t.startsWith('TAGS:'))         { tags  = t.replace('TAGS:', '').trim().split(',').map(t => t.trim()); continue; }
    if (t === 'ARTIKEL_MULAI')         { inBody = true; continue; }
    if (inBody) body += line + '\n';
  }

  if (!body.trim()) body = raw;
  body = stripTrailingMarkers(body);

  // Ganti IMAGE_PLACEHOLDER dengan path gambar yang sudah dipilih
  body = body.replace(/IMAGE_PLACEHOLDER/g, imagePath);

  // Pastikan ada gambar inline di body — jika AI tidak menyertakan, sisipkan setelah paragraf pertama
  if (!body.includes('![')) {
    const paraEnd = body.indexOf('\n\n');
    if (paraEnd !== -1) {
      const imgMarkdown = `\n\n![${title}](${imagePath})\n`;
      body = body.slice(0, paraEnd) + imgMarkdown + body.slice(paraEnd);
    }
  }

  const today   = new Date().toISOString().split('T')[0];
  const type    = detectType(keyword);
  const tagToml = tags.map(t => `"${t}"`).join(', ');

  // Front matter sesuai artikel manual CDI:
  // - categories selalu ["blog"] sesuai artikel manual
  // - type: service (default untuk CDI)
  // - description diambil dari output AI
  const safeTitle = yamlEscape(title);
  const safeDesc  = yamlEscape(desc);
  const frontMatter = `---
title: "${safeTitle}"
date: "${today}"
categories:
 - "blog"
type: "${type}"
description: "${safeDesc}"
featured_image: "${imagePath}"
tags: [${tagToml}]
keywords: "${keyword}"
author: "${CONFIG.AUTHOR}"
toc: true
draft: false
---

`;

  const filePath = path.join(CONFIG.CONTENT_DIR, `${slug}.md`);

  if (IS_DRY_RUN) {
    const previewPath = path.join(__dirname, `DRY-RUN-${slug}.md`);
    fs.writeFileSync(previewPath, frontMatter + body.trim() + '\n');
    console.log(`   📄 DRY-RUN: Preview → ${previewPath}`);
    return previewPath;
  }

  fs.writeFileSync(filePath, frontMatter + body.trim() + '\n');
  console.log(`   💾 Artikel disimpan: ${filePath}`);
  return filePath;
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Validasi front matter hasil artikel ──────────────────────────────────────
function validateArticle(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const issues  = [];

  if (!content.includes('title:'))          issues.push('❌ title tidak ada');
  if (!content.includes('date:'))           issues.push('❌ date tidak ada');
  if (!content.includes('type:'))           issues.push('❌ type tidak ada (product/service)');
  if (!content.includes('description:'))    issues.push('❌ description tidak ada');
  if (!content.includes('featured_image:')) issues.push('❌ featured_image tidak ada');
  if (!content.includes('categories:'))     issues.push('❌ categories tidak ada');
  if (!content.includes('keywords:'))       issues.push('❌ keywords tidak ada');
  if (!content.includes('toc: true'))       issues.push('⚠️  toc tidak aktif');

  const wordCount = content.replace(/---[\s\S]*?---/, '').split(/\s+/).length;
  if (wordCount < 300) issues.push(`⚠️  Konten terlalu pendek: ${wordCount} kata`);

  if (issues.length === 0) {
    console.log(`   ✅ Validasi OK — ${wordCount} kata`);
  } else {
    console.log(`   ⚠️  Validasi ditemukan ${issues.length} masalah:`);
    issues.forEach(i => console.log(`      ${i}`));
  }
  return issues;
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🚀 Generate Articles ${IS_DRY_RUN ? '[DRY-RUN MODE]' : '[PRODUCTION]'}`);
  console.log(`${'─'.repeat(55)}\n`);

  if (!IS_DRY_RUN) {
    if (!CONFIG.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN tidak ditemukan.');
    if (!CONFIG.GSC_CREDENTIALS.client_email) throw new Error('GSC_CREDENTIALS tidak valid.');
  }

  const keywords     = await fetchKeywordsFromGSC();
  if (!keywords.length) { console.log('⚠️  Tidak ada keyword. Selesai.'); return; }

  const existingSlugs = getExistingSlugs();
  console.log(`\n📁 ${existingSlugs.size} artikel sudah ada di content/blog/`);

  const newKeywords = keywords.filter(k => !existingSlugs.has(toSlug(k.keyword)));
  if (!newKeywords.length) { console.log('✅ Semua keyword sudah punya artikel.'); return; }

  // Prioritas: impressi tinggi × CTR rendah
  newKeywords.sort((a, b) => (b.impressions * (1 - b.ctr)) - (a.impressions * (1 - a.ctr)));

  const toProcess = newKeywords.slice(0, IS_DRY_RUN ? newKeywords.length : CONFIG.MAX_ARTICLES);
  console.log(`\n📝 Akan generate ${toProcess.length} artikel:\n`);

  const results = [];

  for (const item of toProcess) {
    const slug = toSlug(item.keyword);
    console.log(`\n[${toProcess.indexOf(item) + 1}/${toProcess.length}] "${item.keyword}"`);
    console.log(`   📊 Impresi: ${item.impressions} | Posisi: ${item.position.toFixed(1)} | CTR: ${(item.ctr*100).toFixed(1)}%`);
    console.log(`   🔑 Slug: ${slug} | Type: ${detectType(item.keyword)}`);

    try {
      const imgPath  = pickImage(item.keyword);
      const raw      = await generateArticle(item.keyword);
      const filePath = parseAndSave(raw, item.keyword, slug, imgPath);
      const issues   = validateArticle(filePath);
      results.push({ keyword: item.keyword, slug, filePath, imgPath, issues });
    } catch (err) {
      console.error(`   ❌ Gagal: ${err.message}`);
    }

    if (!IS_DRY_RUN && toProcess.indexOf(item) < toProcess.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`\n${'─'.repeat(55)}`);
  console.log(`✅ Selesai: ${results.length} artikel di-generate\n`);
  results.forEach(r => {
    const status = r.issues.length === 0 ? '✅' : '⚠️ ';
    console.log(`  ${status} ${r.filePath}`);
  });

  if (!IS_DRY_RUN) {
    const logPath = path.join(__dirname, 'generated-articles.log');
    const entry   = results.map(r =>
      `${new Date().toISOString()} | ${r.keyword} | ${r.slug} | ${r.imgPath}`
    ).join('\n');
    fs.appendFileSync(logPath, entry + '\n');
  }
}

main().catch(err => {
  console.error('\n💥 Error fatal:', err.message);
  process.exit(1);
});
