/**
 * tools/lib/related-articles.js
 *
 * NON-AI internal-linking support, shared by generate-articles.js and revise-articles.js.
 *
 * What this module does (all rule-based, no AI calls):
 *   1. buildArticleIndex(contentRoot)   — scans content/{category}/*.md once, builds a
 *      lightweight in-memory index (title, url, category, a short excerpt).
 *   2. guessCategoryHint(text, cats)    — cheap heuristic: does a known category-folder name
 *      literally appear in the keyword/title? (e.g. "kayu" in "jual balok kayu borneo").
 *   3. findRelatedCandidates(...)       — scores every indexed article against the current
 *      keyword/title by significant-word overlap (+ category boost), returns the top N.
 *   4. formatCandidatesForPrompt(...)   — turns the candidate list into the block of text
 *      that gets injected into the AI prompt (title + url + excerpt, so the AI can actually
 *      read what the related article already says, not just its title).
 *   5. enforceInternalLinks(...)        — SAFETY NET run on the AI's output, after generation:
 *      strips any internal-looking link the AI added that ISN'T one of the offered candidate
 *      URLs (no hallucinated links), and hard-caps the total to 2 — regardless of what the
 *      prompt asked for. Anchor text is preserved as plain text if a link is stripped, so the
 *      sentence still reads naturally.
 *
 * Deliberately dependency-free (no gray-matter) — uses the same lightweight regex-based
 * frontmatter parsing style already used elsewhere in generate-articles.js, so this module
 * works in both tools without depending on an npm package neither file is guaranteed to have
 * installed in every CI job.
 */

const fs   = require('fs');
const path = require('path');

// Folders directly under content/ that are NOT thematic articles (static site pages), so
// they're never offered as internal-link candidates.
const EXCLUDED_CATEGORY_FOLDERS = new Set(['page']);

// Broad marketing/business boilerplate words ignored when scoring topical relatedness — kept
// deliberately close to the STOPWORDS list already used in dedup-lapis1.js / generate-
// articles.js's SIMILARITY_STOPWORDS (same domain, same reasoning), but maintained separately
// here since this list serves a different purpose (finding ON-TOPIC articles to link to, not
// finding near-duplicates to flag) and shouldn't be entangled with that file's versioning.
const RELATED_STOPWORDS = new Set([
  'jual', 'jasa', 'harga', 'sewa', 'beli', 'biaya', 'tukang', 'pasang',
  'di', 'ke', 'dari', 'untuk', 'dan', 'yang', 'dengan', 'atau', 'per', 'apa', 'itu', 'ini',
  'terbaik', 'berkualitas', 'gratis', 'ongkir', 'murah', 'terpercaya', 'terdekat', 'bagus',
  'professional', 'profesional', 'area', 'lokasi', 'wilayah', 'daerah', 'kota', 'kabupaten',
  'kecamatan', 'jabodetabek', 'anda', 'kami', 'material', 'konstruksi', 'desain', 'interior',
  'bangunan', 'apakah', 'pengertian', 'alternatif', 'panduan', 'lengkap', 'cara', 'tips',
  'mengenal', 'kenali', 'memilih', 'adalah', 'dalam', 'pada', 'juga', 'akan', 'bisa', 'dapat',
  'kuat', 'awet', 'tahan', 'lama', 'baik', 'jenis', 'macam', 'model', 'membuat', 'minimalis',
  'terbaru', 'contoh', 'proses', 'sederhana', 'yaitu', 'ialah',
]);

function significantWords(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !RELATED_STOPWORDS.has(w));
}

// Lightweight frontmatter split — regex-based on purpose (see file header), not a full YAML
// parse. Only the two fields we actually need (title, draft) are extracted.
function splitFrontMatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { title: '', draft: false, content: raw };
  const yamlBlock = m[1];
  const titleMatch = yamlBlock.match(/^title:\s*"((?:[^"\\]|\\.)*)"/m) || yamlBlock.match(/^title:\s*(.+?)\s*$/m);
  const draftMatch = yamlBlock.match(/^draft:\s*(true|false)/m);
  return {
    title: titleMatch ? titleMatch[1].replace(/\\"/g, '"').trim() : '',
    draft: draftMatch ? draftMatch[1] === 'true' : false,
    content: m[2] || '',
  };
}

function toUrl(filePath, contentRoot) {
  return '/' + path.relative(contentRoot, filePath).replace(/\\/g, '/').replace(/\.md$/, '') + '/';
}

function toCategory(filePath, contentRoot) {
  const rel = path.relative(contentRoot, filePath).replace(/\\/g, '/');
  return rel.split('/')[0] || '(root)';
}

