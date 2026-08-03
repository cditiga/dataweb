/**
 * generate-articles.js
 *
 * Mode:
 *   node generate-articles.js            → production (requires GSC_CREDENTIALS + GITHUB_TOKEN)
 *   node generate-articles.js --dry-run  → local test (use dummy keywords, skip API calls)
 *   node generate-articles.js --dry-run --keyword="harga kitchen set minimalis"
 */

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const crypto = require('crypto');

// `sharp` is only required lazily inside resizeAndWatermark() — see getSharp() below.
// It used to be require()'d here at the top, which meant a missing/not-yet-installed
// `sharp` package crashed the ENTIRE script before anything ran — including keyword
// fetching and article generation, which don't need image processing at all. Now a
// missing `sharp` only disables the AI-image step (which already has its own
// try/catch fallback to the generic image); everything else keeps working normally.
function getSharp() {
  try {
    return require('sharp');
  } catch (err) {
    throw new Error(`'sharp' package not installed — run "npm install sharp" and commit the updated package.json/package-lock.json. (${err.message})`);
  }
}

// ─── Mode ────────────────────────────────────────────────────────────
const IS_DRY_RUN   = process.argv.includes('--dry-run');
const CUSTOM_KW    = (process.argv.find(a => a.startsWith('--keyword=')) || '').replace('--keyword=', '');

