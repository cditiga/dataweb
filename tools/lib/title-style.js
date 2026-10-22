/**
 * tools/lib/title-style.js
 *
 * Membuat judul artikel AI lebih natural & bervariasi:
 *   - pickTitleStyle()          : memilih satu gaya judul (acak, tidak mengulang gaya sebelumnya di run yang sama)
 *   - injectTitleInstruction()  : menyisipkan ATURAN JUDUL + gaya terpilih ke prompt artikel (tanpa mengubah JSON prompt)
 *   - fixTitle()                : membersihkan judul dari AI; kalau keyword hilang -> pakai keyword sebagai judul
 *   - titleIssues()             : daftar peringatan (titik dua, frasa klise, terlalu panjang, keyword hilang)
 */
'use strict';
const T = require('../prompts/title-styles.json');
const KS = require('./keyword-similarity.js');

let lastName = '';
// level promosi memengaruhi komposisi gaya: tinggi = dominan gaya berorientasi pembeli (+ beberapa gaya netral agar tetap variatif)
const NEUTRAL_FOR_PROMO = ['pertanyaan', 'cara-langkah', 'pertimbangan', 'koma'];
function pickTitleStyle(level = 'rendah') {
  let pool = T.styles;
  if (level === 'sedang') pool = T.styles.concat(T.promoStyles || []);
  if (level === 'tinggi') pool = (T.promoStyles || []).concat(T.styles.filter(s => NEUTRAL_FOR_PROMO.includes(s.name)));
  let st;
  do { st = pool[Math.floor(Math.random() * pool.length)]; } while (pool.length > 1 && st.name === lastName);
  lastName = st.name;
  return st;
}

function renderTemplate(str, vars) {
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : `{{${k}}}`));
}

function injectTitleInstruction(prompt, keyword, style) {
  const block = renderTemplate(T.rules, { keyword, titleStyle: style.instruction, banned: T.banned.map(b => `"${b}"`).join(', ') });
  const marker = 'Output HARUS dalam format berikut';
  let out = prompt.includes(marker) ? prompt.replace(marker, () => `${block}\n\n${marker}`) : `${prompt}\n\n${block}`;
  out = out.replace(/JUDUL:\s*\[[^\]]*\]/, () => 'JUDUL: [judul artikel sesuai ATURAN JUDUL di atas, tanpa tanda #]');
  return out;
}

const SMALL = new Set(['di', 'ke', 'dari', 'untuk', 'dan', 'yang', 'dengan', 'atau', 'per', 'pada', 'dalam']);
function toTitleCase(text) {
  return String(text).trim().split(/\s+/).map((w, i) => (i > 0 && SMALL.has(w.toLowerCase())) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function hasKeyword(title, keyword) {
  const nt = ` ${KS.normalize(title)} `;
  const words = KS.normalize(keyword).split(' ').filter(Boolean);
  return words.length > 0 && words.every(w => nt.includes(` ${w} `));
}

function titleIssues(title, keyword) {
  const issues = [];
  if (!hasKeyword(title, keyword)) issues.push('keyword tidak ada di judul');
  if (/:/.test(title)) issues.push('judul memakai tanda titik dua (:)');
  if (/[|—]/.test(title)) issues.push('judul memakai | atau —');
  const low = title.toLowerCase();
  const hit = T.banned.filter(b => low.includes(b.toLowerCase()));
  if (hit.length) issues.push(`frasa klise: ${hit.join(', ')}`);
  if (title.length > 70) issues.push(`judul terlalu panjang (${title.length} karakter)`);
  return issues;
}

function fixTitle(rawTitle, keyword) {
  let title = String(rawTitle || '').replace(/\*\*/g, '').replace(/^["'“”]+|["'“”]+$/g, '').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim().replace(/[.]+$/, '');
  if (!title || !hasKeyword(title, keyword)) {
    return { title: toTitleCase(keyword), changed: true, reason: 'keyword tidak ada di judul AI' };
  }
  return { title, changed: title !== String(rawTitle || '').trim(), reason: 'dibersihkan' };
}

module.exports = { pickTitleStyle, injectTitleInstruction, fixTitle, titleIssues, toTitleCase, hasKeyword, styles: T.styles, promoStyles: T.promoStyles, banned: T.banned };