// Short, plain-text excerpt of the article BODY (not the title) — this is what lets the AI
// actually "study" the related article's content (point 4 of the internal-link feature),
// instead of only seeing a title and guessing.
function extractExcerpt(body, maxChars = 220) {
  const plain = (body || '')
    .replace(/!\[.*?\]\(.*?\)/g, ' ')          // images
    .replace(/\{\{<[\s\S]*?>\}\}/g, ' ')       // Hugo shortcodes
    .replace(/\[\[TABEL_MULAI\]\][\s\S]*?\[\[TABEL_SELESAI\]\]/g, ' ') // our own safe-table blocks, if present
    .replace(/\[\[\[PLACEHOLDER_\d+\]\]\]/g, ' ') // revise-articles.js protection tokens, if present
    .replace(/[#*_>`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.slice(0, maxChars);
}

/**
 * Scans content/{category}/*.md (recursively, all categories except `page`), skipping
 * _index.md and draft:true articles. Run ONCE per script execution and reused — do not call
 * this inside a per-article loop.
 */
function buildArticleIndex(contentRoot) {
  const index = [];
  if (!fs.existsSync(contentRoot)) return index;

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === '_index.md') continue;

      let raw;
      try { raw = fs.readFileSync(full, 'utf8'); } catch { continue; }
      const { title, draft, content } = splitFrontMatter(raw);
      if (!title || draft) continue;

      index.push({
        file: full,
        url: toUrl(full, contentRoot),
        title,
        category: toCategory(full, contentRoot),
        words: significantWords(title),
        excerpt: extractExcerpt(content),
      });
    }
  }

  let topLevel;
  try { topLevel = fs.readdirSync(contentRoot, { withFileTypes: true }); } catch { return index; }
  for (const entry of topLevel) {
    if (!entry.isDirectory() || EXCLUDED_CATEGORY_FOLDERS.has(entry.name)) continue;
    walk(path.join(contentRoot, entry.name));
  }

  return index;
}

/**
 * Rule-based hint only (never a hard filter): does a known category-folder name appear as a
 * whole significant word in the keyword/title? e.g. "kayu" in "jual balok kayu borneo" →
 * folder "kayu" gets a small relevance boost below.
 */
function guessCategoryHint(text, knownCategories) {
  const words = new Set(significantWords(text));
  for (const cat of knownCategories) {
    if (words.has(cat.toLowerCase())) return cat;
  }
  return null;
}

function scoreCandidate(queryWords, categoryHint, candidate) {
  const shared = queryWords.filter(w => candidate.words.includes(w));
  let score = shared.length;
  if (categoryHint && candidate.category === categoryHint) score += 1;
  return { score, sharedCount: shared.length };
}

/**
 * "Satu tema" selection — NON-AI. Ranks every indexed article by significant-word overlap
 * with `text` (the keyword being generated, or the article title being revised), with a small
 * boost when the candidate lives in the category folder the keyword itself hints at.
 *
 * Returns up to `opts.max` candidates ({ url, title, excerpt }), best match first. Empty
 * array if nothing clears `opts.minShared` — callers must treat that as "no internal link
 * this time", not an error.
 */
function findRelatedCandidates({ text, excludeUrl, categoryHint }, index, opts = {}) {
  const max = opts.max || 6;
  const minShared = opts.minShared != null ? opts.minShared : 1;

  const queryWords = significantWords(text);
  if (!queryWords.length) return [];

  const scored = index
    .filter(a => a.url !== excludeUrl)
    .map(a => ({ a, ...scoreCandidate(queryWords, categoryHint, a) }))
    .filter(x => x.sharedCount >= minShared)
    .sort((x, y) => y.score - x.score);

  return scored.slice(0, max).map(x => ({ url: x.a.url, title: x.a.title, excerpt: x.a.excerpt }));
}

function formatCandidatesForPrompt(candidates) {
  if (!candidates.length) {
    return '(Tidak ada artikel terkait yang cukup relevan untuk keyword/topik ini — lewati instruksi internal link, tidak perlu memaksakan.)';
  }
  return candidates.map((c, i) =>
    `${i + 1}. [${c.title}](${c.url})\n   Ringkasan isi: ${c.excerpt || '(tidak ada ringkasan)'}`
  ).join('\n');
}

/**
 * SAFETY NET — run on the final article body (generate) or revised body (revise), AFTER the
 * AI call. Enforces, in code, what the prompt only asks nicely for:
 *   - an internal link is only kept if its URL is EXACTLY one of the offered candidate URLs
 *     (no hallucinated/invented internal links survive)
 *   - never more than `maxLinks` internal links total (default 2) — extras are demoted back
 *     to plain text (anchor text kept, link syntax removed) rather than deleted outright, so
 *     the sentence still reads naturally.
 * Only touches links whose target looks internal (starts with "/" and ends with "/", matching
 * this site's permalink style) — external links, tel:, and WhatsApp links are left alone.
 * Image markdown (`![...](...)`) is excluded via the negative lookbehind on "!".
 */
function enforceInternalLinks(body, candidateUrls, maxLinks = 2) {
  const valid = new Set(candidateUrls || []);
  let kept = 0;
  return body.replace(/(?<!!)\[([^\]]+)\]\((\/[^)\s]+\/)\)/g, (match, anchorText, url) => {
    if (kept >= maxLinks || !valid.has(url)) return anchorText;
    kept++;
    return match;
  });
}

module.exports = {
  buildArticleIndex,
  guessCategoryHint,
  findRelatedCandidates,
  formatCandidatesForPrompt,
  enforceInternalLinks,
  significantWords, // exported for reuse/testing
};
