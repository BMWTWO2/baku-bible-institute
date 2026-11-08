// Homework helper: drafts Azerbaijani corrections. Uses an LLM only if OPENAI_API_KEY is set; otherwise a deterministic SAMPLE draft.
const COMMON = [[/\bmen\b/gi, 'mən'], [/\bsen\b/gi, 'sən'], [/\bAllah\b/g, 'Allah'], [/\bisa\b/gi, 'İsa'], [/\bincil\b/gi, 'İncil'], [/\bmesih\b/gi, 'Məsih'], [/\bkilse\b/gi, 'kilsə'], [/\bdua edirem\b/gi, 'dua edirəm'], [/\bsevgi\b/g, 'sevgi'], [/\bçox yaxsi\b/gi, 'çox yaxşı'], [/\byaxsi\b/gi, 'yaxşı'], [/\bkitab-i mugeddes\b/gi, 'Müqəddəs Kitab'], [/\bmuqeddes\b/gi, 'müqəddəs'], [/\bbiz(?:e|ə)\b/gi, 'bizə']];
function sampleDraft(body, studentName) {
  const text = String(body || ''); const changes = [];
  for (const [re, rep] of COMMON) { const m = text.match(re); if (m) for (const w of new Set(m)) if (w !== rep) changes.push(`«${w}» → «${rep}»`); }
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const sentences = text.split(/[.!?]+/).filter(s => s.trim()).length || 1;
  const noCap = text.split(/(?<=[.!?])\s+/).filter(s => s && /^[a-zəöüğışç]/.test(s)).length;
  const lines = [
    '⚠️ NÜMUNƏ QARALAMA (SAMPLE DRAFT) — avtomatik nümunədir, müəllim yoxlayıb təsdiq etməlidir.', '',
    `Hörmətli ${studentName || 'tələbə'},`, '',
    `Ev tapşırığınız üçün təşəkkür edirik. Mətniniz ${words} söz və ${sentences} cümlədən ibarətdir.`,
    '', 'Güclü tərəflər:', '• Fikrinizi aydın ifadə etmisiniz və mövzuya uyğun yazmısınız.',
    '', 'Düzəlişlər:',
    ...(changes.length ? changes.map(c => '• Orfoqrafiya: ' + c) : ['• Orfoqrafik səhv aşkar edilmədi.']),
    ...(noCap ? [`• ${noCap} cümlə kiçik hərflə başlayır — cümləni böyük hərflə başlayın.`] : []),
    ...(words < 80 ? ['• Cavabı genişləndirin: ən azı bir Müqəddəs Kitab ayəsi ilə (məs., Yəhya 3:16) fikrinizi əsaslandırın.'] : ['• Ayə istinadlarını kitab, fəsil və ayə ilə dəqiq göstərin.']),
    '', 'Növbəti addım: düzəlişləri edib mətnin son variantını yenidən göndərin.', '', 'Allah sizi bərəkətləndirsin!'];
  return { text: lines.join('\n'), isSample: true, by: 'Homework Helper (sample, no AI key)' };
}
async function draftCorrection(body, studentName) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return sampleDraft(body, studentName);
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', messages: [
        { role: 'system', content: 'You are a kind Bible institute teaching assistant in Baku. Write homework feedback ONLY in Azerbaijani (Latin script). List strengths, concrete spelling/grammar corrections (wrong → right), and one next step. A professor will review before the student sees it.' },
        { role: 'user', content: `Student: ${studentName}\nSubmission:\n${body}` }] }) });
    const j = await r.json(); const text = j.choices?.[0]?.message?.content;
    if (!text) throw new Error('no content');
    return { text: 'QARALAMA (AI) — müəllim təsdiqi gözlənilir.\n\n' + text, isSample: false, by: 'Homework Helper (AI)' };
  } catch { return sampleDraft(body, studentName); }
}
module.exports = { draftCorrection, sampleDraft };
