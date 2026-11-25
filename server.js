'use strict';
// Rollentrainer-Server: speichert Nutzer, Workouts, Strecken, Favoriten und Fahrten.
// Keine externen Abhängigkeiten, nur Node.js (>= 18). Kein Passwortschutz: nur im Heimnetz betreiben.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { builtInWorkouts } = require('./seed');

const MAX_BODY = 40 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

function haversine(lat1, lon1, lat2, lon2) {
  const r = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dp = toRad(lat2 - lat1);
  const dl = toRad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}

function routeStats(lat, lon, ele) {
  let length = 0;
  for (let i = 1; i < lat.length; i++) length += haversine(lat[i - 1], lon[i - 1], lat[i], lon[i]);
  // Höhe leicht glätten, damit Rauschen den Anstieg nicht aufbläht.
  const sm = ele.map((_, i) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - 3); j <= Math.min(ele.length - 1, i + 3); j++) { s += ele[j]; c++; }
    return s / c;
  });
  let ascent = 0;
  for (let i = 1; i < sm.length; i++) if (sm[i] > sm[i - 1]) ascent += sm[i] - sm[i - 1];
  return { length: Math.round(length), ascent: Math.round(ascent) };
}

function createApp({ dataDir, webDir, brouterUrl }) {
  const dirs = {
    routes: path.join(dataDir, 'routes'),
    rides: path.join(dataDir, 'rides'),
  };
  for (const d of [dataDir, dirs.routes, dirs.rides]) fs.mkdirSync(d, { recursive: true });

  const file = (name) => path.join(dataDir, name);
  const readJson = (p, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return fallback;
    }
  };
  const writeJson = (p, data) => {
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, p);
  };

  // ---- Startdaten ----
  if (!fs.existsSync(file('users.json'))) {
    const mk = (n) => ({
      id: newId('u'), name: `Fahrer ${n}`, ftp: 200, riderKg: 75, bikeKg: 9, gradeFactor: 1,
      favorites: { workouts: [], routes: [] },
    });
    writeJson(file('users.json'), [mk(1), mk(2)]);
  }
  if (!fs.existsSync(file('workouts.json'))) writeJson(file('workouts.json'), builtInWorkouts());

  const users = () => readJson(file('users.json'), []);
  const workouts = () => readJson(file('workouts.json'), []);

  const findUser = (id) => {
    const list = users();
    const u = list.find((x) => x.id === id);
    if (!u) throw new HttpError(404, 'Nutzer nicht gefunden');
    return { list, user: u };
  };
  const checkId = (id) => {
    if (!ID_RE.test(id || '')) throw new HttpError(400, 'Ungültige ID');
    return id;
  };

  // ---- Validierung ----
  const num = (v, min, max, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} muss zwischen ${min} und ${max} liegen`);
    return n;
  };
  const text = (v, name, max = 120) => {
    const s = String(v ?? '').trim();
    if (!s) throw new HttpError(400, `${name} fehlt`);
    return s.slice(0, max);
  };

  function cleanWorkout(body, id, builtIn) {
    if (!body || !Array.isArray(body.steps) || body.steps.length === 0 || body.steps.length > 500) {
      throw new HttpError(400, 'Workout braucht 1 bis 500 Abschnitte');
    }
    return {
      id,
      name: text(body.name, 'Name'),
      description: String(body.description ?? '').slice(0, 500),
      builtIn,
      steps: body.steps.map((s) => ({
        s: Math.round(num(s.s, 1, 86400, 'Dauer')),
        a: num(s.a, 10, 300, 'Start-%'),
        b: num(s.b ?? s.a, 10, 300, 'Ende-%'),
        l: String(s.l ?? '').slice(0, 60),
      })),
    };
  }

  function cleanRoute(body, id) {
    const { lat, lon, ele } = body || {};
    if (![lat, lon, ele].every(Array.isArray) || lat.length < 2 || lat.length !== lon.length || lat.length !== ele.length) {
      throw new HttpError(400, 'Strecke braucht gleich lange Listen lat, lon, ele mit mindestens 2 Punkten');
    }
    if (lat.length > 200000) throw new HttpError(400, 'Strecke hat zu viele Punkte');
    const L = lat.map(Number), O = lon.map(Number), E = ele.map(Number);
    if ([...L, ...O, ...E].some((v) => !Number.isFinite(v))) throw new HttpError(400, 'Ungültige Koordinaten');
    if (L.some((v) => v < -90 || v > 90) || O.some((v) => v < -180 || v > 180)) throw new HttpError(400, 'Koordinaten außerhalb des Bereichs');
    return { id, name: text(body.name, 'Name'), lat: L, lon: O, ele: E, ...routeStats(L, O, E), createdAt: Date.now() };
  }

  const routeMeta = (r) => ({ id: r.id, name: r.name, length: r.length, ascent: r.ascent, createdAt: r.createdAt });
  const routeFile = (id) => path.join(dirs.routes, `${checkId(id)}.json`);

  // ---- Handler ----
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler });
  };

  route('GET', '/api/health', () => ({ ok: true }));

  // Nutzer
  route('GET', '/api/users', () => users().map(({ favorites, ...u }) => u));
  route('POST', '/api/users', ({ body }) => {
    const list = users();
    if (list.length >= 20) throw new HttpError(400, 'Maximal 20 Nutzer');
    const u = {
      id: newId('u'), name: text(body?.name, 'Name', 40), ftp: 200, riderKg: 75, bikeKg: 9, gradeFactor: 1,
      favorites: { workouts: [], routes: [] },
    };
    list.push(u);
    writeJson(file('users.json'), list);
    return u;
  });
  route('GET', '/api/users/:id', ({ params }) => findUser(checkId(params.id)).user);
  route('PUT', '/api/users/:id', ({ params, body }) => {
    const { list, user } = findUser(checkId(params.id));
    if (body.name !== undefined) user.name = text(body.name, 'Name', 40);
    if (body.ftp !== undefined) user.ftp = Math.round(num(body.ftp, 50, 600, 'FTP'));
    if (body.riderKg !== undefined) user.riderKg = num(body.riderKg, 30, 200, 'Körpergewicht');
    if (body.bikeKg !== undefined) user.bikeKg = num(body.bikeKg, 5, 30, 'Radgewicht');
    if (body.gradeFactor !== undefined) user.gradeFactor = num(body.gradeFactor, 0.1, 1, 'Steigungsfaktor');
    writeJson(file('users.json'), list);
    return user;
  });
  route('DELETE', '/api/users/:id', ({ params }) => {
    const { list } = findUser(checkId(params.id));
    if (list.length <= 1) throw new HttpError(400, 'Der letzte Nutzer kann nicht gelöscht werden');
    writeJson(file('users.json'), list.filter((u) => u.id !== params.id));
    fs.rmSync(path.join(dirs.rides, params.id), { recursive: true, force: true });
    return { ok: true };
  });

  // Favoriten
  const favKind = (k) => {
    if (k !== 'workouts' && k !== 'routes') throw new HttpError(400, 'Art muss workouts oder routes sein');
    return k;
  };
  route('PUT', '/api/users/:id/favorites/:kind/:itemId', ({ params }) => {
    const { list, user } = findUser(checkId(params.id));
    const kind = favKind(params.kind);
    const itemId = checkId(params.itemId);
    if (!user.favorites[kind].includes(itemId)) user.favorites[kind].push(itemId);
    writeJson(file('users.json'), list);
    return user.favorites;
  });
  route('DELETE', '/api/users/:id/favorites/:kind/:itemId', ({ params }) => {
    const { list, user } = findUser(checkId(params.id));
    const kind = favKind(params.kind);
    user.favorites[kind] = user.favorites[kind].filter((x) => x !== params.itemId);
    writeJson(file('users.json'), list);
    return user.favorites;
  });

  // Workouts (gemeinsame Bibliothek)
  route('GET', '/api/workouts', () => workouts());
  route('POST', '/api/workouts', ({ body }) => {
    const list = workouts();
    const w = cleanWorkout(body, newId('w'), false);
    list.push(w);
    writeJson(file('workouts.json'), list);
    return w;
  });
  route('PUT', '/api/workouts/:id', ({ params, body }) => {
    const list = workouts();
    const i = list.findIndex((w) => w.id === checkId(params.id));
    if (i < 0) throw new HttpError(404, 'Workout nicht gefunden');
    if (list[i].builtIn) throw new HttpError(403, 'Eingebaute Workouts sind schreibgeschützt. Bitte eine Kopie speichern.');
    list[i] = cleanWorkout(body, list[i].id, false);
    writeJson(file('workouts.json'), list);
    return list[i];
  });
  route('DELETE', '/api/workouts/:id', ({ params }) => {
    const list = workouts();
    const w = list.find((x) => x.id === checkId(params.id));
    if (!w) throw new HttpError(404, 'Workout nicht gefunden');
    if (w.builtIn) throw new HttpError(403, 'Eingebaute Workouts können nicht gelöscht werden');
    writeJson(file('workouts.json'), list.filter((x) => x.id !== params.id));
    const us = users();
    for (const u of us) u.favorites.workouts = u.favorites.workouts.filter((x) => x !== params.id);
    writeJson(file('users.json'), us);
    return { ok: true };
  });

  // Strecken (gemeinsame Bibliothek)
  route('GET', '/api/routes', () =>
    fs.readdirSync(dirs.routes)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson(path.join(dirs.routes, f), null))
      .filter(Boolean)
      .map(routeMeta)
      .sort((a, b) => b.createdAt - a.createdAt));
  route('POST', '/api/routes', ({ body }) => {
    const r = cleanRoute(body, newId('r'));
    writeJson(routeFile(r.id), r);
    return routeMeta(r);
  });
  route('GET', '/api/routes/:id', ({ params }) => {
    const r = readJson(routeFile(params.id), null);
    if (!r) throw new HttpError(404, 'Strecke nicht gefunden');
    return r;
  });
  route('PUT', '/api/routes/:id', ({ params, body }) => {
    const r = readJson(routeFile(params.id), null);
    if (!r) throw new HttpError(404, 'Strecke nicht gefunden');
    r.name = text(body?.name, 'Name');
    writeJson(routeFile(params.id), r);
    return routeMeta(r);
  });
  route('DELETE', '/api/routes/:id', ({ params }) => {
    const p = routeFile(params.id);
    if (!fs.existsSync(p)) throw new HttpError(404, 'Strecke nicht gefunden');
    fs.unlinkSync(p);
    const us = users();
    for (const u of us) u.favorites.routes = u.favorites.routes.filter((x) => x !== params.id);
    writeJson(file('users.json'), us);
    return { ok: true };
  });

  // Routing-Proxy (BRouter), damit der Browser keine CORS-Probleme hat
  route('GET', '/api/brouter', async ({ query }) => {
    const lonlats = String(query.get('lonlats') || '');
    if (!/^-?[\d.]+,-?[\d.]+(\|-?[\d.]+,-?[\d.]+)+$/.test(lonlats)) throw new HttpError(400, 'Ungültige Wegpunkte');
    const profile = ['fastbike', 'trekking', 'gravel'].includes(query.get('profile')) ? query.get('profile') : 'fastbike';
    const url = `${brouterUrl}?lonlats=${encodeURIComponent(lonlats)}&profile=${profile}&alternativeidx=0&format=gpx`;
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    const body = await res.text();
    if (!res.ok || !body.includes('<trkpt')) throw new HttpError(502, `Routing fehlgeschlagen: ${body.slice(0, 120)}`);
    return { raw: body, type: 'application/gpx+xml; charset=utf-8' };
  });

  // Fahrten
  const rideDir = (uid) => path.join(dirs.rides, checkId(uid));
  route('GET', '/api/users/:id/rides', ({ params }) => {
    findUser(checkId(params.id));
    const dir = rideDir(params.id);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson(path.join(dir, f), null))
      .filter(Boolean)
      .sort((a, b) => b.date - a.date);
  });
  route('POST', '/api/users/:id/rides', ({ params, query, rawBody }) => {
    findUser(checkId(params.id));
    if (!rawBody || rawBody.length < 14 || rawBody.subarray(8, 12).toString('latin1') !== '.FIT') {
      throw new HttpError(400, 'Keine gültige FIT-Datei');
    }
    const dir = rideDir(params.id);
    fs.mkdirSync(dir, { recursive: true });
    const id = newId('ride');
    const n = (k) => (query.has(k) && Number.isFinite(Number(query.get(k))) ? Number(query.get(k)) : null);
    const meta = {
      id,
      date: n('date') ?? Date.now(),
      durationS: n('durationS'),
      distanceM: n('distanceM'),
      avgPower: n('avgPower'),
      workout: (query.get('workout') || '').slice(0, 120),
      route: (query.get('route') || '').slice(0, 120),
      bytes: rawBody.length,
    };
    fs.writeFileSync(path.join(dir, `${id}.fit`), rawBody);
    writeJson(path.join(dir, `${id}.json`), meta);
    return meta;
  });
  route('GET', '/api/users/:id/rides/:rid/fit', ({ params }) => {
    const p = path.join(rideDir(params.id), `${checkId(params.rid)}.fit`);
    if (!fs.existsSync(p)) throw new HttpError(404, 'Fahrt nicht gefunden');
    return { raw: fs.readFileSync(p), type: 'application/octet-stream', filename: `${params.rid}.fit` };
  });
  route('DELETE', '/api/users/:id/rides/:rid', ({ params }) => {
    const base = path.join(rideDir(params.id), checkId(params.rid));
    if (!fs.existsSync(`${base}.json`)) throw new HttpError(404, 'Fahrt nicht gefunden');
    fs.rmSync(`${base}.json`, { force: true });
    fs.rmSync(`${base}.fit`, { force: true });
    return { ok: true };
  });

  // ---- HTTP ----
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new HttpError(413, 'Anfrage zu groß'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function serveStatic(res, pathname) {
    if (!webDir) throw new HttpError(404, 'Nicht gefunden');
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const full = path.resolve(webDir, rel);
    if (!full.startsWith(path.resolve(webDir) + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      throw new HttpError(404, 'Nicht gefunden');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(fs.readFileSync(full));
  }

  return http.createServer(async (req, res) => {
    const send = (status, data, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET') throw new HttpError(405, 'Nicht erlaubt');
        return serveStatic(res, decodeURIComponent(url.pathname));
      }
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) {
        const known = routes.some((x) => x.re.test(url.pathname));
        throw new HttpError(known ? 405 : 404, known ? 'Methode nicht erlaubt' : 'Nicht gefunden');
      }
      const m = r.re.exec(url.pathname);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      let body, rawBody;
      if (req.method === 'POST' || req.method === 'PUT') {
        rawBody = await readBody(req);
        if ((req.headers['content-type'] || '').includes('json')) {
          try {
            body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
          } catch {
            throw new HttpError(400, 'Ungültiges JSON');
          }
        }
      }
      const out = await r.handler({ params, query: url.searchParams, body, rawBody });
      if (out && out.raw !== undefined) {
        const headers = { 'Content-Type': out.type };
        if (out.filename) headers['Content-Disposition'] = `attachment; filename="${out.filename}"`;
        res.writeHead(200, headers);
        return res.end(out.raw);
      }
      send(200, out);
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      console.error(e);
      send(500, { error: 'Interner Fehler' });
    }
  });
}

module.exports = { createApp };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  const server = createApp({
    dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
    webDir: path.join(__dirname, 'web'),
    brouterUrl: process.env.BROUTER_URL || 'https://brouter.de/brouter',
  });
  server.listen(port, '0.0.0.0', () => console.log(`Rollentrainer-Server läuft auf Port ${port}`));
}
