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
function httpRequest(hostname, path, options, body = null) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, path, ...options };
    const req  = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else {
          reject(new Error(`HTTP ${res.statusCode} ${hostname}${path}: ${data.slice(0, 200)}`));
        }
      });
    });
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

  const prompt = `Kamu adalah penulis artikel SEO profesional berbahasa Indonesia untuk website "${CONFIG.SITE_NAME}" yang bergerak di bidang jasa interior, furniture, material bangunan, dan jasa pengecoran.

Tulis artikel SEO-friendly dalam bahasa Indonesia dengan ketentuan:
- Keyword utama: "${keyword}"
- Type konten: ${type === 'service' ? 'jasa/layanan' : 'produk/informasi'}
- Panjang: 900–1200 kata
- Struktur: paragraf pembuka → 3-4 bagian H2 → penutup + CTA
- Setiap H2 harus mengandung variasi keyword atau kata kunci turunan
- Paragraf pertama wajib mengandung keyword utama
- CTA di akhir: ajak hubungi via WhatsApp ke 0857-7678-6091
- Gaya: informatif, tidak kaku, hindari pengulangan kata berlebihan

Output HARUS dalam format berikut (tanpa penjelasan tambahan):
JUDUL: [judul artikel, tanpa tanda #]
DESCRIPTION: [meta description 120–155 karakter, mengandung keyword]
CATEGORIES: [kategori, pisah koma]
TAGS: [3–5 tag relevan, pisah koma]
ARTIKEL_MULAI
[isi artikel dalam Markdown, gunakan ## H2 dan ### H3]`;

  if (IS_DRY_RUN) {
    console.log(`   🧪 DRY-RUN: Simulasi generate artikel untuk "${keyword}"...`);
    // Return konten dummy yang realistis
    return `JUDUL: ${keyword.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')} - Panduan Lengkap
DESCRIPTION: Temukan informasi lengkap tentang ${keyword}. Dapatkan tips, harga, dan layanan terbaik dari ${CONFIG.SITE_NAME}.
CATEGORIES: ${detectCategories(keyword).join(', ')}
TAGS: ${keyword.split(' ').slice(0, 3).join(', ')}, jasa bogor, harga terbaik
ARTIKEL_MULAI
## Apa itu ${keyword}?

${keyword.charAt(0).toUpperCase() + keyword.slice(1)} adalah salah satu kebutuhan penting dalam dunia konstruksi dan interior modern. Di ${CONFIG.SITE_NAME}, kami menyediakan solusi terbaik untuk kebutuhan ${keyword} Anda dengan kualitas terjamin.

## Keunggulan Layanan Kami

Kami telah berpengalaman lebih dari 10 tahun dalam bidang ini. Berikut keunggulan yang kami tawarkan:

- **Kualitas terjamin** dengan bahan pilihan
- **Harga kompetitif** sesuai budget Anda  
- **Pengerjaan tepat waktu** oleh tim profesional
- **Garansi pekerjaan** untuk kepuasan Anda

## Harga ${keyword}

Harga layanan kami sangat kompetitif dan transparan. Tidak ada biaya tersembunyi. Hubungi kami untuk mendapatkan penawaran terbaik sesuai kebutuhan proyek Anda.

## Cara Pesan

Hubungi kami sekarang via WhatsApp di **0857-7678-6091** untuk konsultasi gratis dan dapatkan penawaran terbaik untuk ${keyword} di wilayah Jabodetabek.
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

  const result = await httpRequest(
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

  return result.choices?.[0]?.message?.content || '';
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Parse output AI → simpan .md dengan front matter SEO lengkap ─────────────
function parseAndSave(raw, keyword, slug, imagePath) {
  // Parse baris-baris header
  const lines  = raw.split('\n');
  let title    = keyword.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  let desc     = '';
  let cats     = detectCategories(keyword);
  let tags     = [keyword];
  let body     = '';
  let inBody   = false;

  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('JUDUL:'))        { title   = t.replace('JUDUL:', '').trim(); continue; }
    if (t.startsWith('DESCRIPTION:'))  { desc    = t.replace('DESCRIPTION:', '').trim(); continue; }
    if (t.startsWith('CATEGORIES:'))   { cats    = t.replace('CATEGORIES:', '').trim().split(',').map(c => c.trim()); continue; }
    if (t.startsWith('TAGS:'))         { tags    = t.replace('TAGS:', '').trim().split(',').map(t => t.trim()); continue; }
    if (t === 'ARTIKEL_MULAI')         { inBody  = true; continue; }
    if (inBody) body += line + '\n';
  }

  if (!body.trim()) body = raw; // fallback jika format AI tidak tepat

  const today    = new Date().toISOString().split('T')[0];
  const type     = detectType(keyword);
  const catToml  = cats.map(c => `"${c}"`).join(', ');
  const tagToml  = tags.map(t => `"${t}"`).join(', ');

  // Front matter lengkap sesuai head.html theme saeseen-hugo
  const frontMatter = `---
title: "${title.replace(/"/g, "'")}"
date: "${today}"
type: "${type}"
description: "${desc.replace(/"/g, "'")}"
featured_image: "${imagePath}"
categories: [${catToml}]
tags: [${tagToml}]
keywords: "${keyword}"
author: "${CONFIG.AUTHOR}"
toc: true
draft: false
---

`;

  const filePath = path.join(CONFIG.CONTENT_DIR, `${slug}.md`);

  if (IS_DRY_RUN) {
    // Dry-run: cetak ke console saja, tidak tulis file asli
    const previewPath = path.join(__dirname, `DRY-RUN-${slug}.md`);
    fs.writeFileSync(previewPath, frontMatter + body.trim() + '\n');
    console.log(`   📄 DRY-RUN: Preview disimpan di: ${previewPath}`);
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