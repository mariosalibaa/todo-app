// Ajaltoun 4193 — machines & trucks from the site cameras (Mario, 2026-10-10).
// Static data reviewed from the SD cards: data/excavation-days.json (hours per machine and truck loads per
// day) and data/excavation-loads.json (every truck load with a photo and how well it was filled).
// Photos live in public/excavation/loads/ and are only handed out here, behind the same access as
// /api/ajaltoun (the 'ajaltoun' or 'excavation' app).
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const PHOTOS = path.join(__dirname, 'public', 'excavation', 'loads');

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); } catch { return fallback; }
}

async function handle(req, res, url) {
  const p = url.split('?')[0];
  if (p === '/api/ajaltoun/machines' && req.method === 'GET') {
    const days = readJson('excavation-days.json', { days: [] });
    const loads = readJson('excavation-loads.json', []);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    const diesel = readJson('excavation-diesel.json', null);
    const flags = readJson('excavation-flags.json', []);
    res.end(JSON.stringify({ ...days, loads, diesel, flags }));
    return true;
  }
  const m = p.match(/^\/api\/ajaltoun\/machines\/photo\/(\d{8}_\d{4}[\w-]*\.jpg)$/);
  if (m && req.method === 'GET') {
    const f = path.join(PHOTOS, m[1]);
    if (!fs.existsSync(f)) { res.writeHead(404); res.end('not found'); return true; }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
    res.end(fs.readFileSync(f));
    return true;
  }
  const fl = p.match(/^\/api\/ajaltoun\/machines\/flag\/(\d{8}_\d{2}\.jpg)$/);
  if (fl && req.method === 'GET') {
    const f = path.join(__dirname, 'public', 'excavation', 'flags', fl[1]);
    if (!fs.existsSync(f)) { res.writeHead(404); res.end('not found'); return true; }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
    res.end(fs.readFileSync(f));
    return true;
  }
  return false;
}

module.exports = { handle };
