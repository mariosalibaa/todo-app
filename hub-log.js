// ── the hub's change log ────────────────────────────────────────────────────
// An account's lines have kept a log (and ↶ ↷) since 2026-09-08. Mario, 2026-09-09: everything
// the hub writes should keep one, so any page can show who changed what and put it back. Each
// area writes into its own collection, `logs/<area>/entries`, in the same shape the account log
// uses — { at, who, txId, line, before, after, undo } — so one reader and one client module
// serve them all.
const LOG_AREAS = ['transfers', 'gold', 'wise', 'budget', 'statements', 'daily', 'whatsapp'];
const logCol = (ws, area) => ws.collection('logs').doc(area).collection('entries');

// what changed, as two flat objects: only the keys whose value actually moved
function diffOf(cur, next, keys) {
  const before = {}, after = {};
  for (const k of keys) {
    const a = cur ? cur[k] : undefined, b = next ? next[k] : undefined;
    if (JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b)) continue;
    before[k] = a === undefined ? null : a;
    after[k] = b === undefined ? null : b;
  }
  return { before, after };
}

// A log that fails must never fail the write it describes.
async function hubLog(ws, area, entry) {
  if (!LOG_AREAS.includes(area)) return;
  try { await logCol(ws, area).add({ at: new Date().toISOString(), undo: false, ...entry }); }
  catch (e) { console.warn('hubLog ' + area, e.message); }
}

module.exports = { LOG_AREAS, logCol, diffOf, hubLog };