// ─── Configuration ───────────────────────────────────────────────────
const CONFIG = {
  GSC_CREDENTIALS : (() => {
    try { return JSON.parse(process.env.GSC_CREDENTIALS || '{}'); } catch { return {}; }
  })(),
  GSC_SITE_URL    : process.env.GSC_SITE_URL || 'https://www.creativedesigninterior.com/',
  GITHUB_TOKEN    : process.env.GITHUB_TOKEN || '',

  MODELS_API_HOST : 'models.github.ai',
  MODELS_API_PATH : '/inference/chat/completions',
  API_VERSION     : '2022-11-28',
  AI_MODEL        : 'openai/gpt-4o',

  CONTENT_DIR     : path.join(__dirname, 'content', 'blog'),
  IMAGES_DIR      : path.join(__dirname, 'static', 'images'),
  BLOG_IMAGES_DIR : path.join(__dirname, 'static', 'images', 'blog'),

  GEMINI_API_KEY   : process.env.GEMINI_API_KEY || '',
  GEMINI_API_HOST  : 'generativelanguage.googleapis.com',
  GEMINI_API_PATH  : '/v1beta/interactions',
  GEMINI_IMAGE_MODEL: 'gemini-3.1-flash-lite-image',

  // REQUIRED size for AI-generated images + watermark
  AI_IMAGE_WIDTH   : 600,
  AI_IMAGE_HEIGHT  : 400,
  WATERMARK_PATH   : path.join(__dirname, 'static', 'images', 'logo', 'watermark-cdi.png'),
  WATERMARK_OPACITY: 0.4,
  WATERMARK_WIDTH_RATIO: 0.42,

  // GSC filters
  MIN_IMPRESSIONS : 5,
  MAX_POSITION    : 20,
  MAX_ARTICLES    : 3,
  DATE_RANGE_DAYS : 90,

  // Site info — matching config.toml
  SITE_NAME       : 'Creative Design Interior',
  SITE_URL        : 'https://www.creativedesigninterior.com/',
  AUTHOR          : 'Ibnu Koesnady',
  SITE_TITLE      : 'Creative Design Interior | Jasa Kitchen Set dan Furniture Interior',

  // Schema defaults from config.toml
  BASE_PRICE      : 850000,
  PRICE_MAX       : 3850000,
  SITE_RATING     : '4.8',
  RATING_COUNT    : '247',
  POSTAL_CODE     : '16680',
  PHONE           : '0857-7678-6091',
  ADDRESS         : 'Jl. Sersan Muhtar Dramaga, Bogor – Jabar',

  // Dummy keywords for dry-run
  DRY_RUN_KEYWORDS: [
    { keyword: 'harga kitchen set minimalis', impressions: 68, clicks: 2, ctr: 0.029, position: 8.3  },
    { keyword: 'jasa pasang keramik lantai',  impressions: 45, clicks: 1, ctr: 0.022, position: 11.5 },
    { keyword: 'ukuran balok beton standar',  impressions: 32, clicks: 0, ctr: 0.0,   position: 6.1  },
  ],
};

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

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout after ${timeoutMs/1000}s without response from ${hostname}`)));
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function getGSCAccessToken() {
  const creds = CONFIG.GSC_CREDENTIALS;
  if (!creds.client_email || !creds.private_key) {
    throw new Error('Invalid GSC_CREDENTIALS.');
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

async function fetchKeywordsFromGSC() {
  if (IS_DRY_RUN) {
    const kws = CUSTOM_KW
      ? [{ keyword: CUSTOM_KW, impressions: 50, clicks: 1, ctr: 0.02, position: 9 }]
      : CONFIG.DRY_RUN_KEYWORDS;
    console.log(`🧪 DRY-RUN: Using ${kws.length} dummy keywords.`);
    return kws;
  }

  console.log('📊 Fetching keywords from Google Search Console...');
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

  if (!result.rows?.length) { console.log('⚠️  No keyword data.'); return []; }

  const filtered = result.rows
    .filter(r => r.impressions >= CONFIG.MIN_IMPRESSIONS && r.position <= CONFIG.MAX_POSITION)
    .filter(r => r.keys[0].trim().split(/\s+/).length >= 3) // at least 3 words — very short keywords are too generic/prone to overlap
    .map(r => ({ keyword: r.keys[0], impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, position: r.position }));

  console.log(`✅ ${filtered.length} potential keywords from ${result.rows.length} total.`);
  return filtered;
}

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

const EXCLUDED_KEYWORDS_FILE = path.join(__dirname, '.excluded-keywords.json');

const SIMILARITY_ALGO_VERSION = 2;

const SIMILARITY_STOPWORDS = new Set([
  'jual', 'jasa', 'harga', 'sewa', 'beli', 'biaya', 'tukang', 'pasang',
  'di', 'ke', 'dari', 'untuk', 'dan', 'yang', 'dengan', 'atau', 'per', 'apa', 'itu', 'ini',
  'terbaik', 'berkualitas', 'gratis', 'ongkir', 'murah', 'terpercaya', 'terdekat', 'bagus',
  'professional', 'profesional', 'area', 'lokasi', 'wilayah', 'daerah', 'kota', 'kabupaten',
  'kecamatan', 'jabodetabek', 'anda', 'kami', 'material', 'konstruksi', 'desain', 'interior',
  'bangunan', 'apakah', 'pengertian', 'alternatif', 'panduan', 'lengkap', 'cara', 'tips',
  'mengenal', 'kenali', 'memilih', 'adalah', 'dalam', 'pada', 'juga', 'akan', 'bisa', 'dapat',
  'kuat', 'awet', 'tahan', 'lama', 'baik', 'jenis', 'macam',
  'model', 'membuat', 'minimalis', 'terbaru', 'contoh', 'proses', 'sederhana',
]);

function significantWordsForSimilarity(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
    .filter(w => w.length > 2 && !SIMILARITY_STOPWORDS.has(w)); // length > 2 so short but important niche words like "cor" remain
}

function overlapSimilarity(a, b) {
  const wa = new Set(significantWordsForSimilarity(a));
  const wb = new Set(significantWordsForSimilarity(b));
  if (!wa.size || !wb.size) return { sharedCount: 0, jaccard: 0, minWords: 0 };
  const shared = [...wa].filter(w => wb.has(w));
  const union  = wa.size + wb.size - shared.length;
  return { sharedCount: shared.length, jaccard: shared.length / union, minWords: Math.min(wa.size, wb.size) };
}

function isSimilarPair(sharedCount, jaccard, minWords) {
  if (minWords === 0) return false;
  if (minWords <= 2) return sharedCount >= minWords && jaccard >= 0.55;
  return sharedCount >= 3 && jaccard >= 0.42;
}

const INTENT_PATTERNS = [
  ['harga',       /\b(harga|biaya|ongkos|tarif|upah|borongan)\b/i],
  ['definisi',    /\b(apa\s*itu|apakah|pengertian|maksud\s+dari|arti\s+dari)\b/i],
  ['hitung',      /\b(menghitung|hitungan|cara\s+hitung|rumus|kalkulasi)\b/i],
  ['carabuat',    /\b(cara\s+(membuat|memasang|mengatasi|memperbaiki|merawat|menyambung)|pemasangan|pembuatan)\b/i],
  ['jenis',       /\b(jenis|macam|tipe|ragam|perbedaan|dibanding(kan)?|vs)\b/i],
  ['ukuran',      /\b(ukuran|dimensi|kapasitas)\b/i],
  ['masalah',     /\b(penyebab|bocor|retak|rusak|solusi)\b/i],
  ['rekomendasi', /\b(terbaik|rekomendasi|pilihan|cara\s+memilih)\b/i],
];

function detectIntent(text) {
  const tl = text.toLowerCase();
  for (const [name, pattern] of INTENT_PATTERNS) {
    if (pattern.test(tl)) return name;
  }
  return null;
}

function getExistingArticleTexts() {
  const items = [];
  if (!fs.existsSync(CONFIG.CONTENT_DIR)) return items;
  function scan(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { scan(full); return; }
      if (!e.name.endsWith('.md')) return;
      try {
        const raw = fs.readFileSync(full, 'utf8');
        const titleMatch = raw.match(/^title:\s*"((?:[^"\\]|\\.)*)"/m);
        const kwMatch     = raw.match(/^keywords:\s*"((?:[^"\\]|\\.)*)"/m);
        if (titleMatch) items.push({ file: full, title: titleMatch[1], keyword: kwMatch ? kwMatch[1] : '' });
      } catch {}
    });
  }
  scan(CONFIG.CONTENT_DIR);
  return items;
}

function loadExcludedKeywords() {
  if (!fs.existsSync(EXCLUDED_KEYWORDS_FILE)) return {};
  let raw;
  try { raw = JSON.parse(fs.readFileSync(EXCLUDED_KEYWORDS_FILE, 'utf8')); } catch { return {}; }

  const active = {};
  let released = 0;
  for (const [key, entry] of Object.entries(raw)) {
    if (entry && entry.algoVersion === SIMILARITY_ALGO_VERSION) active[key] = entry;
    else released++;
  }
  if (released > 0) {
    console.log(`   ♻️  ${released} old keywords released from the exclude cache (similarity algorithm updated to v${SIMILARITY_ALGO_VERSION}) — they will be re-evaluated.`);
  }
  return active;
}
function saveExcludedKeywords(obj) {
  fs.writeFileSync(EXCLUDED_KEYWORDS_FILE, JSON.stringify(obj, null, 2));
}

const KEYWORDS_FILE = path.join(__dirname, 'keywords.txt');

function getKeywordsFromFile() {
  if (!fs.existsSync(KEYWORDS_FILE)) return [];
  return fs.readFileSync(KEYWORDS_FILE, 'utf8').split('\n')
    .map(l => l.trim()).filter(Boolean)
    .map(kw => ({ keyword: kw, impressions: 0, clicks: 0, ctr: 0, position: 0 }));
}

function removeProcessedKeywordsFromFile(processedKeywords) {
  if (!fs.existsSync(KEYWORDS_FILE) || !processedKeywords.length) return;
  const usedSet = new Set(processedKeywords.map(k => k.toLowerCase().trim()));
  const remaining = fs.readFileSync(KEYWORDS_FILE, 'utf8').split('\n')
    .map(l => l.trim())
    .filter(l => l && !usedSet.has(l.toLowerCase()));
  fs.writeFileSync(KEYWORDS_FILE, remaining.join('\n') + (remaining.length ? '\n' : ''));
}

function findSimilarExisting(keyword, existingItems) {
  const kwIntent = detectIntent(keyword);
  for (const item of existingItems) {
    const itemIntent = detectIntent(item.keyword || '') || detectIntent(item.title || '');
    const candidates = [item.keyword, item.title].filter(Boolean);
    for (const candidate of candidates) {
      const { sharedCount, jaccard, minWords } = overlapSimilarity(keyword, candidate);
      if (!isSimilarPair(sharedCount, jaccard, minWords)) continue;

      if (kwIntent && itemIntent && kwIntent !== itemIntent) continue;

      return item;
    }
  }
  return null;
}

function filterOutSimilarKeywords(keywords) {
  const excluded = loadExcludedKeywords();
  const existingItems = getExistingArticleTexts();
  const kept = [];
  let newlyExcluded = 0;

  for (const item of keywords) {
    const key = item.keyword.toLowerCase().trim();
    if (excluded[key]) continue;

    const similar = findSimilarExisting(item.keyword, existingItems);
    if (similar) {
      excluded[key] = {
        reason: 'similar to existing article',
        matchedFile: path.basename(similar.file),
        matchedTitle: similar.title,
        taggedAt: new Date().toISOString(),
        algoVersion: SIMILARITY_ALGO_VERSION,
      };
      newlyExcluded++;
      console.log(`   ⏭️  Skipping "${item.keyword}" — similar to existing article: "${similar.title}"`);
      continue;
    }
    kept.push(item);
  }

  if (newlyExcluded > 0) saveExcludedKeywords(excluded);
  console.log(`   🔎 ${newlyExcluded} new keywords marked excluded (similar to existing articles), ${Object.keys(excluded).length} total excluded so far.`);
  return kept;
}

async function pickImage(keyword, slug) {
  const imgDir = CONFIG.IMAGES_DIR;
  if (!fs.existsSync(imgDir)) return useGenericOrAIImage(keyword, slug);

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
  if (!allImages.length) return useGenericOrAIImage(keyword, slug);

  const stopWords = new Set(['yang', 'untuk', 'dari', 'dengan', 'pada', 'dalam', 'atau', 'juga', 'adalah', 'cara', 'harga', 'ukuran', 'jenis']);
  const words = keyword.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));

  const scored = allImages.map(img => {
    const name = path.basename(img).toLowerCase().replace(/[-_]/g, ' ');
    const matchCount = words.filter(w => name.includes(w)).length;
    return { img, matchCount };
  });

  const good = scored.filter(s => s.matchCount >= 2);

  if (good.length > 0) {

    const maxMatch = Math.max(...good.map(s => s.matchCount));
    const best = good.filter(s => s.matchCount === maxMatch);
    const chosen = best[Math.floor(Math.random() * best.length)].img;
    console.log(`   🖼️  Matching image (${maxMatch} words): ${path.basename(chosen)}`);
    return chosen.replace(path.join(__dirname, 'static'), '').replace(/\\/g, '/');
  }

  console.log(`   🖼️  No image with ≥2 matching words for "${keyword}" → attempting AI image generation...`);
  return useGenericOrAIImage(keyword, slug);
}

async function useGenericOrAIImage(keyword, slug) {
  const GENERIC = '/images/admin/featured-image.png';
  if (!CONFIG.GEMINI_API_KEY) {
    console.log(`   🖼️  GEMINI_API_KEY not set → using generic image.`);
    return GENERIC;
  }
  try {
    const aiPath = await generateAIImage(keyword, slug);
    if (aiPath) {
      console.log(`   🖼️  AI image generated & saved: ${aiPath}`);
      return aiPath;
    }
  } catch (err) {
    console.log(`   ⚠️  Failed to generate AI image (${err.message}) → using generic image.`);
  }
  return GENERIC;
}

function buildImagePrompt(keyword) {
  return `A photorealistic, high-resolution professional stock photograph illustrating the ` +
    `concept: "${keyword}" — an Indonesian construction materials / concrete-casting / home ` +
    `interior term, for a company called ${CONFIG.SITE_NAME}. Clean commercial product/site ` +
    `photography style, natural lighting, realistic textures and materials, shot on a ` +
    `construction site or in a well-lit interior/product setting as fits the subject. ` +
    `No text, no logos, no watermarks, no close-up human faces. Aspect ratio 3:2.`;
}

async function callGeminiImageAPI(prompt) {
  const body = JSON.stringify({
    model: CONFIG.GEMINI_IMAGE_MODEL,
    input: [{ type: 'text', text: prompt }],
    response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '3:2' },
  });

  let result;
  const maxRetries = 2;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      result = await httpRequest(
        CONFIG.GEMINI_API_HOST,
        CONFIG.GEMINI_API_PATH,
        {
          method : 'POST',
          headers: {
            'x-goog-api-key': CONFIG.GEMINI_API_KEY,
            'Content-Type'  : 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        body,
        90000 // image generation timeout
      );
      break;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const waitMs = attempt * 3000;
      console.log(`   ⚠️  Gemini image API failed (attempt ${attempt}/${maxRetries}): ${err.message}. Retrying in ${waitMs/1000}s...`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  if (result?.output_image?.data) {
    return { data: result.output_image.data, mimeType: result.output_image.mime_type || 'image/jpeg' };
  }
  for (const step of result?.steps || []) {
    if (step.type !== 'model_output') continue;
    for (const block of step.content || []) {
      if (block.type === 'image' && block.data) {
        return { data: block.data, mimeType: block.mime_type || 'image/jpeg' };
      }
    }
  }
  throw new Error('Gemini response did not contain an image (check quota/model/API key).');
}

async function resizeAndWatermark(imageBuffer) {
  const sharp = getSharp();

  const resized = await sharp(imageBuffer)
    .resize(CONFIG.AI_IMAGE_WIDTH, CONFIG.AI_IMAGE_HEIGHT, { fit: 'cover', position: 'centre' })
    .toBuffer();

  if (!fs.existsSync(CONFIG.WATERMARK_PATH)) {
    console.log(`   ⚠️  Watermark not found at ${CONFIG.WATERMARK_PATH} → saving image without watermark.`);
    return sharp(resized).jpeg({ quality: 85 }).toBuffer();
  }

  const watermarkWidth = Math.round(CONFIG.AI_IMAGE_WIDTH * CONFIG.WATERMARK_WIDTH_RATIO);
  const watermarkResized = await sharp(CONFIG.WATERMARK_PATH)
    .resize({ width: watermarkWidth })
    .ensureAlpha()
    .toBuffer();

  const alphaMultiplier = Math.round(255 * CONFIG.WATERMARK_OPACITY);
  const watermarkTransparent = await sharp(watermarkResized)
    .composite([{
      input: Buffer.from([255, 255, 255, alphaMultiplier]),
      raw  : { width: 1, height: 1, channels: 4 },
      tile : true,
      blend: 'dest-in',
    }])
    .png()
    .toBuffer();

  return sharp(resized)
    .composite([{ input: watermarkTransparent, gravity: 'centre' }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function generateAIImage(keyword, slug) {
  console.log(`   🤖 Generating AI image (Gemini) for "${keyword}"...`);
  const prompt = buildImagePrompt(keyword);
  const { data } = await callGeminiImageAPI(prompt);
  const rawBuffer = Buffer.from(data, 'base64');
  const finalBuffer = await resizeAndWatermark(rawBuffer);

  if (!fs.existsSync(CONFIG.BLOG_IMAGES_DIR)) fs.mkdirSync(CONFIG.BLOG_IMAGES_DIR, { recursive: true });
  const fileName = `${slug}.jpg`;
  fs.writeFileSync(path.join(CONFIG.BLOG_IMAGES_DIR, fileName), finalBuffer);

  return `/images/blog/${fileName}`;
}

function detectType(keyword) {
  const kl = keyword.toLowerCase();
  const serviceWords = ['jasa', 'layanan', 'sewa', 'rental', 'pasang', 'instalasi', 'bangun', 'renovasi', 'cor'];
  return serviceWords.some(w => kl.includes(w)) ? 'service' : 'product';
}

function detectCategories(keyword) {
  const kl = keyword.toLowerCase();
  if (/kitchen|dapur|lemari|furniture|mebel|meja|kursi|tempat tidur/.test(kl)) return ['Furniture', 'Interior'];
  if (/pasir|batu|split|hebel|batako|bata|semen|material|bangunan/.test(kl)) return ['Material Bangunan'];
  if (/cor|pengecoran|beton|pondasi|lantai/.test(kl)) return ['Jasa Pengecoran'];
  if (/sewa|rental|pump|pompa/.test(kl)) return ['Sewa Alat'];
  if (/desain|interior|ruang|kamar/.test(kl)) return ['Desain Interior'];
  return ['Tips & Informasi'];
}

const GREETING_STYLES = [
  'Mitra CDI dimana saja berada',
  'Mitra CDI yang kami hormati',
  'Mitra CDI yang berbahagia',
  'Mitra CDI yang terhormat',
  'Mitra CDI yang budiman',
  'Mitra CDI di mana pun berada',
  'Mitra CDI',
];

const OPENING_STYLES = [
  `Mulai dengan pertanyaan retoris singkat (bukan "pernah nggak sih" atau "pernahkah") yang langsung berhubungan dengan masalah di keyword ini.`,
  `Mulai LANGSUNG dengan menjawab inti pertanyaan di keyword dalam 1-2 kalimat singkat dan tegas, baru kembangkan penjelasannya setelah itu. Jangan basa-basi di awal.`,
  `Mulai dengan menyebutkan situasi/skenario nyata yang sering dialami terkait topik ini (2-3 kalimat cerita singkat), baru masuk ke pembahasan.`,
  `Mulai dengan 1 fakta atau angka menarik terkait topik ini, baru jelaskan kenapa itu penting untuk pembaca.`,
  `Mulai dengan menyebutkan kesalahan umum yang sering terjadi terkait topik ini, tanpa memakai kalimat tanya sama sekali.`,
  `Mulai dengan kalimat pendek dan langsung (maksimal 8 kata) sebagai pembuka paragraf pertama, baru diikuti kalimat yang lebih panjang untuk menjelaskan.`,
];

const CLOSING_STYLES = [
  `Apabila terdapat pertanyaan lain seputar topik ini, tombol **Telepon** dan **WhatsApp** di bawah halaman ini siap Kami jawab.`,
  `Membutuhkan bantuan langsung untuk kebutuhan proyek {ADDR}? Silakan klik tombol **WhatsApp** atau **Telepon** di bawah untuk berkonsultasi dengan tim Kami.`,
  `Apabila masih terdapat hal yang ingin ditanyakan, jangan ragu menghubungi Kami melalui tombol **WhatsApp** atau **Telepon** pada halaman ini.`,
  `Tim Kami siap membantu mewujudkan proyek {ADDR} — silakan hubungi melalui tombol **Telepon** atau **WhatsApp** yang tersedia di bawah.`,
  `Untuk konsultasi lebih lanjut, tombol **Telepon** dan **WhatsApp** di bawah halaman ini dapat langsung digunakan untuk menghubungi Kami.`,
];

const ADDRESS_STYLES = [
  { name: 'Mitra CDI', instruction: 'Setelah kalimat pembuka, lanjutkan memakai sapaan "Mitra CDI" secara konsisten di seluruh isi artikel (bukan "Anda").' },
  { name: 'Anda',      instruction: 'Setelah kalimat pembuka (yang tetap wajib memakai "Mitra CDI"), lanjutkan SISA artikel memakai sapaan "Anda" secara konsisten (JANGAN pakai "Mitra CDI" lagi setelah kalimat pembuka).' },
];

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
// ─────────────────────────────────────────────────────────────────

async function generateArticle(keyword) {
  const type = detectType(keyword);
  const openingStyle = pickRandom(OPENING_STYLES);
  const addressStyle  = pickRandom(ADDRESS_STYLES);
  const greeting      = pickRandom(GREETING_STYLES);
  const closingStyle = pickRandom(CLOSING_STYLES).replace('{ADDR}', addressStyle.name);

  const prompt = `Kamu adalah penulis konten blog untuk website "${CONFIG.SITE_NAME}" — perusahaan jasa desain interior, furniture custom, material bangunan, dan jasa pengecoran di wilayah Jabodetabek.

