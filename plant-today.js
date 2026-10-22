// Today's live reading of a plant, shared by every server instance through Firestore (plantToday/<key>) — Mario
// 2026-10-22: "loading is taking time … fix all other existing plants and future plants".
//
// On Vercel the 10-min memory caches were empty on most visits (a new instance), so every page load waited for
// DeyeCloud / Solarman (Mahab ~4 s, Bookstop / McKinsey ~12 s). Now a page asks twice:
//   1. stored (live = false)  whatever reading of today is kept, however old — answers from Firestore at once
//   2. live   (live = true)   only when (1) said `stale`: reads the cloud if the kept one is over `maxAge`, keeps it
// So the page paints from Firestore, then today's figures update a moment later.

const col = ctx => ctx.db.collection('workspaces').doc(ctx.TEAM_ID).collection('plantToday');
const mem = new Map();   // key → { day, at (ms), v }

async function today(ctx, key, day, read, { live = false, maxAge = 10 * 60000 } = {}) {
  let c = mem.get(key);
  if (!(c && c.day === day)) {
    const d = (await col(ctx).doc(key).get()).data();
    c = d && d.day === day ? { day, at: Date.parse(d.at), v: JSON.parse(d.j) } : null;
    if (c) mem.set(key, c);
  }
  const fresh = !!c && Date.now() - c.at < maxAge;
  if (c && (fresh || !live)) return { v: c.v, at: c.at, stale: !fresh };
  const v = await read();
  c = { day, at: Date.now(), v }; mem.set(key, c);
  // kept as JSON text: Firestore takes no arrays inside arrays (the time-view bars are)
  try { await col(ctx).doc(key).set({ day, at: new Date(c.at).toISOString(), j: JSON.stringify(v) }); }
  catch (e) { console.error('plant-today', key, e.message); }
  return { v, at: c.at, stale: false };
}

module.exports = { today };
