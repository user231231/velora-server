'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

let server, fake, base, dataDir;

const call = async (method, url, body, headers = {}) => {
  const isBuf = Buffer.isBuffer(body);
  const res = await fetch(base + url, {
    method,
    headers: body === undefined ? headers : { 'Content-Type': isBuf ? 'application/octet-stream' : 'application/json', ...headers },
    body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data, headers: res.headers };
};

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
  // Fake-BRouter
  fake = http.createServer((req, res) => {
    if (req.url.includes('bad')) { res.writeHead(500); return res.end('kaputt'); }
    res.writeHead(200, { 'Content-Type': 'application/gpx+xml' });
    res.end('<gpx><trk><trkseg><trkpt lat="50" lon="7"><ele>1</ele></trkpt></trkseg></trk></gpx>');
  });
  await new Promise((r) => fake.listen(0, r));
  server = createApp({
    dataDir,
    webDir: path.join(__dirname, '..', 'web'),
    brouterUrl: `http://127.0.0.1:${fake.address().port}/brouter`,
    seedExamples: false,
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fake.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('Start: zwei Nutzer und sechs eingebaute Workouts', async () => {
  const u = await call('GET', '/api/users');
  assert.equal(u.data.length, 2);
  assert.equal(u.data[0].ftp, 200);
  const w = await call('GET', '/api/workouts');
  assert.equal(w.data.length, 6);
  assert.ok(w.data.every((x) => x.builtIn));
  assert.equal(w.data.find((x) => x.id === 'builtin_ramp').steps.length, 33);
});

test('Nutzerprofil ändern und validieren', async () => {
  const [a, b] = (await call('GET', '/api/users')).data;
  const put = await call('PUT', `/api/users/${a.id}`, { name: 'Michael', ftp: 250, riderKg: 82.5 });
  assert.equal(put.status, 200);
  const re = await call('GET', `/api/users/${a.id}`);
  assert.equal(re.data.name, 'Michael');
  assert.equal(re.data.ftp, 250);
  const other = await call('GET', `/api/users/${b.id}`);
  assert.equal(other.data.ftp, 200); // unabhängig
  assert.equal((await call('PUT', `/api/users/${a.id}`, { ftp: 5000 })).status, 400);
  assert.equal((await call('GET', '/api/users/nicht_da')).status, 404);
});

test('Favoriten gelten je Nutzer', async () => {
  const [a, b] = (await call('GET', '/api/users')).data;
  await call('PUT', `/api/users/${a.id}/favorites/workouts/builtin_ramp`);
  await call('PUT', `/api/users/${a.id}/favorites/workouts/builtin_ramp`); // doppelt
  const fa = (await call('GET', `/api/users/${a.id}`)).data.favorites;
  const fb = (await call('GET', `/api/users/${b.id}`)).data.favorites;
  assert.deepEqual(fa.workouts, ['builtin_ramp']);
  assert.deepEqual(fb.workouts, []);
  await call('DELETE', `/api/users/${a.id}/favorites/workouts/builtin_ramp`);
  assert.deepEqual((await call('GET', `/api/users/${a.id}`)).data.favorites.workouts, []);
  assert.equal((await call('PUT', `/api/users/${a.id}/favorites/unsinn/x`)).status, 400);
});

test('Workouts: anlegen, ändern, löschen, Schutz eingebauter', async () => {
  const bad = await call('POST', '/api/workouts', { name: 'x', steps: [] });
  assert.equal(bad.status, 400);
  const c = await call('POST', '/api/workouts', { name: 'Mein Test', steps: [{ s: 60, a: 80, b: 100, l: 'Rampe' }, { s: 30, a: 50 }] });
  assert.equal(c.status, 200);
  assert.equal(c.data.steps[1].b, 50);
  const u = await call('PUT', `/api/workouts/${c.data.id}`, { name: 'Neu', steps: [{ s: 120, a: 70 }] });
  assert.equal(u.data.name, 'Neu');
  assert.equal((await call('PUT', '/api/workouts/builtin_ramp', { name: 'x', steps: [{ s: 1, a: 50 }] })).status, 403);
  assert.equal((await call('DELETE', '/api/workouts/builtin_ramp')).status, 403);
  const [a] = (await call('GET', '/api/users')).data;
  await call('PUT', `/api/users/${a.id}/favorites/workouts/${c.data.id}`);
  assert.equal((await call('DELETE', `/api/workouts/${c.data.id}`)).status, 200);
  assert.deepEqual((await call('GET', `/api/users/${a.id}`)).data.favorites.workouts, []); // Favorit aufgeräumt
});

test('Strecken: anlegen, lesen, Statistik, löschen', async () => {
  assert.equal((await call('POST', '/api/routes', { name: 'x', lat: [1], lon: [1], ele: [1] })).status, 400);
  assert.equal((await call('POST', '/api/routes', { name: 'x', lat: [95, 1], lon: [1, 1], ele: [1, 2] })).status, 400);
  const lat = Array.from({ length: 21 }, (_, i) => 50 + i * 0.00045), lon = lat.map(() => 7), ele = lat.map((_, i) => 100 + i * 4);
  const c = await call('POST', '/api/routes', { name: 'Testberg', lat, lon, ele });
  assert.equal(c.status, 200);
  assert.ok(Math.abs(c.data.length - 1000) < 15);
  assert.ok(c.data.ascent > 50 && c.data.ascent <= 80);
  const list = await call('GET', '/api/routes');
  assert.equal(list.data[0].name, 'Testberg');
  assert.equal(list.data[0].lat, undefined); // Liste ohne Punkte
  const full = await call('GET', `/api/routes/${c.data.id}`);
  assert.deepEqual(full.data.ele, ele);
  const ren = await call('PUT', `/api/routes/${c.data.id}`, { name: 'Umbenannt' });
  assert.equal(ren.data.name, 'Umbenannt');
  assert.equal((await call('DELETE', `/api/routes/${c.data.id}`)).status, 200);
  assert.equal((await call('GET', `/api/routes/${c.data.id}`)).status, 404);
});

test('Fahrten: Upload, Liste, Download, Löschen', async () => {
  const [a, b] = (await call('GET', '/api/users')).data;
  const fit = Buffer.concat([Buffer.from([14, 0x20, 0x54, 0x08, 4, 0, 0, 0]), Buffer.from('.FIT'), Buffer.from([0, 0, 1, 2, 3, 4])]);
  assert.equal((await call('POST', `/api/users/${a.id}/rides`, Buffer.from('kein fit'))).status, 400);
  const up = await call('POST', `/api/users/${a.id}/rides?durationS=3600&distanceM=30000&avgPower=210&workout=Sweet%20Spot`, fit);
  assert.equal(up.status, 200);
  assert.equal(up.data.avgPower, 210);
  assert.equal((await call('GET', `/api/users/${a.id}/rides`)).data.length, 1);
  assert.equal((await call('GET', `/api/users/${b.id}/rides`)).data.length, 0);
  const dl = await call('GET', `/api/users/${a.id}/rides/${up.data.id}/fit`);
  assert.deepEqual(dl.data, fit);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.equal((await call('DELETE', `/api/users/${a.id}/rides/${up.data.id}`)).status, 200);
  assert.equal((await call('GET', `/api/users/${a.id}/rides`)).data.length, 0);
});

test('Sicherheit: Pfadtricks werden abgewiesen', async () => {
  assert.equal((await call('GET', '/api/routes/..%2Fusers')).status, 400);
  assert.equal((await call('GET', '/..%2Fserver.js')).status, 404);
  assert.equal((await call('GET', '/%2e%2e/server.js')).status, 404);
  assert.equal((await call('GET', '/api/users/..%2F..%2Fx/rides')).status, 400);
});

test('Routing-Proxy leitet weiter und prüft Eingaben', async () => {
  const ok = await call('GET', '/api/brouter?lonlats=7,50|7.1,50.1&profile=fastbike');
  assert.equal(ok.status, 200);
  assert.match(ok.data.toString(), /trkpt/);
  assert.equal((await call('GET', '/api/brouter?lonlats=abc')).status, 400);
  assert.equal((await call('GET', '/api/brouter?lonlats=7,50|7.1,50.1&profile=bad')).status, 200); // unbekanntes Profil wird zu fastbike
});

test('Nutzer anlegen und löschen, letzter bleibt', async () => {
  const c = await call('POST', '/api/users', { name: 'Gast' });
  assert.equal(c.data.name, 'Gast');
  assert.equal((await call('DELETE', `/api/users/${c.data.id}`)).status, 200);
  const all = (await call('GET', '/api/users')).data;
  for (const u of all.slice(1)) await call('DELETE', `/api/users/${u.id}`);
  assert.equal((await call('DELETE', `/api/users/${all[0].id}`)).status, 400);
});

test('Daten überleben Neustart', async () => {
  const again = createApp({ dataDir, webDir: null, brouterUrl: 'http://x', seedExamples: false });
  await new Promise((r) => again.listen(0, r));
  const res = await fetch(`http://127.0.0.1:${again.address().port}/api/users`);
  const users = await res.json();
  assert.equal(users.length, 1);
  again.close();
});

test('Ordner: anlegen, Strecke verschieben, umbenennen, löschen', async () => {
  const pts = (n) => Array.from({ length: n }, (_, i) => i);
  const body = { name: 'T1', lat: pts(5).map((i) => 50 + i * 0.001), lon: pts(5).map(() => 7), ele: pts(5).map((i) => 100 + i) };
  const r = (await call('POST', '/api/routes', body)).data;
  assert.equal(r.folder, '');
  assert.deepEqual((await call('POST', '/api/folders', { name: 'Eifel' })).data, ['Eifel']);
  assert.equal((await call('POST', '/api/folders', { name: 'a/b' })).status, 400);
  const m = await call('PUT', `/api/routes/${r.id}`, { folder: 'Eifel' });
  assert.equal(m.data.folder, 'Eifel');
  assert.equal(m.data.name, 'T1');
  assert.equal((await call('PUT', `/api/folders/${encodeURIComponent('Eifel')}`, { name: 'Eifel Touren' })).status, 200);
  assert.equal((await call('GET', '/api/routes')).data.find((x) => x.id === r.id).folder, 'Eifel Touren');
  assert.equal((await call('POST', '/api/folders', { name: 'Zweiter' })).status, 200);
  assert.equal((await call('PUT', `/api/folders/${encodeURIComponent('Zweiter')}`, { name: 'Eifel Touren' })).status, 409);
  await call('DELETE', `/api/folders/${encodeURIComponent('Eifel Touren')}`);
  assert.equal((await call('GET', '/api/routes')).data.find((x) => x.id === r.id).folder, '');
  assert.deepEqual((await call('GET', '/api/folders')).data, ['Zweiter']);
  await call('DELETE', `/api/routes/${r.id}`);
});

test('Beispielstrecken werden einmalig im Ordner Beispiele angelegt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ex-'));
  const fake2 = http.createServer((req, res) => {
    const trk = Array.from({ length: 21 }, (_, i) => i).map((i) => `<trkpt lat="${50 + i * 0.002}" lon="7"><ele>${100 + i * 10}</ele></trkpt>`).join('');
    res.writeHead(200, { 'Content-Type': 'application/gpx+xml' });
    res.end(`<gpx><trk><trkseg>${trk}</trkseg></trk></gpx>`);
  });
  await new Promise((r) => fake2.listen(0, r));
  const mk = () => createApp({ dataDir: dir, webDir: path.join(__dirname, '..', 'web'), brouterUrl: `http://127.0.0.1:${fake2.address().port}/b` });
  const s1 = mk(); await s1.seeding;
  const list = () => JSON.parse(fs.readFileSync(path.join(dir, 'examples_done.json'), 'utf8'));
  assert.equal(list().length, 7);
  const files = fs.readdirSync(path.join(dir, 'routes'));
  assert.equal(files.length, 7);
  const one = JSON.parse(fs.readFileSync(path.join(dir, 'routes', files[0]), 'utf8'));
  assert.equal(one.folder, 'Beispiele');
  assert.ok(one.ascent > 0);
  fs.unlinkSync(path.join(dir, 'routes', files[0]));
  const s2 = mk(); await s2.seeding;
  assert.equal(fs.readdirSync(path.join(dir, 'routes')).length, 6);
  fake2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Nutzer: Icon und Farbe ändern, ungültige Werte abweisen', async () => {
  const us = (await call('GET', '/api/users')).data;
  assert.ok(us[0].icon && us[0].color);
  const id = us[0].id;
  assert.equal((await call('PUT', `/api/users/${id}`, { icon: 'mountain', color: '#00bfa5' })).data.color, '#00BFA5');
  assert.equal((await call('PUT', `/api/users/${id}`, { icon: 'unbekannt' })).status, 400);
  assert.equal((await call('PUT', `/api/users/${id}`, { color: 'rot' })).status, 400);
  assert.equal((await call('GET', '/api/users')).data.find((u) => u.id === id).icon, 'mountain');
});