Kamu menulis dengan GAYA KHAS blog ini:
- Sapaan audiens untuk artikel ini: ${addressStyle.instruction}
- Penulis menyebut diri sebagai "Kami" (bukan "Saya" atau "Saya pribadi")
- Gaya bahasa: BAKU dan formal, tapi tetap hangat dan tidak kaku — seperti konsultan profesional yang ramah.
- JANGAN gunakan kata tidak baku/gaul seperti "nggak", "gimana", "yuk", "nah", "lho", "nih", "banget",
  "kayak", "gitu", "aja". Gunakan padanan baku: "tidak", "bagaimana", "mari", "cukup"/"sangat", dst.
- Kalimat boleh tetap mengalir natural dan tidak monoton, tapi struktur dan pilihan katanya harus
  mengikuti kaidah Bahasa Indonesia baku (setara artikel di media berita atau majalah profesional).

FORMAT PEMBUKA — WAJIB, ini ciri khas/identitas tetap ${CONFIG.SITE_NAME} di setiap artikel:
Kalimat PERTAMA artikel ini WAJIB persis berpola:
"**[Judul Artikel]** - ${greeting}, [lanjutan kalimat pembuka]"
(judul artikel dalam format tebal, lalu tanda hubung " - ", lalu salam "${greeting}", lalu koma,
baru lanjutan kalimat). JANGAN ubah, singkat, atau hilangkan bagian "${greeting}" ini.

