// Who may see what on the Day report. A partner holding only `daily` reads the lines of his own
// projects, accepted ones only — never a suggestion, never another project (Mario, 2026-09-12).
const isSuggestion = t => (t.src === 'whatsapp' || t.src === 'site') && !t.waAccepted;
const analyticIds = t => Array.isArray(t.analyticSplit) && t.analyticSplit.length
  ? t.analyticSplit.map(s => +s.id) : t.analyticId ? [+t.analyticId] : [];
function filterForPartner(lines, projects) {
  const allowed = new Set((projects || []).map(Number));
  if (!allowed.size) return [];
  return lines.filter(t => !isSuggestion(t) && !t.excluded && analyticIds(t).some(id => allowed.has(id)));
}
const readOnlyFor = access => !access.admin && !(access.apps || []).includes('accounting') && (access.apps || []).includes('daily');
module.exports = { filterForPartner, readOnlyFor, isSuggestion };
