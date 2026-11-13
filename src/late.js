// Late-submission policy. Submissions are NEVER blocked; late work gets a progressive deduction
// (percent of the assignment's max points). Times are Baku time (Asia/Baku, UTC+4, no DST).
// Policy text format, editable per assignment: "24:5, 72:10, 168:20, *:30"
// = up to 24h late −5%, up to 72h (3 days) −10%, up to 168h (7 days) −20%, beyond −30% (cap).
const DEFAULT_POLICY = '24:5, 72:10, 168:20, *:30';
function parsePolicy(text) {
  const steps = []; let cap = null;
  for (const part of String(text || DEFAULT_POLICY).split(',').map(x => x.trim()).filter(Boolean)) {
    const m = part.match(/^(\*|\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/); if (!m) throw new Error(`Bad late-policy step "${part}" (use hours:percent, e.g. 24:5, and *:30 for the cap)`);
    const pct = Number(m[2]); if (pct < 0 || pct > 100) throw new Error('Percent must be 0–100');
    if (m[1] === '*') cap = pct; else steps.push({ hours: Number(m[1]), pct });
  }
  steps.sort((a, b) => a.hours - b.hours);
  if (cap == null) cap = steps.length ? steps[steps.length - 1].pct : 0;
  return { steps, cap };
}
const normalizePolicy = text => { const p = parsePolicy(text); return [...p.steps.map(s => `${s.hours}:${s.pct}`), `*:${p.cap}`].join(', '); };
function deductionPct(minutesLate, policyText) {
  if (!minutesLate || minutesLate <= 0) return 0;
  const { steps, cap } = parsePolicy(policyText); const h = minutesLate / 60;
  for (const s of steps) if (h <= s.hours) return s.pct;
  return cap;
}
// Baku has been UTC+4 with no DST since 2016.
const BAKU_OFFSET_MIN = 240;
// "2026-11-17" + "19:00" (Baku) -> "2026-11-17T15:00:00.000Z"
function bakuToUtcIso(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !/^\d{2}:\d{2}$/.test(String(time || ''))) return null;
  const [y, mo, d] = date.split('-').map(Number); const [hh, mm] = time.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, hh, mm) - BAKU_OFFSET_MIN * 60e3).toISOString();
}
const parseUtc = s => s ? new Date(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z') : null;
function fmtBaku(s) { const d = parseUtc(s); if (!d || isNaN(d)) return ''; const b = new Date(d.getTime() + BAKU_OFFSET_MIN * 60e3); return b.toISOString().slice(0, 16).replace('T', ' '); }
const bakuParts = s => { const f = fmtBaku(s); return f ? { date: f.slice(0, 10), time: f.slice(11, 16) } : { date: '', time: '' }; };
function minutesLate(dueIso, submittedAt) { const d = parseUtc(dueIso), s = parseUtc(submittedAt); if (!d || !s) return 0; return Math.max(0, Math.ceil((s - d) / 60e3)); }
function lateText(min, lang) {
  if (!min) return lang === 'az' ? 'Vaxtında' : 'On time';
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  const parts = lang === 'az' ? [d && `${d} gün`, h && `${h} saat`, !d && m && `${m} dəqiqə`] : [d && `${d}d`, h && `${h}h`, !d && m && `${m}m`];
  return (lang === 'az' ? 'Gecikmə: ' : 'Late by ') + parts.filter(Boolean).join(' ');
}
const round1 = n => Math.round(n * 10) / 10;
// raw score -> { deduction_points, final }
function applyDeduction(raw, maxPoints, pct) { const ded = round1((Number(pct) || 0) / 100 * (Number(maxPoints) || 0)); return { deduction_points: ded, final: round1(Math.max(0, Number(raw) - ded)) }; }
module.exports = { DEFAULT_POLICY, parsePolicy, normalizePolicy, deductionPct, bakuToUtcIso, fmtBaku, bakuParts, minutesLate, lateText, applyDeduction, round1 };
