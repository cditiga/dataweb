/**
 * revise-articles.js
 *
 * Revisi ISI (body) artikel yang templat/mirip lintas-kota, SATU PER SATU,
 * secara bertahap (cron), tanpa menyentuh frontmatter atau gambar.
 *
 * DIJAGA KETAT — TIDAK PERNAH DIUBAH:
 *   - title, categories, type, featured_image, author (dan seluruh frontmatter lain)
 *   - Semua baris gambar markdown ![...](...) di body
 *   - Shortcode Hugo {{< toc >}} dan {{< table-tables table="..." >}} (termasuk parameternya)
 *
 * DIJAMIN ADA DI HASIL REVISI:
 *   - Nama lokasi (diekstrak dari title, mis. "Abadijaya Depok") tetap disebut
 *     minimal beberapa kali secara alami di body hasil revisi.
 *
 * CARA KERJA:
 *   1. Ambil daftar artikel yang perlu direvisi dari candidates.json (hasil dedup-lapis1.js)
 *      — ini daftar artikel yang templat/mirip dengan artikel lain.
 *   2. Proses maksimal MAX_PER_RUN artikel per eksekusi (progress disimpan,
 *      lanjut otomatis di run berikutnya — sama seperti dedup-lapis2.js).
 *   3. Untuk tiap artikel: extract gambar & shortcode jadi placeholder, kirim ke AI
 *      buat ditulis ulang BAGIAN PROSA-nya saja, lalu pasang kembali placeholder,
 *      validasi (gambar/shortcode/kota masih ada), baru simpan.
 *
 * PAKAI:
 *   node revise-articles.js --dry-run                  → lihat dulu tanpa ubah file
 *   node revise-articles.js --apply --limit=20          → revisi maks 20 artikel sesi ini
 *   node revise-articles.js --apply --limit=20          → jalankan lagi, lanjut batch berikutnya
 *
 * BUTUH: GITHUB_TOKEN (permission "models: read"), candidates.json, npm install gray-matter
 */

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const matter = require('gray-matter');

const ARGS  = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const LIMIT_ARG = (ARGS.find(a => a.startsWith('--limit=')) || '').replace('--limit=', '');
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG, 10) : 20;
const DIR_ARG = (ARGS.find(a => a.startsWith('--dir=')) || '--dir=content').replace('--dir=', '');

const CONTENT_DIR     = path.join(process.cwd(), DIR_ARG);
const CANDIDATES_FILE = path.join(process.cwd(), 'candidates.json');
const PROGRESS_FILE   = path.join(process.cwd(), '.revise-progress.json');
const LOG_FILE        = path.join(process.cwd(), 'revised-articles.log');

const CONFIG = {
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
  HOST        : 'models.github.ai',
  PATH        : '/inference/chat/completions',
  MODEL       : 'openai/gpt-4o',
  API_VERSION : '2022-11-28',
  TIMEOUT_MS  : 60000,
  MAX_RETRIES_PER_ARTICLE: 2,
};

