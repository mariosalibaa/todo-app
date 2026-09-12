// What the Anthropic API has actually cost, day by day, straight from the Admin API.
//   node _api-cost.mjs [--since 2026-06-01] [--by model|workspace|key]
// The admin key lives in %USERPROFILE%/.anthropic-admin.json — never in a repo (Mario, 2026-09-08).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const KEY = JSON.parse(readFileSync(join(homedir(), ".anthropic-admin.json"), "utf8")).adminKey;
const SINCE = arg("since", "2026-06-01") + "T00:00:00Z";
const BY = arg("by", "");

const get = async (path) => {
  const r = await fetch("https://api.anthropic.com" + path, {
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01" },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
};
const q = new URLSearchParams({ starting_at: SINCE, bucket_width: "1d", limit: "31" });
if (BY) q.append("group_by", BY);
let url = "/v1/organizations/cost_report?" + q;
let total = 0; const rows = [], byGroup = {};
for (let page = 0; page < 20 && url; page++) {
  const j = await get(url);
  for (const b of j.data || []) {
    let day = 0;
    for (const r of b.results || []) {
      const amt = +(r.amount ?? r.cost ?? 0);
      day += amt; total += amt;
      const g = r.description || (r.model || r.workspace_id || r.api_key_id || "");
      if (g) byGroup[g] = (byGroup[g] || 0) + amt;
    }
    if (day) rows.push([String(b.starting_at).slice(0, 10), day]);
  }
  url = j.has_more && j.next_page ? "/v1/organizations/cost_report?" + new URLSearchParams({ ...Object.fromEntries(q), page: j.next_page }) : null;
}
rows.forEach(([d, v]) => console.log(d, "$" + v.toFixed(2)));
if (Object.keys(byGroup).length) {
  console.log("\nby " + (BY || "line"));
  Object.entries(byGroup).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log("  " + k.padEnd(40), "$" + v.toFixed(2)));
}
console.log("\nTOTAL since " + SINCE.slice(0, 10) + ": $" + total.toFixed(2));