test('Virtuelle Strecken: anlegen, ändern, löschen, prüfen', async () => {
  assert.deepEqual((await call('GET', '/api/worlds')).data, []);
  assert.equal((await call('POST', '/api/worlds', { name: 'x', terrain: 'ocean', kind: 'time', value: 30 })).status, 400);
  assert.equal((await call('POST', '/api/worlds', { name: 'x', terrain: 'hills', kind: 'time', value: 1 })).status, 400);
  const c = await call('POST', '/api/worlds', { name: 'Hügel 45 min', terrain: 'hills', kind: 'time', value: 45, seed: 7 });
  assert.equal(c.status, 200);
  assert.equal(c.data.seed, 7);
  const u = await call('PUT', `/api/worlds/${c.data.id}`, { name: 'Berge 30 km', terrain: 'mountains', kind: 'length', value: 30000 });
  assert.equal(u.data.terrain, 'mountains');
  assert.equal(u.data.seed, 7);
  assert.equal((await call('DELETE', `/api/worlds/${c.data.id}`)).status, 200);
  assert.deepEqual((await call('GET', '/api/worlds')).data, []);
});

// ---- FIT-Workout-Import ----
function fitWorkout(steps, name = 'Test-Workout') {
  const recs = [];
  const def = (local, global, fields) => {
    recs.push(Buffer.from([0x40 | local, 0, 0, global & 255, global >> 8, fields.length, ...fields.flatMap((f) => [f.num, f.size, f.base])]));
  };
  const data = (local, vals) => {
    const parts = [Buffer.from([local])];
    for (const v of vals) {
      if (typeof v === 'string') parts.push(Buffer.from(v + '\0'));
      else if (v.size === 1) parts.push(Buffer.from([v.v]));
      else if (v.size === 2) { const b = Buffer.alloc(2); b.writeUInt16LE(v.v); parts.push(b); }
      else { const b = Buffer.alloc(4); b.writeUInt32LE(v.v); parts.push(b); }
    }
    recs.push(Buffer.concat(parts));
  };
  def(0, 0, [{ num: 0, size: 1, base: 0 }]);
  data(0, [{ size: 1, v: 5 }]);
  const nameLen = Buffer.byteLength(name) + 1;
  def(1, 26, [{ num: 8, size: nameLen, base: 7 }]);
  data(1, [name]);
  def(2, 27, [
    { num: 254, size: 2, base: 0x84 }, { num: 1, size: 1, base: 0 }, { num: 2, size: 4, base: 0x86 },
    { num: 3, size: 1, base: 0 }, { num: 4, size: 4, base: 0x86 }, { num: 5, size: 4, base: 0x86 },
    { num: 6, size: 4, base: 0x86 }, { num: 7, size: 1, base: 0 },
  ]);
  steps.forEach((s, i) => data(2, [
    { size: 2, v: i }, { size: 1, v: s.dt }, { size: 4, v: s.dv }, { size: 1, v: s.tt ?? 2 },
    { size: 4, v: s.tv ?? 0 }, { size: 4, v: s.lo ?? 0 }, { size: 4, v: s.hi ?? 0 }, { size: 1, v: s.int ?? 0 },
  ]));
  const body = Buffer.concat(recs);
  const head = Buffer.alloc(14);
  head[0] = 14; head[1] = 0x10; head.writeUInt16LE(2132, 2); head.writeUInt32LE(body.length, 4); head.write('.FIT', 8, 'latin1');
  return Buffer.concat([head, body, Buffer.alloc(2)]);
}

