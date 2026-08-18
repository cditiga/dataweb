const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { execSync } = require('child_process');
const axios = require('axios');

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

const pingServices = [
  'http://ping.googleapis.com/ping?sitemap=',
  'http://www.bing.com/ping?sitemap=',
  'http://rpc.pingomatic.com/',
  'http://www.sitemaps.org/ping?sitemap=',
  'http://www.feedburner.com/fb/a/pingSubmit?bloglink=',
  'https://indexnow.org/ping?sitemap=',
];


async function pingSearchEngines(sitemapUrl) {
  for (const service of pingServices) {
    try {
      await axios.get(`${service}${sitemapUrl}`);
      console.log(`Successfully pinged to ${service}`);
    } catch (error) {
      console.error(`Failed to ping to ${service}:`, error.message);
    }
  }
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
for (const filePath of markdownFiles) {
  if (recyclePost(filePath)) {
    updatedCount++;
  }
}

if (updatedCount > 0) {
  console.log(`${updatedCount} The article has been updated.`);
  // Rebuild situs Hugo
  execSync('hugo', { stdio: 'inherit' });
  
  const sitemapUrl = 'https://www.creativedesigninterior.com/sitemap.xml';
  pingSearchEngines(sitemapUrl);
} else {
  console.log('There are no articles that need to be updated.');
}