function log(msg) { console.log(msg); }
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}d`;
  return `${Math.floor(s / 60)}m${s % 60}d`;
}

// ─── HTTP helper (timeout + retry + rate-limit, pola sama seperti dedup-lapis2.js) ──
function httpRequest(hostname, reqPath, options, body, timeoutMs = CONFIG.TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: reqPath, ...options }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else if (res.statusCode === 429) {
          const err = new Error(`Rate limited: ${data.slice(0, 200)}`);
          err.isRateLimit = true;
          err.retryAfterSec = res.headers['retry-after'] ? parseInt(res.headers['retry-after'], 10) : null;
          reject(err);
        } else {
          const err = new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`);
          err.statusCode = res.statusCode;
          reject(err);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout setelah ${timeoutMs/1000}d`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callAI(messages, retries = 3) {
  const body = JSON.stringify({ model: CONFIG.MODEL, messages, temperature: 0.9 });
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await httpRequest(CONFIG.HOST, CONFIG.PATH, {
        method: 'POST',
        headers: {
          'Authorization'       : `Bearer ${CONFIG.GITHUB_TOKEN}`,
          'Content-Type'        : 'application/json',
          'Accept'              : 'application/vnd.github+json',
          'X-GitHub-Api-Version': CONFIG.API_VERSION,
          'Content-Length'      : Buffer.byteLength(body),
        },
      }, body);
      return result.choices[0].message.content;
    } catch (err) {
      if (err.isRateLimit) {
        if (err.retryAfterSec && err.retryAfterSec <= 90 && attempt < retries) {
          log(`   ⏳ Rate limit, menunggu ${err.retryAfterSec}d...`);
          await new Promise(r => setTimeout(r, err.retryAfterSec * 1000 + 500));
          continue;
        }
        throw err;
      }
      if (attempt === retries) throw err;
      const waitMs = attempt * 3000;
      log(`   ⚠️  Gagal (percobaan ${attempt}/${retries}): ${err.message}. Coba lagi ${waitMs/1000}d...`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

// ─── Ekstraksi lokasi dari title (dipakai buat validasi hasil revisi) ─────
function extractLocation(title) {
  const m = title.match(/\bdi\b/i);
  if (!m) return null;
  let loc = title.slice(m.index + m[0].length).trim();
  const suffixes = [/gratis ongkir/i, /terdekat/i, /per jam/i, /\[harian\]/i, /\(harian\)/i, /harian/i, /mingguan/i, /bulanan/i];
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of suffixes) {
      const newLoc = loc.replace(new RegExp(suf.source + '\\s*$', 'i'), '').trim().replace(/[\[\](){}]+\s*$/, '').trim();
      if (newLoc !== loc) { loc = newLoc; changed = true; }
    }
  }
  return loc;
}

// ─── Placeholder utk gambar & shortcode — supaya AI TIDAK MUNGKIN mengubahnya ──
function protectStructure(content) {
  const placeholders = [];
  let protectedContent = content;

  // Gambar markdown ![...](...)
  protectedContent = protectedContent.replace(/!\[.*?\]\(.*?\)/g, (match) => {
    const idx = placeholders.length;
    placeholders.push(match);
    return `[[[PLACEHOLDER_${idx}]]]`;
  });
  // Shortcode Hugo {{< ... >}}
  protectedContent = protectedContent.replace(/\{\{<.*?>\}\}/g, (match) => {
    const idx = placeholders.length;
    placeholders.push(match);
    return `[[[PLACEHOLDER_${idx}]]]`;
  });

  return { protectedContent, placeholders };
}

function restoreStructure(content, placeholders) {
  return content.replace(/\[\[\[PLACEHOLDER_(\d+)\]\]\]/g, (_, idx) => placeholders[parseInt(idx, 10)] || '');
}

// 🛡 Jaring pengaman: AI kadang menambahkan penanda "selesai" sendiri di baris
// terakhir meski sudah dilarang di prompt (ditemukan sebagai bug di generate-articles.js —
// selalu muncul "ARTIKEL_SELESAI" di artikel ke-3). Terapkan pembersihan yang sama di sini.
function stripTrailingMarker(content) {
  const trailingMarkerPattern = /^(ARTIKEL[_\s]?SELESAI|SELESAI|\[?END\]?|TAMAT)\.?$/i;
  const lines = content.split('\n');
  while (lines.length > 0 && (lines[lines.length - 1].trim() === '' || trailingMarkerPattern.test(lines[lines.length - 1].trim()))) {
    lines.pop();
  }
  return lines.join('\n');
}

// ─── Prompt ────────────────────────────────────────────────────────────────
function buildPrompt(title, location, category, protectedContent) {
  return [
    {
      role: 'system',
      content: `Anda adalah copywriter SEO profesional bahasa Indonesia untuk "Creative Design Interior" (CDI) — bisnis jasa desain interior, furniture custom, material bangunan, dan jasa pengecoran. Tugas Anda menulis ULANG (paraphrase total, bukan sekadar ganti sinonim) sebuah artikel promosi produk/jasa supaya:
