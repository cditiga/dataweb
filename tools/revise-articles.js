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
 *   node revise-articles.js --verify-cf                 → test each CLOUDFLARE_ACCOUNT_ID +
 *       CLOUDFLARE_API_TOKEN pair independently, reporting ✅/❌ per pair. Use this whenever
 *       Cloudflare calls fail with "unescaped characters" or "Authentication error".
 *
 * REQUIRES: CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (Workers AI), candidates.json, npm install gray-matter
 */

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const matter = require('gray-matter');

// AI prompt text (system/user templates) lives in prompts/revise-articles.json — kept
// separate from this file so prompt wording can be edited without touching code.
// Variables are injected via {{placeholder}} tokens, filled in by renderTemplate() below.
const PROMPTS = require('./prompts/revise-articles.json');

function renderTemplate(str, vars) {
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in vars ? vars[key] : `{{${key}}}`));
}

const ARGS  = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const VERIFY_CF = ARGS.includes('--verify-cf');
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
// Both CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN can hold MULTIPLE values — one per
// line, or comma-separated — to pool quota across several Cloudflare accounts:
//   - N account IDs + N tokens (same count): PAIRED 1:1 BY LINE ORDER — line 1 of one goes
//     with line 1 of the other (same account), line 2 with line 2, etc.
//   - 1 account ID + N tokens: all N tokens rotate against that SAME single account.
// (Kept in sync with generate-articles.js's identical CF_ACCOUNT_IDS/CF_API_TOKENS logic —
// this file has its OWN separate copy since it doesn't share code with generate-articles.js,
// so a fix made in one does NOT automatically apply to the other. On 2026-08-19 this exact
// file was still running the old single-CF_ACCOUNT_ID code after generate-articles.js had
// already been fixed, causing the same "Request path contains unescaped characters" bug to
// resurface here once CLOUDFLARE_ACCOUNT_ID became multi-line.)
function parseTokens(raw) {
  return (raw || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
}

const CONFIG = {
  CF_ACCOUNT_IDS: parseTokens(process.env.CLOUDFLARE_ACCOUNT_ID),
  CF_API_TOKENS : parseTokens(process.env.CLOUDFLARE_API_TOKEN),
  HOST        : 'api.cloudflare.com',
  MODEL       : '@cf/aisingapore/gemma-sea-lion-v4-27b-it',
  TIMEOUT_MS  : 60000,
  MAX_RETRIES_PER_ARTICLE: 2,
};

// Cloudflare account IDs are 32-char lowercase hex — flag anything else immediately at
// startup instead of letting it surface later as a cryptic low-level HTTP error.
CONFIG.CF_ACCOUNT_IDS.forEach((id, i) => {
  if (!/^[a-f0-9]{32}$/i.test(id)) {
    console.warn(`⚠️  CLOUDFLARE_ACCOUNT_ID line ${i + 1} doesn't look like a valid Cloudflare account ID ` +
      `(expected 32 hex characters, got ${id.length} chars: "${id}").`);
  }
});
if (CONFIG.CF_ACCOUNT_IDS.length > 1 && CONFIG.CF_ACCOUNT_IDS.length !== CONFIG.CF_API_TOKENS.length) {
  console.warn(`⚠️  CLOUDFLARE_ACCOUNT_ID has ${CONFIG.CF_ACCOUNT_IDS.length} line(s) but CLOUDFLARE_API_TOKEN has ` +
    `${CONFIG.CF_API_TOKENS.length} line(s). For multi-account rotation these must match 1:1, same order ` +
    `(line N of one = line N of the other, same account) — otherwise an account ID may get paired with ` +
    `the wrong account's token and fail auth. Fix: make both secrets have the same number of lines.`);
}

let tokenIdx = 0;
function currentToken() { return CONFIG.CF_API_TOKENS[tokenIdx] || ''; }
// Paired with currentToken() via the SAME index, so rotateToken() advances both together.
function currentAccountId() { return CONFIG.CF_ACCOUNT_IDS[tokenIdx] || CONFIG.CF_ACCOUNT_IDS[0] || ''; }
function currentPath() { return `/client/v4/accounts/${currentAccountId()}/ai/v1/chat/completions`; }
function rotateToken() { tokenIdx = (tokenIdx + 1) % CONFIG.CF_API_TOKENS.length; }

function log(msg) { console.log(msg); }

// Tests each CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN pair independently with a minimal
// real call against the exact same endpoint used in callAI() — run with --verify-cf.
async function verifyCfPairs() {
  log(`\n🔍 Verifying CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN pair(s)`);
  log(`${'─'.repeat(60)}\n`);

  if (CONFIG.CF_API_TOKENS.length === 0) { log('❌ CLOUDFLARE_API_TOKEN not found.'); return; }
  if (CONFIG.CF_ACCOUNT_IDS.length === 0) { log('❌ CLOUDFLARE_ACCOUNT_ID not found.'); return; }

  let anyFailed = false;
  for (let i = 0; i < CONFIG.CF_API_TOKENS.length; i++) {
    const token = CONFIG.CF_API_TOKENS[i];
    const accountId = CONFIG.CF_ACCOUNT_IDS[i] || CONFIG.CF_ACCOUNT_IDS[0];
    const label = `Pair ${i + 1} (account ...${accountId.slice(-6)})`;
    try {
      const body = JSON.stringify({ model: CONFIG.MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
      await httpRequest(CONFIG.HOST, `/client/v4/accounts/${accountId}/ai/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization'  : `Bearer ${token}`,
          'Content-Type'   : 'application/json',
          'Content-Length' : Buffer.byteLength(body),
        },
      }, body, 20000);
      log(`   ✅ ${label}: OK`);
    } catch (err) {
      anyFailed = true;
      log(`   ❌ ${label}: ${err.message}`);
    }
  }

  log(anyFailed
    ? '\n⚠️  One or more pairs failed — check the ❌ ones above: verify the token is valid, has ' +
      'Workers AI permission, and is PAIRED with the correct account (same line number in both secrets).'
    : '\n✅ All pairs authenticated successfully.');
}

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
          // 401/403 means THIS SPECIFIC key/account pair is bad — not a rate limit. Tag it
          // so callAI() can rotate to the next pair immediately instead of burning the full
          // retry budget hammering the same broken pair.
          err.isAuthError = (res.statusCode === 401 || res.statusCode === 403);
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
      const result = await httpRequest(CONFIG.HOST, currentPath(), {
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
      if (err.isRateLimit || err.isAuthError) {
        // Rolling key: if we have other pairs we haven't tried yet this call, rotate and
        // retry immediately (no wait — a different pair has its own separate quota/account).
        if (CONFIG.CF_API_TOKENS.length > 1 && keysTriedThisCall < CONFIG.CF_API_TOKENS.length - 1) {
          keysTriedThisCall++;
          const reason = err.isRateLimit ? 'rate-limited' : 'auth error';
          log(`   🔁 Key #${tokenIdx + 1} ${reason} — rotating to key #${((tokenIdx + 1) % CONFIG.CF_API_TOKENS.length) + 1}/${CONFIG.CF_API_TOKENS.length}...`);
          rotateToken();
          attempt--; // don't burn a retry budget on a key rotation
          continue;
        }
        if (err.isRateLimit && err.retryAfterSec && err.retryAfterSec <= 90 && attempt < retries) {
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
      content: renderTemplate(PROMPTS.revision.systemTemplate, { location }),
    },
    {
      role: 'user',
      content: renderTemplate(PROMPTS.revision.userTemplate, {
        title,
        category,
        location,
        length: protectedContent.length,
        wordCount: protectedContent.split(/\s+/).length,
        protectedContent,
      }),
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
  if (VERIFY_CF) {
    await verifyCfPairs();
    return;
  }

  const t0 = Date.now();
  log(`\n✍️  ARTICLE REVISION — reducing cross-city templated similarity`);
  log(`   Mode  : ${APPLY ? 'APPLY' : 'DRY-RUN'}  (limit ${LIMIT} per session)`);
  log(`${'─'.repeat(60)}\n`);

  if (!fs.existsSync(CANDIDATES_FILE)) {
    throw new Error(`${CANDIDATES_FILE} not found. Run first: node tools/dedup-lapis1.js (and ensure candidates.json is committed to the repo).`);
  }
  if (APPLY && CONFIG.CF_API_TOKENS.length === 0) {
    throw new Error('CLOUDFLARE_API_TOKEN not found.');
  }
  if (APPLY && CONFIG.CF_ACCOUNT_IDS.length === 0) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID not found.');
  }
  if (APPLY && CONFIG.CF_API_TOKENS.length > 1) {
    const rotationKind = CONFIG.CF_ACCOUNT_IDS.length > 1
      ? `${CONFIG.CF_API_TOKENS.length} account+token pairs`
      : `${CONFIG.CF_API_TOKENS.length} tokens on 1 account`;
    log(`   🔑 Rolling across ${rotationKind} (rolling on rate limit)\n`);
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
      if (err.isAuthError) {
        // If ALL pairs just failed auth, every remaining article this session would fail
        // identically — stop now instead of burning the whole --limit budget on guaranteed
        // failures (this is exactly what happened on 2026-08-19: 20/20 articles failed the
        // same way before this check existed).
        const keyNote = CONFIG.CF_API_TOKENS.length > 1 ? ` (all ${CONFIG.CF_API_TOKENS.length} pairs failed auth)` : '';
        log(`\n🛑 Authentication error${keyNote}. Progress safely saved (${success} successful this session).`);
        log(`   Run "node tools/revise-articles.js --verify-cf" to see which pair(s) are misconfigured.`);
        progress.failed[url] = (progress.failed[url] || 0) + 1;
        failedThisSession++;
        logLines.push(`ERROR,${url},"${err.message}"`);
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