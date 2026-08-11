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
//
// CLOUDFLARE_API_TOKEN can hold MULTIPLE tokens — one per line, or comma-separated — to
// enable key rotation. When one token gets rate-limited, the script automatically rotates
// to the next one instead of stopping. Useful if you have several Cloudflare accounts/API
// tokens and want to pool their free-tier quotas together.
function parseTokens(raw) {
  return (raw || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
}

const CONFIG = {
  CF_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || '',
  CF_API_TOKENS: parseTokens(process.env.CLOUDFLARE_API_TOKEN),
  HOST        : 'api.cloudflare.com',
  get PATH()  { return `/client/v4/accounts/${this.CF_ACCOUNT_ID}/ai/v1/chat/completions`; },
  MODEL       : '@cf/aisingapore/gemma-sea-lion-v4-27b-it',
  TIMEOUT_MS  : 60000,
  MAX_RETRIES_PER_ARTICLE: 2,
};

let tokenIdx = 0;
function currentToken() { return CONFIG.CF_API_TOKENS[tokenIdx] || ''; }
function rotateToken() { tokenIdx = (tokenIdx + 1) % CONFIG.CF_API_TOKENS.length; }

function log(msg) { console.log(msg); }

// Surgically insert/update a `lastmod:` field within the RAW frontmatter text (the string
// between the --- delimiters, as returned by gray-matter's .matter property) — never a full
// YAML re-serialize, which would reformat quote styles/key order/array layout on every field
// and cause noisy, unrelated-looking git diffs. `date:` (original publish date) is left
// untouched; `lastmod:` is Hugo's standard "last modified" field, used for sitemap <lastmod>
// and freshness signals without misrepresenting the true original publish date.
function setLastmod(rawMatter, newDate) {
  const line = `lastmod: "${newDate}"`;
  if (/^lastmod:\s*.*$/m.test(rawMatter)) {
    return rawMatter.replace(/^lastmod:\s*.*$/m, line);
  }
  if (/^date:\s*.*$/m.test(rawMatter)) {
    return rawMatter.replace(/^(date:\s*.*)$/m, `$1\n${line}`);
  }
  return `${rawMatter}\n${line}`;
}
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
  let keysTriedThisCall = 0;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await httpRequest(CONFIG.HOST, CONFIG.PATH, {
        method: 'POST',
        headers: {
          'Authorization'  : `Bearer ${currentToken()}`,
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
        // Rolling key: if we have other tokens we haven't tried yet this call, rotate and
        // retry immediately (no wait — a different token has its own separate quota).
        if (CONFIG.CF_API_TOKENS.length > 1 && keysTriedThisCall < CONFIG.CF_API_TOKENS.length - 1) {
          keysTriedThisCall++;
          log(`   🔁 Key #${tokenIdx + 1} rate-limited — rotating to key #${((tokenIdx + 1) % CONFIG.CF_API_TOKENS.length) + 1}/${CONFIG.CF_API_TOKENS.length}...`);
          rotateToken();
          attempt--; // don't burn a retry budget on a key rotation
          continue;
        }
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
      content: `Anda adalah copywriter SEO profesional bahasa Indonesia untuk "Creative Design Interior" (CDI) — bisnis jasa desain interior, furniture custom, material bangunan, dan jasa pengecoran. Artikel ini adalah salah satu dari puluhan/ratusan varian kota yang isinya nyaris identik satu sama lain (cuma nama lokasi yang beda) — masalah yang harus diperbaiki HANYA itu. Tugas Anda BUKAN menulis ulang seluruh artikel dari nol, tapi melakukan REVISI TERTARGET pada bagian-bagian yang paling terasa "template" (terutama paragraf pembuka dan kalimat pengantar), sambil MEMPERTAHANKAN bagian isi/detail (bullet list, spesifikasi, penjelasan) apa adanya atau dengan reword ringan saja.
1. FOKUS PERUBAHAN: paragraf pembuka, kalimat pengantar tiap section, dan transisi antar-paragraf — ini yang paling sering terbaca "copy-paste" antar kota. Ubah struktur kalimat & pilihan kata di bagian-bagian ini secara signifikan.
2. BAGIAN YANG TIDAK BOLEH DIPOTONG/DIRINGKAS: bullet list, daftar spesifikasi/ukuran/grade, daftar aplikasi/manfaat, dan section detail lainnya. Boleh di-reword kalimatnya (ganti kata, ubah urutan kata dalam satu poin) TAPI jumlah poin/bullet dan section HARUS SAMA seperti aslinya — jangan menghapus, menggabungkan, atau meringkas poin manapun.
3. PANJANG ARTIKEL akhir harus KIRA-KIRA SAMA dengan artikel asli (selisih wajar maksimal ~15%). Ini bukan tugas meringkas — kalau hasil revisi Anda jauh lebih pendek dari aslinya, itu salah.
4. TETAP mempertahankan esensi promosi/jualan produk atau jasanya (nada persuasif, ajakan membeli/menghubungi tetap ada).
5. TETAP menyebut nama lokasi "${location}" secara alami beberapa kali di seluruh artikel (untuk SEO lokal) — jangan dihapus, jangan diganti nama lokasi lain.
6. WAJIB mempertahankan setiap token "[[[PLACEHOLDER_N]]]" PERSIS APA ADANYA, di posisi yang masuk akal secara alur baca (jangan dihapus, jangan diubah, jangan pindah ke tempat yang tidak masuk akal).
7. Pertahankan format Markdown (heading #, ##, ###, bullet list, bold) — heading boleh diparafrase kalimatnya tapi topik yang dibahas tetap relevan dan JUMLAH heading tetap sama.
8. Jangan tambahkan bagian frontmatter (--- di awal), jangan tambahkan komentar apapun di luar artikel. Output HANYA isi artikel dalam Markdown.
9. JANGAN tambahkan penanda atau kata penutup apapun di baris terakhir (misalnya "SELESAI", "ARTIKEL_SELESAI", "[END]", "TAMAT", atau sejenisnya). Artikel berakhir begitu saja setelah kalimat/CTA terakhir, tanpa penanda tambahan.
10. JAGA GAYA KHAS BLOG INI (jangan diubah ke gaya lain):
    - Sapaan audiens: "Mitra CDI" atau "Mitra" atau "Anda" (bukan "kamu")
    - Penulis menyebut diri "Kami" (bukan "Saya")
    - Gaya hangat, akrab, conversational — boleh pakai kata informal sesekali ("gimana", "yuk", "nah", "lho", "nih")
    - Kalau artikel asli dibuka dengan pola "**[Judul]** - Hai Mitra CDI!" atau serupa, pertahankan pola sapaan itu (boleh diparafrase kalimatnya, tapi jangan hilangkan sapaan "Mitra CDI"-nya)
11. Kalau ada ajakan menghubungi (CTA), JANGAN tulis nomor telepon dalam bentuk digit apapun — cukup arahkan ke tombol Telepon/WhatsApp yang ada di halaman (persis seperti gaya CTA asli CDI, jangan tulis ulang angka telepon meski ada di artikel asli).
12. VARIASIKAN PANJANG KALIMAT dengan sengaja di bagian pembuka — campur kalimat pendek (5-8 kata, kadang cuma satu klausa) dengan kalimat panjang, jangan seragam sedang-panjang terus-menerus seperti draft AI pada umumnya. Ini penting supaya ritme baca terasa manusiawi, bukan mesin.
13. Kalau ada detail konkret di artikel asli (ukuran, nama material spesifik, jenis produk), PERTAHANKAN detail spesifik itu — itu yang bikin tulisan terasa nyata, bukan generik.
14. ATURAN HARGA — PENTING: JANGAN PERNAH menulis, mengubah, atau MENGARANG angka harga (Rp) dalam bentuk apa pun, termasuk placeholder seperti "Rp XXX", "Rp YYY", "Rp ZZZ". Data harga resmi sudah tampil otomatis lewat tabel harga (dilindungi sebagai salah satu token [[[PLACEHOLDER_N]]], jangan disentuh). Kalau ada kalimat di artikel asli yang menyebut placeholder harga seperti itu, tulis ulang kalimatnya TANPA menyebut angka apapun — misalnya arahkan pembaca ke tabel harga di atas, atau ajak menghubungi tim untuk info harga terkini. JANGAN PERNAH mengisi placeholder harga dengan angka yang Anda karang sendiri, sekecil apapun angkanya.

CONTOH GAYA BAHASA ASLI CDI (jadikan acuan nada/rasa tulisan, JANGAN disalin isinya):
"**Jual Material Batu Pondasi di Abadijaya Depok Gratis Ongkir** - Hai Mitra CDI! Gimana kabar kalian semua? kami dari penjual Batu Pondasi yang berlokasi di Abadijaya Depok ingin memperkenalkan usaha kepada anda. kami ialah supplier bahan bangunan berkualitas tinggi yang siap mendukung anda dalam proyek-proyek bangunan di Abadijaya Depok."`
    },
    {
      role: 'user',
      content: `Judul artikel (JANGAN diubah, ini cuma konteks): "${title}"
Kategori produk/jasa: ${category}
Lokasi yang harus tetap disebut: ${location}
Panjang artikel asli: ${protectedContent.length} karakter (~${protectedContent.split(/\s+/).length} kata) — hasil revisi harus mendekati panjang ini, JANGAN diringkas.

Tulis ulang artikel di bawah ini (revisi tertarget, bukan tulis ulang total — lihat instruksi):

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
  // Threshold raised from the old 50% to 80% — the revision prompt now does a LIGHT,
  // targeted revision (not a full rewrite), so a much smaller length change is expected.
  // A bigger drop means the AI over-rewrote/summarized instead of doing a targeted edit.
  if (revisedContent.length < original.length * 0.8) {
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
  if (APPLY && CONFIG.CF_API_TOKENS.length === 0) {
    throw new Error('CLOUDFLARE_API_TOKEN not found.');
  }
  if (APPLY && !CONFIG.CF_ACCOUNT_ID) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID not found.');
  }
  if (APPLY && CONFIG.CF_API_TOKENS.length > 1) {
    log(`   🔑 ${CONFIG.CF_API_TOKENS.length} Cloudflare API keys loaded (rolling on rate limit)\n`);
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
        // Reassemble using the ORIGINAL FRONTMATTER TEXT (byte-identical apart from lastmod),
        // not re-serializing, to avoid YAML style diffs that look noisy in git despite
        // identical values. lastmod records when this article was last revised, without
        // touching the original `date:` (publish date).
        const newRawMatter = setLastmod(parsed.matter, new Date().toISOString().split('T')[0]);
        const newFileContent = `---${newRawMatter}\n---\n${revisedContent}`;
        fs.writeFileSync(filePath, newFileContent);
        progress.revised.push(url);
        success++;
        logLines.push(`SUCCESS,${url},"revised"`);
      }
    } catch (err) {
      if (err.isRateLimit) {
        const keyNote = CONFIG.CF_API_TOKENS.length > 1 ? ` (all ${CONFIG.CF_API_TOKENS.length} keys exhausted)` : '';
        log(`\n🛑 Rate limited${keyNote}. Progress safely saved (${success} successful this session).`);
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