1. Tidak lagi terbaca sebagai "template" yang cuma ganti nama lokasi dari artikel lain — ubah struktur kalimat, urutan poin, gaya penulisan, dan contoh yang dipakai secara signifikan.
2. TETAP mempertahankan esensi promosi/jualan produk atau jasanya (nada persuasif, ajakan membeli/menghubungi tetap ada).
3. TETAP menyebut nama lokasi "${location}" secara alami beberapa kali di seluruh artikel (untuk SEO lokal) — jangan dihapus, jangan diganti nama lokasi lain.
4. WAJIB mempertahankan setiap token "[[[PLACEHOLDER_N]]]" PERSIS APA ADANYA, di posisi yang masuk akal secara alur baca (jangan dihapus, jangan diubah, jangan pindah ke tempat yang tidak masuk akal).
5. Pertahankan format Markdown (heading #, ##, ###, bullet list, bold) tapi boleh ubah teks heading-nya asal topik yang dibahas tetap relevan.
6. Jangan tambahkan bagian frontmatter (--- di awal), jangan tambahkan komentar apapun di luar artikel. Output HANYA isi artikel dalam Markdown.
7. JANGAN tambahkan penanda atau kata penutup apapun di baris terakhir (misalnya "SELESAI", "ARTIKEL_SELESAI", "[END]", "TAMAT", atau sejenisnya). Artikel berakhir begitu saja setelah kalimat/CTA terakhir, tanpa penanda tambahan.
8. JAGA GAYA KHAS BLOG INI (jangan diubah ke gaya lain):
   - Sapaan audiens: "Mitra CDI" (bukan "Anda"/"kamu")
   - Penulis menyebut diri "Kami" (bukan "Saya")
   - Gaya hangat, akrab, conversational — boleh pakai kata informal sesekali ("gimana", "yuk", "nah", "lho", "nih")
   - Kalau artikel asli dibuka dengan pola "**[Judul]** - Hai Mitra CDI!" atau serupa, pertahankan pola sapaan itu (boleh diparafrase kalimatnya, tapi jangan hilangkan sapaan "Mitra CDI"-nya)
9. Kalau ada ajakan menghubungi (CTA), JANGAN tulis nomor telepon dalam bentuk digit apapun — cukup arahkan ke tombol Telepon/WhatsApp yang ada di halaman (persis seperti gaya CTA asli CDI, jangan tulis ulang angka telepon meski ada di artikel asli).`
    },
    {
      role: 'user',
      content: `Judul artikel (JANGAN diubah, ini cuma konteks): "${title}"
Kategori produk/jasa: ${category}
Lokasi yang harus tetap disebut: ${location}

Tulis ulang artikel di bawah ini:

${protectedContent}`
    }
  ];
}

// ─── Buang basa-basi AI (pembuka/penutup) — jaring pengaman kode, jangan cuma
// andalkan larangan di prompt (pelajaran dari bug ARTIKEL_SELESAI di generate-articles.js:
// AI tidak selalu patuh 100% meski sudah dilarang eksplisit) ────────────────────
function cleanupAIChatter(text) {
  let lines = text.split('\n');

  // Buang baris pembuka basa-basi umum (biasanya 1-2 baris pertama sebelum konten asli)
  const preamblePatterns = [
    /^berikut(lah)? (adalah )?(artikel|hasil|versi)/i,
    /^tentu[,.]?\s*(berikut|ini)/i,
    /^ini (adalah )?(artikel|hasil|versi) yang (sudah|telah) (direvisi|ditulis ulang)/i,
    /^\*\*.*\*\*\s*$/, // baris cuma bold pendek tanpa isi (kadang AI taruh judul ulang)
  ];
  while (lines.length && preamblePatterns.some(p => p.test(lines[0].trim())) ) {
    lines.shift();
    while (lines.length && lines[0].trim() === '') lines.shift();
  }

  // Buang baris penutup/penanda di akhir
  const closingPatterns = [
    /^ARTIKEL[_\s]?SELESAI$/i,
    /^SELESAI$/i,
    /^\[?END\]?$/i,
    /^TAMAT$/i,
    /^---+$/,
    /^===+$/,
    /^semoga (artikel|tulisan) ini (bermanfaat|membantu)/i,
  ];
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  while (lines.length && closingPatterns.some(p => p.test(lines[lines.length - 1].trim()))) {
    lines.pop();
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  }

  return lines.join('\n');
}

// ─── Validasi hasil revisi sebelum disimpan ────────────────────────────────
function validatePlaceholders(revisedProtected, placeholders) {
  const issues = [];
  for (let i = 0; i < placeholders.length; i++) {
    const token = `[[[PLACEHOLDER_${i}]]]`;
    const count = (revisedProtected.match(new RegExp(token.replace(/[[\]]/g, '\\$&'), 'g')) || []).length;
    if (count !== 1) issues.push(`Placeholder ${i} muncul ${count}x di output AI (harusnya 1x)`);
  }
  return issues;
}

function validateFinalContent(original, revisedContent, location) {
  const issues = [];
  if (location && !revisedContent.toLowerCase().includes(location.toLowerCase())) {
    issues.push(`Nama lokasi "${location}" tidak ditemukan di hasil revisi`);
  }
  if (revisedContent.length < original.length * 0.5) {
    issues.push(`Hasil revisi terlalu pendek (${revisedContent.length} vs asli ${original.length} karakter)`);
  }
  // Kalau artikel asli pakai sapaan "Mitra CDI", hasil revisi juga wajib pakai —
  // ini gaya khas brand, jangan sampai hilang saat diparafrase.
  if (/mitra cdi/i.test(original) && !/mitra cdi/i.test(revisedContent)) {
    issues.push('Sapaan "Mitra CDI" (gaya khas brand) hilang di hasil revisi');
  }
  return issues;
}

// ─── Main ───────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  log(`\n✍️  REVISI ARTIKEL — mengurangi kemiripan konten lintas-kota`);
  log(`   Mode  : ${APPLY ? 'APPLY' : 'DRY-RUN'}  (limit ${LIMIT} per sesi)`);
  log(`${'─'.repeat(60)}\n`);

  if (!fs.existsSync(CANDIDATES_FILE)) {
    throw new Error(`${CANDIDATES_FILE} tidak ditemukan. Jalankan dulu: node dedup-lapis1.js`);
  }
  if (APPLY && !CONFIG.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN tidak ditemukan.');
  }

  const candData = JSON.parse(fs.readFileSync(CANDIDATES_FILE, 'utf8'));
  const allUrls = Object.keys(candData.titles);
  log(`📄 ${allUrls.length} artikel terindikasi templat/mirip (dari candidates.json).\n`);

  const progress = fs.existsSync(PROGRESS_FILE)
    ? JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'))
    : { revised: [], failed: {} };

  const todo = allUrls.filter(u => !progress.revised.includes(u) && (progress.failed[u] || 0) < CONFIG.MAX_RETRIES_PER_ARTICLE);
  log(`   Sudah direvisi sebelumnya : ${progress.revised.length}`);
  log(`   Menunggu revisi           : ${todo.length}`);
  log(`   Diproses sesi ini (maks)  : ${Math.min(LIMIT, todo.length)}\n`);

  let processed = 0, success = 0, failedThisSession = 0;
  const logLines = [];

  for (const url of todo) {
    if (processed >= LIMIT) break;
    processed++;

    const filePath = path.join(CONTENT_DIR, url.slice(1, -1) + '.md');
    if (!fs.existsSync(filePath)) {
      log(`⚠️  Lewati (file tidak ada): ${url}`);
      progress.revised.push(url); // anggap selesai, tidak perlu diulang
      continue;
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = matter(raw);
    const title = parsed.data.title || candData.titles[url].title;
    const location = extractLocation(title);
    const category = Array.isArray(parsed.data.categories) ? parsed.data.categories.join(', ') : (parsed.data.categories || '');

    log(`📝 [${processed}/${Math.min(LIMIT, todo.length)}] ${title}`);

    const { protectedContent, placeholders } = protectStructure(parsed.content);
    const tArticle = Date.now();

    try {
      const messages = buildPrompt(title, location || '(tidak terdeteksi)', category, protectedContent);
      let revisedProtected = await callAI(messages); // selalu panggil AI, termasuk saat dry-run, supaya bisa preview hasilnya
      revisedProtected = cleanupAIChatter(revisedProtected);

      const placeholderIssues = validatePlaceholders(revisedProtected, placeholders);
      if (placeholderIssues.length > 0) {
        log(`   ❌ Ditolak (placeholder rusak): ${placeholderIssues.join('; ')}`);
        progress.failed[url] = (progress.failed[url] || 0) + 1;
        failedThisSession++;
        logLines.push(`GAGAL,${url},"${placeholderIssues.join(' | ')}"`);
        continue;
      }

      const revisedContent = stripTrailingMarker(restoreStructure(revisedProtected, placeholders));
      const issues = validateFinalContent(parsed.content, revisedContent, location);

      if (issues.length > 0) {
        log(`   ❌ Ditolak (validasi gagal): ${issues.join('; ')}`);
        progress.failed[url] = (progress.failed[url] || 0) + 1;
        failedThisSession++;
        logLines.push(`GAGAL,${url},"${issues.join(' | ')}"`);
        continue;
      }

      log(`   ✅ Valid (${fmtDuration(Date.now() - tArticle)}) — lokasi "${location}" ✓, ${placeholders.length} placeholder aman ✓`);

      if (APPLY) {
        // Susun ulang PAKAI TEKS FRONTMATTER ASLI (byte-identik), bukan re-serialize,
        // supaya tidak ada reformat gaya YAML (kutip hilang, list format beda, dll)
        // yang bikin git diff berantakan padahal nilainya sama persis.
        const newFileContent = `---${parsed.matter}\n---\n${revisedContent}`;
        fs.writeFileSync(filePath, newFileContent);
        progress.revised.push(url);
        success++;
        logLines.push(`SUKSES,${url},"direvisi"`);
      }
    } catch (err) {
      if (err.isRateLimit) {
        log(`\n🛑 Kena rate limit. Progress aman tersimpan (${success} berhasil sesi ini).`);
        log(`   Jalankan lagi nanti/besok untuk lanjut.`);
        break;
      }
      log(`   ❌ Error: ${err.message}`);
      progress.failed[url] = (progress.failed[url] || 0) + 1;
      failedThisSession++;
      logLines.push(`ERROR,${url},"${err.message}"`);
    }

    if (APPLY) fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
  }

  if (logLines.length) {
    fs.appendFileSync(LOG_FILE, logLines.join('\n') + '\n');
  }

  const stillTodo = allUrls.filter(u => !progress.revised.includes(u) && (progress.failed[u] || 0) < CONFIG.MAX_RETRIES_PER_ARTICLE).length;
  log(`\n${'─'.repeat(60)}`);
  log(APPLY ? '✅ SELESAI (APPLY)' : '🧪 DRY-RUN SELESAI (tidak ada file diubah)');
  log(`   Berhasil direvisi sesi ini : ${success}`);
  log(`   Gagal/dilewati sesi ini    : ${failedThisSession}`);
  log(`   Sisa menunggu              : ${stillTodo}`);
  log(`   Total waktu                : ${fmtDuration(Date.now() - t0)}`);
  log(`   Log detail                 : ${LOG_FILE}`);
}

main().catch(err => {
  console.error('\n💥 Error fatal:', err.message);
  process.exit(1);
});