Setelah salam pembuka wajib itu, lanjutan kalimat & paragraf pertama mengikuti gaya berikut:
${openingStyle}

GAYA PENUTUP/CTA untuk artikel ini (WAJIB pakai kalimat ini persis, di paragraf terakhir):
"${closingStyle}"

JANGAN tulis nomor telepon dalam bentuk digit apapun di mana pun dalam artikel — cukup arahkan ke
tombol Telepon/WhatsApp seperti instruksi CTA di atas.

KETENTUAN ARTIKEL:
- Keyword utama: "${keyword}"
- Panjang: 900–1100 kata
- Struktur: pembuka conversational → 3-4 H2 (masing-masing ada 2-3 paragraf) → penutup
- Setiap H2 mengandung variasi keyword atau kata kunci turunan
- Sisipkan 1 gambar inline di tengah artikel dengan format: ![deskripsi gambar](IMAGE_PLACEHOLDER)
  (IMAGE_PLACEHOLDER akan diganti otomatis oleh sistem)

WAJIB SUBSTANTIF — bukan cuma basa-basi umum. Sertakan MINIMAL SATU dari ini yang relevan dengan topik:
- Angka/ukuran/standar konkret (contoh: rasio campuran, diameter, ketebalan, mutu beton K-xxx, SNI)
- Contoh perhitungan nyata dengan angka (bukan cuma rumus tanpa contoh)
- Rentang harga atau estimasi biaya yang realistis
- Perbandingan konkret antar-pilihan (bukan cuma daftar kelebihan/kekurangan generik)
Kalau keyword-nya tidak memungkinkan angka teknis (misal topik desain/inspirasi), ganti dengan detail
konkret lain: nama material spesifik, dimensi umum, atau contoh kasus nyata.