test('FIT-Workout importieren: Leistungsziele, Watt, Wiederholungen', async () => {
  const fit = fitWorkout([
    { dt: 0, dv: 600000, tt: 4, lo: 50, hi: 70, int: 2 },
    { dt: 0, dv: 300000, tt: 4, lo: 1240, hi: 1260, int: 0 },
    { dt: 0, dv: 120000, int: 1 },
    { dt: 6, dv: 1, tv: 3 },
  ]);
  const r = await call('POST', '/api/workouts/import-fit?ftp=250&name=datei.fit', fit);
  assert.equal(r.status, 200);
  assert.equal(r.data.name, 'Test-Workout');
  assert.equal(r.data.steps.length, 7);
  assert.deepEqual(r.data.steps[0], { s: 600, a: 50, b: 70, l: 'Einrollen' });
  assert.equal(r.data.steps[1].a, 100);
  assert.equal(r.data.steps[1].b, 100);
  assert.equal(r.data.steps[2].s, 120);
  assert.equal(r.data.steps[6].s, 120);
  assert.ok(r.data.warnings.length > 0);
  const list = (await call('GET', '/api/workouts')).data;
  assert.ok(list.some((w) => w.id === r.data.id));
});

test('FIT-Workout importieren: Fehlerfälle', async () => {
  assert.equal((await call('POST', '/api/workouts/import-fit', Buffer.from('kein fit'))).status, 400);
  // Aufgezeichnete Fahrt (file_type 4) wird abgelehnt
  const act = fitWorkout([{ dt: 0, dv: 1000 }]);
  act[14 + 9 + 1] = 4; // file_type: Definition (9 Byte) + Datensatz-Header (1 Byte)
  const r = await call('POST', '/api/workouts/import-fit', act);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /keine Workout-Datei/);
});

