/**
 * tools/lib/dedupe-judge.js — helper murni (tanpa I/O) untuk penilaian duplikat oleh AI.
 * Dipisah dari dedupe-articles.js supaya parser jawaban AI bisa diuji sendiri.
 */
'use strict';

function renderTemplate(str, vars) {
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : `{{${k}}}`));
}

function excerptOf(body, n = 170) {
  return (body || '')
    .replace(/!\[.*?\]\(.*?\)/g, ' ').replace(/\{\{<[\s\S]*?>\}\}/g, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#*_>`|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
}

function candidatesBlock(cands) {
  return cands.map((c, i) => `${i + 1}. Judul: ${c.title} | Keyword: ${c.keyword || c.slug.replace(/-/g, ' ')} | Ringkasan: ${c.excerpt}`).join('\n');
}

function buildMessages(PROMPTS, seed, cands) {
  return [
    { role: 'system', content: PROMPTS.judge.systemTemplate },
    { role: 'user', content: renderTemplate(PROMPTS.judge.userTemplate, {
        seedTitle: seed.title, seedKeyword: seed.keyword || seed.slug.replace(/-/g, ' '),
        seedExcerpt: seed.excerpt, candidates: candidatesBlock(cands),
    }) },
  ];
}

/**
 * Parse jawaban AI. Mengembalikan { ids:[1-based], reason } atau { error }.
 * Ketat: nomor di luar 1..n dibuang; kalau "DUPLIKAT:" ada tapi tidak ada nomor valid dan bukan
 * TIDAK_ADA, dianggap error (bukan "tidak ada duplikat"), supaya jawaban rusak tidak dianggap keputusan.
 */
function parseVerdict(text, n) {
  const t = String(text || '');
  const m = t.match(/DUPLIKAT\s*:\s*([^\n\r]*)/i);
  if (!m) return { error: 'format tidak sesuai (baris DUPLIKAT: tidak ditemukan)' };
  const reason = ((t.match(/ALASAN\s*:\s*([^\n\r]*)/i) || [])[1] || '').trim();
  const v = m[1].trim();
  if (/TIDAK[_\s-]?ADA/i.test(v)) return { ids: [], reason };
  const ids = [...new Set([...v.matchAll(/\d+/g)].map(x => parseInt(x[0], 10)).filter(i => i >= 1 && i <= n))];
  if (!ids.length) return { error: `tidak ada nomor kandidat valid pada "${v.slice(0, 40)}"` };
  return { ids, reason };
}

module.exports = { renderTemplate, excerptOf, candidatesBlock, buildMessages, parseVerdict };