VARIASIKAN PANJANG KALIMAT — campur kalimat pendek (5-8 kata) dengan kalimat panjang, jangan seragam
sedang-panjang terus-menerus. Ini penting supaya ritme baca terasa manusiawi, bukan seperti draft AI.

VARIASIKAN HEADING H2 — jangan selalu pakai judul heading generik seperti "Kesimpulan", "Penutup",
"Faktor yang Mempengaruhi..." kalau artikel lain kemungkinan besar pakai judul H2 yang sama. Buat
heading yang spesifik ke topik ini.

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
    console.log(`   🧪 DRY-RUN: Simulating article generation for "${keyword}"...`);
    const kwTitle = keyword.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const raw = `JUDUL: ${kwTitle} - Panduan Lengkap dari ${CONFIG.SITE_NAME}
DESCRIPTION: ${keyword.charAt(0).toUpperCase() + keyword.slice(1)} terbaik untuk hunian dan proyek konstruksi Anda. Temukan tips, harga, dan solusi dari ${CONFIG.SITE_NAME}.
TAGS: ${keyword.split(' ').slice(0, 3).join(', ')}, jasa interior bogor, CDI
ARTIKEL_MULAI
**${kwTitle}** - ${greeting}, salah satu pertanyaan yang sering Kami terima adalah seputar ${keyword}. Artikel ini akan membahas tuntas hal tersebut.

![${kwTitle}](IMAGE_PLACEHOLDER)

## Apa Itu ${kwTitle}?

${keyword.charAt(0).toUpperCase() + keyword.slice(1)} merupakan salah satu elemen penting dalam dunia konstruksi dan desain interior modern. Di ${CONFIG.SITE_NAME}, Kami telah menangani ratusan proyek yang berkaitan dengan ${keyword} dengan hasil yang memuaskan klien.

Kualitas hasil kerja ditentukan oleh pengalaman dan dedikasi tim yang telah lebih dari 10 tahun berkecimpung di bidang ini.

## Keunggulan Layanan ${kwTitle} dari Kami

Berikut beberapa keunggulan yang dapat Kami tawarkan:

- **Kualitas material terjamin** — Kami hanya menggunakan bahan pilihan terbaik
- **Harga transparan** — tidak ada biaya tersembunyi, semua sudah termasuk dalam penawaran
- **Pengerjaan tepat waktu** — Kami menghargai waktu Anda sama seperti menghargai waktu Kami sendiri
- **Garansi hasil pekerjaan** — Kami berdiri di belakang setiap pekerjaan yang dilakukan

## Tips Memilih Layanan ${kwTitle} yang Tepat

Ketelitian diperlukan dalam memilih penyedia layanan ${keyword}. Berikut beberapa tips yang dapat membantu dalam mengambil keputusan yang tepat:

1. Pastikan penyedia jasa memiliki portofolio yang jelas dan dapat diverifikasi
2. Tanyakan tentang material yang digunakan — kualitas material sangat menentukan hasil akhir
3. Minta estimasi biaya tertulis agar tidak ada kesalahpahaman di kemudian hari
4. Periksa ulasan dari pelanggan sebelumnya

## Penutup

Demikian pembahasan kami seputar ${keyword}. Kami berharap artikel ini bermanfaat buat Mitra CDI semua dalam mengambil keputusan terbaik untuk proyek hunian maupun konstruksi Mitra.

Kalau Mitra masih ada pertanyaan atau ingin konsultasi lebih lanjut, silakan hubungi kami melalui tombol **Telepon** atau **WhatsApp** yang tersedia di bawah halaman ini. Kami siap membantu!
`;
    return { raw, greeting };
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
          console.log(`   ⏳ Rate limit, waiting ${err.retryAfterSec}s...`);
          await new Promise(r => setTimeout(r, err.retryAfterSec * 1000 + 500));
          continue;
        }
        throw err;
      }
      if (attempt === maxRetries) throw err;
      const waitMs = attempt * 3000;
      console.log(`   ⚠️  Failed (attempt ${attempt}/${maxRetries}): ${err.message}. Retrying in ${waitMs/1000}s...`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  return { raw: result.choices?.[0]?.message?.content || '', greeting };
}

