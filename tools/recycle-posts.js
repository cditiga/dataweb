const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { execSync } = require('child_process');

// Correct, currently-working URL-notification logic — replaces the old pingServices/
// pingSearchEngines() below, which pinged endpoints that are dead, wrong-protocol, or not
// real search-engine endpoints at all. See tools/lib/index-ping.js for the full explanation
// of what was broken and why IndexNow (implemented there) is what actually works today.
const { submitToIndexNow } = require('./lib/index-ping.js');

const SITE_URL = 'https://www.creativedesigninterior.com/';

const contentDir = path.join(__dirname, '..', 'content');
const now = new Date();

// Articles live nested under content/blog/, content/bata/, etc. (29+ category sub-folders),
// not directly in content/ — fs.readdirSync(contentDir) alone only sees the folder names one
// level down, never the .md files themselves. Walk recursively to actually find them all.
function walkMarkdownFiles(dir) {
  let results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(walkMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

// Matches this project's existing URL convention (same formula used in dedup-lapis1.js and
// tools/lib/related-articles.js): section-nested, e.g. content/kayu/slug.md → /kayu/slug/.
function toUrl(filePath) {
  return '/' + path.relative(contentDir, filePath).replace(/\\/g, '/').replace(/\.md$/, '') + '/';
}

// Surgically insert/update a `lastmod:` field within the RAW frontmatter text (the string
// between the --- delimiters, as returned by gray-matter's .matter property) — never a full
// YAML re-serialize, which would reformat quote styles/key order/array layout on every field
// and cause noisy, unrelated-looking git diffs. `date:` (original publish date) is left
// untouched; `lastmod:` is Hugo's standard "last modified" field, used for sitemap <lastmod>
// and freshness signals without misrepresenting the true original publish date.
// (Same implementation as revise-articles.js's setLastmod() — kept in sync intentionally.)
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

function recyclePost(filePath) {
  const fileContent = fs.readFileSync(filePath, 'utf8');
  const parsed = matter(fileContent);
  const { data, content } = parsed;

  if (data.draft === true) return false; // never bump the date on unpublished drafts

  const postDate = new Date(data.date);
  if (isNaN(postDate.getTime())) return false; // missing/unparseable date — skip, don't crash

  const monthsDiff = (now.getFullYear() - postDate.getFullYear()) * 12 + now.getMonth() - postDate.getMonth();

  if (monthsDiff >= 12) {
    const newDate = now.toISOString().split('T')[0];
    // NOTE: this used to overwrite `date:` directly, which destroyed the true original
    // publish date and made every recycled article look freshly-published despite no
    // content actually changing — Google explicitly discourages that pattern. Now it adds/
    // updates `lastmod:` instead (identical mechanism to revise-articles.js's
    // setLastmod()), which preserves `date` and signals "last touched" honestly.
    const newRawMatter = setLastmod(parsed.matter, newDate);
    const updatedContent = `---${newRawMatter}\n---\n${content}`;
    fs.writeFileSync(filePath, updatedContent);
    return true;
  }

  return false;
}

const markdownFiles = walkMarkdownFiles(contentDir);
console.log(`📁 ${markdownFiles.length} file .md ditemukan di ${contentDir} (rekursif, semua sub-folder).`);

let updatedCount = 0;
const updatedFilePaths = [];
for (const filePath of markdownFiles) {
  if (recyclePost(filePath)) {
    updatedCount++;
    updatedFilePaths.push(filePath);
  }
}

// Wrapped in an async IIFE (rather than top-level await, unavailable in CommonJS) purely so
// the script properly WAITS for the IndexNow submission to finish — and reports its result —
// before the process exits, instead of relying on incidental event-loop-keep-alive behavior
// from the in-flight HTTPS request.
(async () => {
  if (updatedCount > 0) {
    console.log(`${updatedCount} The article has been updated.`);
    // Rebuild situs Hugo
    execSync('hugo', { stdio: 'inherit' });

    // IndexNow wants the SPECIFIC pages that changed, not the sitemap URL — build the exact
    // list from what recyclePost() actually touched this run. (Google isn't part of
    // IndexNow; see tools/lib/index-ping.js for why an accurate <lastmod>, already handled
    // by setLastmod() above, is the correct signal for Google instead.)
    const updatedUrls = updatedFilePaths.map(fp => `${SITE_URL.replace(/\/$/, '')}${toUrl(fp)}`);
    await submitToIndexNow(SITE_URL, updatedUrls);
  } else {
    console.log('There are no articles that need to be updated.');
  }
})().catch(err => {
  console.error('\n💥 Fatal error:', err.message);
  process.exit(1);
});