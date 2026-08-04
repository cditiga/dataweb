/**
 * revise-articles.js
 *
 * Revise ARTICLE BODY that are templated/similar across cities, ONE BY ONE,
 * gradually (cron), without touching frontmatter or images.
 *
 * STRICTLY PRESERVED — NEVER CHANGED:
 *   - title, categories, type, featured_image, author (and any other frontmatter)
 *   - All image markdown lines ![...](...) in the body
 *   - Hugo shortcodes {{< toc >}} and {{< table-tables table="..." >}} (including params)
 *
 * GUARANTEED IN THE REVISION RESULT:
 *   - The location name (extracted from title, e.g. "Abadijaya Depok") must still
 *     be mentioned naturally several times in the revised body.
 *
 * WORKFLOW:
 *   1. Read list of articles to revise from candidates.json (output of dedup-lapis1.js)
 *      — these are articles that appear templated/similar to others.
 *   2. Process up to MAX_PER_RUN articles per execution (progress saved,
 *      will continue in the next run).
 *   3. For each article: extract images & shortcodes into placeholders, send to AI
 *      to rewrite only the PROSE PART, restore placeholders, validate (images/shortcodes/location present),
 *      then save.
 *
 * USAGE:
 *   node revise-articles.js --dry-run                  → preview without modifying files
 *   node revise-articles.js --apply --limit=20        → revise up to 20 articles this session
 *
 * REQUIRES: CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (Workers AI), candidates.json, npm install gray-matter
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

// GitHub Models was fully retired on 2026-07-30 — replaced with Cloudflare Workers AI
// (OpenAI-compatible endpoint). Requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN.
const CONFIG = {
  CF_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || '',
  CF_API_TOKEN : process.env.CLOUDFLARE_API_TOKEN || '',
  HOST        : 'api.cloudflare.com',
  get PATH()  { return `/client/v4/accounts/${this.CF_ACCOUNT_ID}/ai/v1/chat/completions`; },
  MODEL       : '@cf/aisingapore/gemma-sea-lion-v4-27b-it',
  TIMEOUT_MS  : 60000,
  MAX_RETRIES_PER_ARTICLE: 2,
};

function log(msg) { console.log(msg); }
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

// ─── HTTP helper (timeout + retry + rate-limit, same pattern as dedup-lapis2.js) ──
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
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout after ${timeoutMs/1000}s`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callAI(messages, retries = 3) {
  const body = JSON.stringify({ model: CONFIG.MODEL, messages, temperature: 0.9, max_tokens: 4096 });
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await httpRequest(CONFIG.HOST, CONFIG.PATH, {
        method: 'POST',
        headers: {
          'Authorization'  : `Bearer ${CONFIG.CF_API_TOKEN}`,
          'Content-Type'   : 'application/json',
          'Content-Length' : Buffer.byteLength(body),
        },
      }, body);
      const choice = result?.choices?.[0];
      const content = choice?.message?.content;
      if (!content) {
        throw new Error(`AI returned empty content. Raw response: ${JSON.stringify(result).slice(0, 300)}`);
      }
      if (choice.finish_reason === 'length') {
        throw new Error('AI output truncated (finish_reason=length) — increase max_tokens.');
      }
      return content;
    } catch (err) {
      if (err.isRateLimit) {
        if (err.retryAfterSec && err.retryAfterSec <= 90 && attempt < retries) {
          log(`   ⏳ Rate limit, waiting ${err.retryAfterSec}s...`);
          await new Promise(r => setTimeout(r, err.retryAfterSec * 1000 + 500));
          continue;
        }
        throw err;
      }
      if (attempt === retries) throw err;
      const waitMs = attempt * 3000;
      log(`   ⚠️  Failed (attempt ${attempt}/${retries}): ${err.message}. Retrying in ${waitMs/1000}s...`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

// ─── Extract location from title (used to validate revisions) ─────
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

// ─── Placeholders for images & shortcodes — to ensure AI cannot change them ──
function protectStructure(content) {
  const placeholders = [];
  let protectedContent = content;

  // Image markdown ![...](...)
  protectedContent = protectedContent.replace(/!\[.*?\]\(.*?\)/g, (match) => {
    const idx = placeholders.length;
    placeholders.push(match);
    return `[[[PLACEHOLDER_${idx}]]]`;
  });
  // Hugo shortcodes {{< ... >}}
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

// Safety net: AI sometimes appends a trailing "finished" marker despite prohibition
function stripTrailingMarker(content) {
  const trailingMarkerPattern = /^(ARTIKEL[_\s]?SELESAI|SELESAI|\[?END\]?|TAMAT)\.?$/i;
  const lines = content.split('\n');
  while (lines.length > 0 && (lines[lines.length - 1].trim() === '' || trailingMarkerPattern.test(lines[lines.length - 1].trim()))) {
    lines.pop();
  }
  return lines.join('\n');
}

// ─── Prompt ────────────────────────────────────────────────────────────
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
9. Kalau ada ajakan menghubungi (CTA), JANGAN tulis nomor telepon dalam bentuk digit apapun — cukup arahkan ke tombol Telepon/WhatsApp yang ada di halaman (persis seperti gaya CTA asli CDI, jangan tulis ulang angka telepon meski ada di artikel asli).
10. VARIASIKAN PANJANG KALIMAT dengan sengaja — campur kalimat pendek (5-8 kata, kadang cuma satu klausa) dengan kalimat panjang, jangan seragam sedang-panjang terus-menerus seperti draft AI pada umumnya. Ini penting supaya ritme baca terasa manusiawi, bukan mesin.
11. Kalau ada detail konkret di artikel asli (harga, ukuran, nama material spesifik, jenis produk), PERTAHANKAN detail spesifik itu — itu yang bikin tulisan terasa nyata, bukan generik.

CONTOH GAYA BAHASA ASLI CDI (jadikan acuan nada/rasa tulisan, JANGAN disalin isinya):
"**Jual Material Batu Pondasi di Abadijaya Depok Gratis Ongkir** - Hai Mitra CDI! Gimana kabar kalian semua? kami dari penjual Batu Pondasi yang berlokasi di Abadijaya Depok ingin memperkenalkan usaha kepada anda. kami ialah supplier bahan bangunan berkualitas tinggi yang siap mendukung anda dalam proyek-proyek bangunan di Abadijaya Depok."`
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

// ─── Remove AI preamble/closing chatter — safety-cleaning, don't rely only on prompt rules ────────────────────
function cleanupAIChatter(text) {
  let lines = text.split('\n');

  // Remove common preamble lines (usually 1-2 lines before real content)
  const preamblePatterns = [
    /^berikut(lah)? (adalah )?(artikel|hasil|versi)/i,
    /^tentu[,.]?\s*(berikut|ini)/i,
    /^ini (adalah )?(artikel|hasil|versi) yang (sudah|telah) (direvisi|ditulis ulang)/i,
    /^\*\*.*\*\*\s*$/, // line that is just a short bold (AI sometimes repeats the title)
  ];
  while (lines.length && preamblePatterns.some(p => p.test(lines[0].trim())) ) {
    lines.shift();
    while (lines.length && lines[0].trim() === '') lines.shift();
  }

  // Remove trailing markers/closing lines
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

// ─── Validate revised output before saving ────────────────────────────────
function validatePlaceholders(revisedProtected, placeholders) {
  const issues = [];
  for (let i = 0; i < placeholders.length; i++) {
    const token = `[[[PLACEHOLDER_${i}]]]`;
    const count = (revisedProtected.match(new RegExp(token.replace(/[[\]]/g, '\\$&'), 'g')) || []).length;
    if (count !== 1) issues.push(`Placeholder ${i} appears ${count}x in AI output (should appear exactly 1x)`);
  }
  return issues;
}

function validateFinalContent(original, revisedContent, location) {
  const issues = [];
  if (location && !revisedContent.toLowerCase().includes(location.toLowerCase())) {
    issues.push(`Location name "${location}" not found in revised output`);
  }
  if (revisedContent.length < original.length * 0.5) {
    issues.push(`Revised content too short (${revisedContent.length} vs original ${original.length} characters)`);
  }
  // If original used the "Mitra CDI" salutation, the revised content must keep it.
  if (/mitra cdi/i.test(original) && !/mitra cdi/i.test(revisedContent)) {
    issues.push('The "Mitra CDI" salutation (brand voice) is missing in the revised output');
  }
  return issues;
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  log(`\n✍️  ARTICLE REVISION — reducing cross-city templated similarity`);
  log(`   Mode  : ${APPLY ? 'APPLY' : 'DRY-RUN'}  (limit ${LIMIT} per session)`);
  log(`${'─'.repeat(60)}\n`);

  if (!fs.existsSync(CANDIDATES_FILE)) {
    throw new Error(`${CANDIDATES_FILE} not found. Run first: node dedup-lapis1.js (and ensure candidates.json is committed to the repo).`);
  }
  if (APPLY && !CONFIG.CF_API_TOKEN) {
    throw new Error('CLOUDFLARE_API_TOKEN not found.');
  }
  if (APPLY && !CONFIG.CF_ACCOUNT_ID) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID not found.');
  }

  const candData = JSON.parse(fs.readFileSync(CANDIDATES_FILE, 'utf8'));
  const allUrls = Object.keys(candData.titles);
  log(`📄 ${allUrls.length} articles flagged as templated/similar (from candidates.json).\n`);

  const progress = fs.existsSync(PROGRESS_FILE)
    ? JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'))
    : { revised: [], failed: {} };

  const todo = allUrls.filter(u => !progress.revised.includes(u) && (progress.failed[u] || 0) < CONFIG.MAX_RETRIES_PER_ARTICLE);
  log(`   Already revised before : ${progress.revised.length}`);
  log(`   Awaiting revision      : ${todo.length}`);
  log(`   Will process this run  : ${Math.min(LIMIT, todo.length)}\n`);

  let processed = 0, success = 0, failedThisSession = 0;
  const logLines = [];

  for (const url of todo) {
    if (processed >= LIMIT) break;
    processed++;

    const filePath = path.join(CONTENT_DIR, url.slice(1, -1) + '.md');
    if (!fs.existsSync(filePath)) {
      log(`⚠️  Skipping (file not found): ${url}`);
      progress.revised.push(url); // treat as done
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
      const messages = buildPrompt(title, location || '(not detected)', category, protectedContent);
      let revisedProtected = await callAI(messages); // always call AI, including dry-run, to preview
      revisedProtected = cleanupAIChatter(revisedProtected);

      const placeholderIssues = validatePlaceholders(revisedProtected, placeholders);
      if (placeholderIssues.length > 0) {
        log(`   ❌ Rejected (broken placeholders): ${placeholderIssues.join('; ')}`);
        progress.failed[url] = (progress.failed[url] || 0) + 1;
        failedThisSession++;
        logLines.push(`FAILED,${url},"${placeholderIssues.join(' | ')}"`);
        continue;
      }

      const revisedContent = stripTrailingMarker(restoreStructure(revisedProtected, placeholders));
      const issues = validateFinalContent(parsed.content, revisedContent, location);

      if (issues.length > 0) {
        log(`   ❌ Rejected (validation failed): ${issues.join('; ')}`);
        progress.failed[url] = (progress.failed[url] || 0) + 1;
        failedThisSession++;
        logLines.push(`FAILED,${url},"${issues.join(' | ')}"`);
        continue;
      }

      log(`   ✅ Valid (${fmtDuration(Date.now() - tArticle)}) — location "${location}" ✓, ${placeholders.length} placeholders intact ✓`);

      if (APPLY) {
        // Reassemble using the ORIGINAL FRONTMATTER TEXT (byte-identical), not re-serializing,
        // to avoid YAML style diffs that look noisy in git despite identical values.
        const newFileContent = `---${parsed.matter}\n---\n${revisedContent}`;
        fs.writeFileSync(filePath, newFileContent);
        progress.revised.push(url);
        success++;
        logLines.push(`SUCCESS,${url},"revised"`);
      }
    } catch (err) {
      if (err.isRateLimit) {
        log(`\n🛑 Rate limited. Progress safely saved (${success} successful this session).`);
        log(`   Run again later/tomorrow to continue.`);
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
  log(APPLY ? '✅ DONE (APPLY)' : '🧪 DRY-RUN COMPLETE (no files changed)');
  log(`   Successfully revised this session : ${success}`);
  log(`   Failed/skipped this session       : ${failedThisSession}`);
  log(`   Remaining to process               : ${stillTodo}`);
  log(`   Total time                         : ${fmtDuration(Date.now() - t0)}`);
  log(`   Detail log                          : ${LOG_FILE}`);
}

main().catch(err => {
  console.error('\n💥 Fatal error:', err.message);
  process.exit(1);
});