function yamlEscape(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

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

function ensureCdiOpening(body, title, greeting) {
  const trimmed = body.replace(/^\s+/, '');

  if (/^\*\*[^*]+\*\*\s*[-–—]\s*Mitra\s*CDI/i.test(trimmed)) return body;

  const boldStart = trimmed.match(/^\*\*[^*]+\*\*/);
  if (boldStart) {
    const afterBold = trimmed.slice(boldStart[0].length).replace(/^\s+/, '');
    const firstChar = afterBold.charAt(0);
    const rest = /[A-Z]/.test(firstChar) ? firstChar.toLowerCase() + afterBold.slice(1) : afterBold;
    return `${boldStart[0]} - ${greeting}, ${rest}`;
  }

  const firstChar = trimmed.charAt(0);
  const rest = /[A-Z]/.test(firstChar) ? firstChar.toLowerCase() + trimmed.slice(1) : trimmed;
  return `**${title}** - ${greeting}, ${rest}`;
}

function parseAndSave(raw, keyword, slug, imagePath, greeting) {
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
    if (t.startsWith('CATEGORIES:'))   { /* ignored — always "blog" */ continue; }
    if (t.startsWith('TAGS:'))         { tags  = t.replace('TAGS:', '').trim().split(',').map(t => t.trim()); continue; }
    if (t === 'ARTIKEL_MULAI')         { inBody = true; continue; }
    if (inBody) body += line + '\n';
  }

  if (!body.trim()) body = raw;
  body = stripTrailingMarkers(body);
  body = ensureCdiOpening(body, title, greeting);

  body = body.replace(/IMAGE_PLACEHOLDER/g, imagePath);

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
  console.log(`   💾 Article saved: ${filePath}`);
  return filePath;
}

