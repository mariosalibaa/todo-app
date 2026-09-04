// Probe what a PERSONAL Wise API token can actually read.
//
// Wise blocks statement endpoints on personal accounts (PSD2: request signing for strong
// customer authentication was withdrawn). But statements are not the only way to get
// transactions — the Activities and Transfers endpoints are not behind SCA. This script
// finds out which of them answer, so we know whether continuous import is possible at all.
//
// Put the token in %USERPROFILE%\.wise\token.txt (one line) or pass it as argv[2].
const fs = require('fs'), os = require('os'), path = require('path');

const tokenFile = path.join(os.homedir(), '.wise', 'token.txt');
const TOKEN = (process.argv[2] || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8') : '')).trim();
if (!TOKEN) {
  console.error('No token. Put it in ' + tokenFile + ' or pass it as an argument.');
  process.exit(1);
}
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
const API = 'https://api.transferwise.com';

async function get(url, label) {
  try {
    const r = await fetch(API + url, { headers: H });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
    const sca = r.headers.get('x-2fa-approval') ? ' [SCA challenge]' : '';
    console.log(`${String(r.status).padEnd(4)} ${label.padEnd(34)} ${sca}`);
    if (r.status >= 400) console.log('       ' + JSON.stringify(body).slice(0, 220));
    return r.ok ? body : null;
  } catch (e) {
    console.log(`ERR  ${label.padEnd(34)} ${e.message}`);
    return null;
  }
}

(async () => {
  console.log('token tail …' + TOKEN.slice(-6) + '\n');

  const profiles = await get('/v2/profiles', 'v2/profiles');
  if (!profiles || !profiles.length) { console.log('\nNo profiles — the token is wrong or revoked.'); process.exit(1); }
  profiles.forEach(p => console.log('       profile', p.id, p.type, (p.fullName || (p.details && p.details.name) || '')));
  const prof = profiles.find(p => String(p.type).toUpperCase() === 'PERSONAL') || profiles[0];
  const id = prof.id;
  console.log('\nusing profile', id, '\n');

  const balances = await get(`/v4/profiles/${id}/balances?types=STANDARD`, 'v4 balances (STANDARD)');
  if (balances) balances.forEach(b => console.log('       balance', b.id, b.currency, b.amount && b.amount.value));

  // the routes that are NOT behind strong customer authentication
  const since = new Date(Date.now() - 60 * 86400000).toISOString();
  const until = new Date().toISOString();
  await get(`/v1/profiles/${id}/activities?size=20`, 'v1 activities  <-- the hope');
  await get(`/v1/profiles/${id}/activities?size=20&since=${since}`, 'v1 activities since');
  await get(`/v1/transfers?profile=${id}&limit=20&offset=0`, 'v1 transfers');
  await get(`/v3/profiles/${id}/transfers?limit=20`, 'v3 transfers');
  await get(`/v1/card-transactions?profileId=${id}&size=20`, 'v1 card transactions');

  // and the one Wise says is closed, to confirm it with a real response
  if (balances && balances.length) {
    const b = balances[0];
    await get(`/v1/profiles/${id}/balance-statements/${b.id}/statement.json`
      + `?currency=${b.currency}&intervalStart=${since}&intervalEnd=${until}&type=COMPACT`,
      'statement.json (expected blocked)');
  }

  console.log('\nAnything answering 200 above can drive a continuous import.');
})();