test('Kategorien: anlegen, zuordnen, umbenennen, löschen', async () => {
  const w = (await call('GET', '/api/workouts')).data[0];
  const c = (await call('POST', '/api/categories', { name: ' Meine Intervalle ', workoutIds: [w.id, 'gibtsnicht'] })).data;
  assert.equal(c.name, 'Meine Intervalle');
  assert.deepEqual(c.workoutIds, [w.id]);
  assert.equal((await call('POST', '/api/categories', { name: '  ' })).status, 400);
  const u = (await call('PUT', `/api/categories/${c.id}`, { name: 'Neu', workoutIds: [] })).data;
  assert.deepEqual(u, { id: c.id, name: 'Neu', workoutIds: [] });
  assert.equal((await call('GET', '/api/categories')).data.length, 1);
  assert.equal((await call('DELETE', `/api/categories/${c.id}`)).status, 200);
  assert.equal((await call('GET', '/api/categories')).data.length, 0);
  assert.equal((await call('DELETE', `/api/categories/${c.id}`)).status, 404);
});

test('FIT-Import: Duplikate erkennen und Kategorie zuweisen', async () => {
  const mk = (dv) => fitWorkout([{ dt: 0, dv, tt: 4, lo: 50, hi: 70, int: 0 }, { dt: 0, dv: 300000, tt: 4, lo: 1240, hi: 1260, int: 0 }], 'Intervalle');
  const cat = (await call('POST', '/api/categories', { name: 'Import', workoutIds: [] })).data;
  const a = (await call('POST', `/api/workouts/import-fit?ftp=250&name=a.fit&category=${cat.id}`, mk(111000))).data;
  assert.equal(a.duplicate, false);
  // gleicher Inhalt, anderer Dateiname: Duplikat
  const b = (await call('POST', '/api/workouts/import-fit?ftp=250&name=b.fit', mk(111000))).data;
  assert.equal(b.duplicate, true);
  assert.equal(b.id, a.id);
  // gleicher Dateiname, anderer Inhalt: neu, mit Hinweis
  const c = (await call('POST', '/api/workouts/import-fit?ftp=250&name=a.fit', mk(222000))).data;
  assert.equal(c.duplicate, false);
  assert.equal(c.sameFileName, true);
  assert.deepEqual((await call('GET', '/api/categories')).data.find((x) => x.id === cat.id).workoutIds, [a.id]);
  // Duplikat landet bei Angabe einer Kategorie ebenfalls dort
  await call('POST', `/api/workouts/import-fit?ftp=250&name=c.fit&category=${cat.id}`, mk(222000));
  assert.deepEqual((await call('GET', '/api/categories')).data.find((x) => x.id === cat.id).workoutIds, [a.id, c.id]);
  // Sammel-Löschen: eingebaute bleiben, Kategorien werden bereinigt
  const all = (await call('GET', '/api/workouts')).data;
  const r = (await call('POST', '/api/workouts/bulk-delete', { ids: [a.id, c.id, all[0].id] })).data;
  assert.equal(r.deleted, 2);
  assert.equal(r.skippedBuiltIn, 1);
  assert.deepEqual((await call('GET', '/api/categories')).data.find((x) => x.id === cat.id).workoutIds, []);
  assert.equal((await call('POST', '/api/categories/bulk-delete', { ids: [cat.id, 'x'] })).data.deleted, 1);
});