const RECENT_OPENINGS_FILE = path.join(__dirname, '.recent-openings.json');
const OPENING_SIMILARITY_WARN = 0.6;

function loadRecentOpenings() {
  if (!fs.existsSync(RECENT_OPENINGS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(RECENT_OPENINGS_FILE, 'utf8')); } catch { return []; }
}
function saveRecentOpenings(list) {
  fs.writeFileSync(RECENT_OPENINGS_FILE, JSON.stringify(list.slice(-10))); // save last 10 only
}
function getOpeningWords(body, n = 15) {
  return body.trim().split(/\s+/).slice(0, n).join(' ');
}

function openingBigramSimilarity(a, b) {
  function bigrams(str) {
    const s = str.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const g = [];
    for (let i = 0; i < s.length - 1; i++) g.push(s.substring(i, i + 2));
    return g;
  }
  const ga = bigrams(a), gb = bigrams(b);
  if (!ga.length || !gb.length) return 0;
  const mapA = new Map(); ga.forEach(g => mapA.set(g, (mapA.get(g) || 0) + 1));
  const mapB = new Map(); gb.forEach(g => mapB.set(g, (mapB.get(g) || 0) + 1));
  let inter = 0;
  for (const [g, c] of mapA) if (mapB.has(g)) inter += Math.min(c, mapB.get(g));
  return (2 * inter) / (ga.length + gb.length);
}

