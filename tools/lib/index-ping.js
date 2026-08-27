/**
 * tools/lib/index-ping.js
 *
 * Correct, currently-working replacement for the old pingSearchEngines() in
 * recycle-posts.js. Checked against each service directly (August 2026) before writing this.
 *
 * WHY THE OLD PING LOGIC NEVER ACTUALLY DID ANYTHING:
 *   - ping.googleapis.com/ping?sitemap=   → Google retired the sitemap ping endpoint in June
 *     2023 (announced on the Search Central blog). It has returned 404 since late 2023.
 *   - www.bing.com/ping?sitemap=          → Bing retired its sitemap ping endpoint the same
 *     way; it returns 410 Gone.
 *   - rpc.pingomatic.com                  → Expects an XML-RPC POST body (the
 *     weblogUpdates.ping method), not a bare GET with the sitemap URL appended to the path.
 *     The old code (`axios.get(service + sitemapUrl)`) never sent a request pingomatic could
 *     parse, so this always silently no-op'd, independent of whether pingomatic itself still
 *     matters today.
 *   - www.sitemaps.org/ping?sitemap=      → sitemaps.org is the sitemap *protocol
 *     specification* site, not a search engine. It has never indexed anything submitted here.
 *   - www.feedburner.com/fb/a/pingSubmit  → FeedBurner's ping/submission API was shut down by
 *     Google years ago.
 *   - indexnow.org/ping?sitemap=          → Not a real IndexNow endpoint. IndexNow has no
 *     "ping a sitemap URL" call at all — see the real protocol implemented below.
 *
 * WHAT ACTUALLY WORKS TODAY:
 *   - IndexNow (Bing, Yandex, Seznam, Naver — Google does NOT participate; Google tested it
 *     in 2022 and chose not to adopt it): a POST with a JSON body listing the EXACT URLs that
 *     changed, plus a key proving domain ownership via a small text file hosted at the site
 *     root. Implemented below via the shared api.indexnow.org endpoint, which redistributes
 *     a single submission to every participating engine.
 *   - Google: there is no supported "push this URL now" call for ordinary content anymore.
 *     Google's Indexing API is officially restricted to JobPosting/BroadcastEvent pages only
 *     — using it for blog/product pages is outside its documented scope and not reliable.
 *     The correct, still-supported signal for Google is an accurate sitemap.xml with a
 *     correct <lastmod> (Google has confirmed it uses lastmod for crawl scheduling when it's
 *     consistently accurate) — which this project already does correctly via setLastmod() in
 *     recycle-posts.js and revise-articles.js. There is no additional "ping" call that
 *     replaces that for Google; nothing to add here beyond keeping lastmod accurate.
 */

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const crypto = require('crypto');

const KEY_STATE_FILE = path.join(__dirname, '..', '..', '.indexnow-key.json');
const STATIC_DIR     = path.join(__dirname, '..', '..', 'static');

/**
 * Returns this site's persistent IndexNow key, generating it (and writing the required
 * static/<key>.txt verification file) the first time this ever runs. The SAME key must keep
 * being used on every future run — search engines validate submissions against the key file,
 * so a key that changes breaks verification.
 *
 * IMPORTANT — first-run-only caveat: when static/<key>.txt is created for the very first
 * time, it won't be LIVE on the real domain until the current CI job's build actually gets
 * deployed (a few steps later in the workflow). So the very first IndexNow submission ever
 * made may get rejected with a key-verification error (404 on the key file) purely because
 * deployment hasn't happened yet — this is expected and self-resolves from the next run
 * onward, once the key file is permanently live. Not a bug, just the order of operations.
 *
 * IMPORTANT — this newly-created file must actually be committed to git (recycle.yml's
 * "Commit Changes" step was updated to `git add static/` for exactly this reason) or the key
 * file will never make it to the deployed site and every submission will keep failing.
 */
function ensureIndexNowKey() {
  let key;
  if (fs.existsSync(KEY_STATE_FILE)) {
    try { key = JSON.parse(fs.readFileSync(KEY_STATE_FILE, 'utf8')).key; } catch { key = null; }
  }
  if (!key || !/^[a-f0-9]{32}$/i.test(key)) {
    key = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(KEY_STATE_FILE, JSON.stringify({ key, createdAt: new Date().toISOString() }, null, 2));
    console.log(`   🔑 New IndexNow key generated and saved to ${path.basename(KEY_STATE_FILE)}: ${key}`);
  }

  const keyFilePath = path.join(STATIC_DIR, `${key}.txt`);
  if (!fs.existsSync(keyFilePath)) {
    if (!fs.existsSync(STATIC_DIR)) fs.mkdirSync(STATIC_DIR, { recursive: true });
    fs.writeFileSync(keyFilePath, key); // file content must be EXACTLY the key, no extra whitespace
    console.log(`   🔑 IndexNow key file created: static/${key}.txt (will be published at the site root — make sure it gets committed).`);
  }

  return key;
}

function httpsPostJson(hostname, reqPath, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname,
      path: reqPath,
      method: 'POST',
      headers: {
        'Content-Type'  : 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout after ${timeoutMs / 1000}s (${hostname}${reqPath})`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Submits `urls` (an array of full https:// page URLs that were actually added/changed — NOT
 * a sitemap URL) to IndexNow, in one batched call (up to 10,000 URLs per the protocol spec).
 *
 * Does nothing (returns { skipped: true }) if `urls` is empty — IndexNow is for the specific
 * pages that changed, never a blanket "ping the whole sitemap" call.
 *
 * @param {string} siteUrl - e.g. "https://www.creativedesigninterior.com/" (CONFIG.SITE_URL)
 * @param {string[]} urls  - full page URLs, same host as siteUrl
 */
async function submitToIndexNow(siteUrl, urls) {
  if (!urls || !urls.length) return { skipped: true, reason: 'no URLs to submit' };

  const key = ensureIndexNowKey();
  const host = new URL(siteUrl).host;
  const keyLocation = `${siteUrl.replace(/\/$/, '')}/${key}.txt`;
  const payload = { host, key, keyLocation, urlList: urls.slice(0, 10000) };

  try {
    const { statusCode, body } = await httpsPostJson('api.indexnow.org', '/indexnow', payload);
    // IndexNow returns 200 (OK) or 202 (Accepted) on success; 400/403/422 mean a real problem
    // (bad key, key file unreachable/mismatched, malformed host) worth surfacing loudly rather
    // than swallowing silently like the old ping code did.
    if (statusCode === 200 || statusCode === 202) {
      console.log(`   ✅ IndexNow: ${urls.length} URL(s) submitted to Bing/Yandex/Seznam/Naver (HTTP ${statusCode}).`);
      return { ok: true, statusCode };
    }
    console.warn(`   ⚠️  IndexNow submission returned HTTP ${statusCode}: ${body.slice(0, 200)}`);
    return { ok: false, statusCode, body };
  } catch (err) {
    console.warn(`   ⚠️  IndexNow submission failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = { submitToIndexNow, ensureIndexNowKey };
