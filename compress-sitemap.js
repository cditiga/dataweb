const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const toml = require('toml');

// Path ke config.toml
const configPath = path.join(__dirname, 'config.toml');
const sitemapPath = path.join(__dirname, 'public', 'sitemap.xml');
const sitemapGzipPath = path.join(__dirname, 'public', 'sitemap.xml.gz');
const robotsPath = path.join(__dirname, 'public', 'robots.txt');

// Membaca baseURL dari config.toml
function getBaseUrl() {
  const configContent = fs.readFileSync(configPath, 'utf-8');
  const config = toml.parse(configContent);
  return config.baseURL.endsWith('/') ? config.baseURL.slice(0, -1) : config.baseURL;
}

// Membuat robots.txt jika belum ada, dan tambahkan noindex untuk halaman arsip
function ensureRobotsTxt() {
  const baseUrl = getBaseUrl();
  
  const robotsContent = `
User-agent: *
Allow: /

Disallow: /categories/*/page/
Noindex: /categories/*/page/
Disallow: /tags/*/page/
Noindex: /tags/*/page/
Disallow: /page/
Noindex: /page/

Sitemap: ${baseUrl}/sitemap.xml
Sitemap: ${baseUrl}/sitemap.xml.gz
  `;
  
  fs.writeFileSync(robotsPath, robotsContent.trim());
  console.log('robots.txt berhasil dibuat atau diperbarui.');
}

// Mengompres sitemap.xml menjadi sitemap.xml.gz
function compressSitemap() {
  const gzip = zlib.createGzip();
  const source = fs.createReadStream(sitemapPath);
  const destination = fs.createWriteStream(sitemapGzipPath);

  source.pipe(gzip).pipe(destination).on('finish', () => {
    console.log('sitemap.xml berhasil dikompres menjadi sitemap.xml.gz');
  }).on('error', (err) => {
    console.error('Error saat mengompresi sitemap:', err);
  });
}

// Jalankan kedua fungsi
ensureRobotsTxt();
compressSitemap();