function checkOpeningVariety(body) {
  const opening = getOpeningWords(body);
  const recent = loadRecentOpenings();
  const issues = [];
  for (const prev of recent) {
    const score = openingBigramSimilarity(opening, prev);
    if (score >= OPENING_SIMILARITY_WARN) {
      issues.push(`⚠️  Opening is similar (${(score*100).toFixed(0)}%) to a previous article: "${prev.slice(0, 60)}..."`);
    }
  }
  recent.push(opening);
  saveRecentOpenings(recent);
  return issues;
}
// ─────────────────────────────────────────────────────────────────────────────

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

  const bodyOnly = content.replace(/---[\s\S]*?---/, '').trim();
  const wordCount = bodyOnly.split(/\s+/).length;
  if (wordCount < 300) issues.push(`⚠️  Konten terlalu pendek: ${wordCount} kata`);

  const openingIssues = checkOpeningVariety(bodyOnly);
  issues.push(...openingIssues);

  const INFORMAL_WORDS = ['nggak', 'ngga', 'gimana', 'yuk', 'nah', 'lho', 'nih', 'banget', 'kayak', 'gitu', 'aja'];
  const foundInformal = INFORMAL_WORDS.filter(w => new RegExp(`\\b${w}\\b`, 'i').test(bodyOnly));
  if (foundInformal.length) issues.push(`⚠️  Kata tidak baku terdeteksi: ${foundInformal.join(', ')}`);

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
    if (!CONFIG.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN not found.');
    if (!CONFIG.GSC_CREDENTIALS.client_email) throw new Error('Invalid GSC_CREDENTIALS.');
  }

  const keywords = await fetchKeywordsFromGSC();

  const existingSlugs = getExistingSlugs();
  console.log(`\n📁 ${existingSlugs.size} articles already exist in content/blog/`);

  function selectFromSource(rawKeywords, label) {
    if (!rawKeywords.length) return [];
    const newKws = rawKeywords.filter(k => !existingSlugs.has(toSlug(k.keyword)));
    if (!newKws.length) {
      console.log(`   (${label}) All keywords already have articles (slug conflict).`);
      return [];
    }
    console.log(`\n🔎 (${label}) Checking similarity of ${newKws.length} keywords against existing articles...`);
    return filterOutSimilarKeywords(newKws);
  }

  let uniqueKeywords = [];
  let usingFallback  = false;

  if (keywords.length) {
    uniqueKeywords = selectFromSource(keywords, 'GSC');
  } else {
    console.log('⚠️  No keywords from GSC (empty/exhausted).');
  }

  if (!uniqueKeywords.length) {
    console.log(`\n📄 No new keywords from GSC — falling back to keywords.txt...`);
    const fileKeywords = getKeywordsFromFile();
    if (!fileKeywords.length) {
      console.log('   keywords.txt not found or empty. Done — nothing to generate.');
      return;
    }
    console.log(`   📄 ${fileKeywords.length} keywords found in keywords.txt.`);
    uniqueKeywords = selectFromSource(fileKeywords, 'keywords.txt');
    usingFallback = true;
    if (!uniqueKeywords.length) {
      console.log('   All keywords in keywords.txt already have articles or are similar to existing ones. Done.');
      return;
    }
  }

  uniqueKeywords.sort((a, b) => (b.impressions * (1 - b.ctr)) - (a.impressions * (1 - a.ctr)));

  const toProcess = uniqueKeywords.slice(0, IS_DRY_RUN ? uniqueKeywords.length : CONFIG.MAX_ARTICLES);
  console.log(`\n📝 Will generate ${toProcess.length} articles${usingFallback ? ' (from keywords.txt)' : ''}:\n`);

  const results = [];

  for (const item of toProcess) {
    const slug = toSlug(item.keyword);
    console.log(`\n[${toProcess.indexOf(item) + 1}/${toProcess.length}] "${item.keyword}"`);
    console.log(`   📊 Impressions: ${item.impressions} | Position: ${item.position.toFixed(1)} | CTR: ${(item.ctr*100).toFixed(1)}%`);
    console.log(`   🔑 Slug: ${slug} | Type: ${detectType(item.keyword)}`);

    try {
      const imgPath  = await pickImage(item.keyword, slug);
      const { raw, greeting } = await generateArticle(item.keyword);
      const filePath = parseAndSave(raw, item.keyword, slug, imgPath, greeting);
      const issues   = validateArticle(filePath);
      results.push({ keyword: item.keyword, slug, filePath, imgPath, issues });
    } catch (err) {
      console.error(`   ❌ Failed: ${err.message}`);
    }

    if (!IS_DRY_RUN && toProcess.indexOf(item) < toProcess.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`\n${'─'.repeat(55)}`);
  console.log(`✅ Done: ${results.length} articles generated\n`);
  results.forEach(r => {
    const status = r.issues.length === 0 ? '✅' : '⚠️ ';
    console.log(`  ${status} ${r.filePath}`);
  });

  if (usingFallback) {
    removeProcessedKeywordsFromFile(toProcess.map(k => k.keyword));
    console.log(`\n📄 ${toProcess.length} keywords removed from keywords.txt (processed).`);
  }

  if (!IS_DRY_RUN) {
    const logPath = path.join(__dirname, 'generated-articles.log');
    const entry   = results.map(r =>
      `${new Date().toISOString()} | ${r.keyword} | ${r.slug} | ${r.imgPath}`
    ).join('\n');
    fs.appendFileSync(logPath, entry + '\n');
  }
}

main().catch(err => {
  console.error('\n💥 Fatal error:', err.message);
  process.exit(1);
});