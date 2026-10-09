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
 * Parse jawaban AI format per-kandidat:
 *   N: OBJEK=SAMA; MAKSUD=SAMA; VONIS=DUPLIKAT; ALASAN=...
 * DUPLIKAT hanya jika OBJEK=SAMA && MAKSUD=SAMA && VONIS=DUPLIKAT (ketiganya harus konsisten).
 * Baris yang hilang / tidak terbaca dianggap BUKAN. Jika SATU baris pun tidak terbaca => error
 * (jawaban rusak tidak boleh dianggap keputusan "tidak ada duplikat").
 */
function parseVerdict(text, n) {
  const lines = String(text || '').split(/\r?\n/);
  const detail = [];
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\s*[:.)\-]\s*(.+)$/);
    if (!m) continue;
    const num = parseInt(m[1], 10);
    if (num < 1 || num > n) continue;
    const g = k => ((m[2].match(new RegExp(k + '\\s*=\\s*([A-Za-z_]+)', 'i')) || [])[1] || '').toUpperCase();
    const reason = ((m[2].match(/ALASAN\s*=\s*(.*)$/i) || [])[1] || '').trim();
    const objek = g('OBJEK'), maksud = g('MAKSUD'), vonis = g('VONIS');
    if (!objek && !maksud && !vonis) continue;
    detail.push({ n: num, objek, maksud, vonis, reason });
  }
  if (!detail.length) return { error: 'format tidak sesuai (tidak ada baris "N: OBJEK=..; MAKSUD=..; VONIS=.." yang terbaca)' };
  const byN = new Map();
  for (const d of detail) if (!byN.has(d.n)) byN.set(d.n, d);
  const dups = [...byN.values()].filter(d => d.objek === 'SAMA' && d.maksud === 'SAMA' && d.vonis === 'DUPLIKAT');
  return { ids: dups.map(d => d.n), reason: dups.map(d => `#${d.n}: ${d.reason}`).join(' | '), detail: [...byN.values()] };
}

module.exports = { renderTemplate, excerptOf, candidatesBlock, buildMessages, parseVerdict };
