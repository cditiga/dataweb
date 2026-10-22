/**
 * tools/lib/promo.js — membuat artikel lebih berorientasi promosi (menarik calon pembeli) dengan aman.
 *   - injectPromo()         : menyisipkan ATURAN PROMOSI (tingkat + sudut sesuai intent keyword + fakta bisnis) ke prompt
 *   - protectPromoLinks()   : melindungi link ke /daftar-harga/ dan /product/ dari enforceInternalLinks() (maks. 2)
 *   - promoIssues()         : peringatan: klaim terlarang, nomor telepon, link harga/ajakan hilang
 * Tingkat diatur lewat env PROMO_LEVEL = rendah | sedang | tinggi (default di prompts/promo-profile.json).
 */
'use strict';
const P  = require('../prompts/promo-profile.json');
const KS = require('./keyword-similarity.js');

const LEVELS = ['rendah', 'sedang', 'tinggi'];
const envLevel = (process.env.PROMO_LEVEL || '').trim().toLowerCase();
const level = LEVELS.includes(envLevel) ? envLevel : P.defaultLevel;

function renderTemplate(str, vars) {
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : `{{${k}}}`));
}

function pickAngle(keyword) {
  const kl = KS.normalize(keyword);
  if (/\b(jual|beli|sewa|jasa|pesan|order)\b/.test(kl)) return P.angles.transaksional;
  const order = ['harga', 'hitung', 'carabuat', 'definisi', 'jenis', 'masalah', 'manfaat', 'waktu', 'ukuran', 'rekomendasi'];
  const intents = KS.analyze(keyword).intents;
  for (const i of order) if (intents.has(i) && P.angles[i]) return P.angles[i];
  return P.angles.default;
}

function injectPromo(prompt, keyword, lvl = level) {
  const block = renderTemplate(P.rules, {
    keyword,
    levelInstruction: P.levels[lvl],
    angle: pickAngle(keyword),
    facts: P.facts.map(f => `  • ${f}`).join('\n'),
  });
  const marker = 'Output HARUS dalam format berikut';
  return prompt.includes(marker) ? prompt.replace(marker, () => `${block}\n\n${marker}`) : `${prompt}\n\n${block}`;
}

const PROMO_RE = new RegExp(`(?<!!)\\[([^\\]]+)\\]\\((${P.promoLinks.map(u => u.replace(/[/]/g, '\\/')).join('|')})\\)`, 'g');
function protectPromoLinks(body) {
  const saved = []; 
  const out = body.replace(PROMO_RE, (m, text) => {
    if (saved.length >= P.maxPromoLinks) return text;       // kelebihan -> jadi teks biasa
    saved.push(m); return `⟦PROMO${saved.length - 1}⟧`;
  });
  return { body: out, saved };
}
function restorePromoLinks(body, saved) {
  return body.replace(/⟦PROMO(\d+)⟧/g, (_, i) => saved[+i] || '');
}
const isPromoUrl = u => P.promoLinks.includes(u);

function promoIssues(body, lvl = level) {
  const issues = [];
  for (const src of P.forbiddenClaims) {
    const m = body.match(new RegExp(src, 'i'));
    if (m) issues.push(`klaim terlarang terdeteksi: "${m[0]}"`);
  }
  if (/(\+62|\b0)8\d{2}[-\s.]?\d{3,4}[-\s.]?\d{3,5}/.test(body)) issues.push('ada nomor telepon dalam bentuk digit');
  if (lvl === 'tinggi' && !/\]\(\/(daftar-harga|product)\/\)/.test(body)) issues.push('tingkat promosi tinggi tetapi tidak ada link ke halaman Daftar Harga');
  return issues;
}

module.exports = { level, injectPromo, protectPromoLinks, restorePromoLinks, isPromoUrl, promoIssues, pickAngle };
