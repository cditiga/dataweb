const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { execSync } = require('child_process');
const axios = require('axios');

const contentDir = path.join(__dirname, 'content');
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
    // Surgical replace of just the date: line within the ORIGINAL frontmatter text (byte-
    // identical otherwise), instead of matter.stringify()-ing the whole frontmatter — avoids
    // reformatting quote styles/key order/array layout on every field, which would otherwise
    // cause noisy, unrelated-looking git diffs on every recycled file.
    const newRawMatter = parsed.matter.replace(/^date:\s*.*$/m, `date: "${newDate}"`);
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