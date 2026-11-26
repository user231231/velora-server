'use strict';
// Rollentrainer Weboberfläche: Workouts, Strecken, Verlauf, Profil. Reines JavaScript ohne Build-Schritt.

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

const state = {
  users: [], user: null, workouts: [], routes: [],
  tab: 'workouts', folders: [], selWorkout: null, selRoute: null, onlyFavs: false,
  editor: null, planner: null, map: null,
};

// ---------- Hilfen ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || `Fehler ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), isErr ? 5000 : 2200);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

function fmtDur(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}
const fmtKm = (m) => (m / 1000).toFixed(1);
const zoneColor = (p) => (p < 55 ? '#9e9e9e' : p < 76 ? '#42a5f5' : p < 91 ? '#66bb6a' : p < 106 ? '#ffca28' : p < 121 ? '#ff7043' : '#e53935');
const totalSec = (steps) => steps.reduce((a, s) => a + s.s, 0);
const avgPct = (steps) => { const t = totalSec(steps); return t ? steps.reduce((a, s) => a + ((s.a + s.b) / 2) * s.s, 0) / t : 0; };
const isFav = (kind, id) => !!state.user?.favorites?.[kind]?.includes(id);

function canvasFor(id, height) {
  const c = document.getElementById(id);
  if (!c) return null;
  const w = c.clientWidth || 600;
  const dpr = window.devicePixelRatio || 1;
  c.width = w * dpr; c.height = height * dpr; c.style.height = height + 'px';
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  return { ctx, w, h: height };
}

function drawWorkout(id, steps, height = 150) {
  const cv = canvasFor(id, height);
  if (!cv || !steps.length) return;
  const { ctx, w, h } = cv;
  const total = totalSec(steps);
  const top = Math.max(100, ...steps.flatMap((s) => [s.a, s.b])) * 1.1;
  let t = 0;
  for (const s of steps) {
    const x0 = (t / total) * w, x1 = ((t + s.s) / total) * w;
    ctx.fillStyle = zoneColor((s.a + s.b) / 2);
    ctx.beginPath();
    ctx.moveTo(x0, h); ctx.lineTo(x0, h - (s.a / top) * h); ctx.lineTo(x1, h - (s.b / top) * h); ctx.lineTo(x1, h);
    ctx.closePath(); ctx.fill();
    t += s.s;
  }
  ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.setLineDash([4, 4]);
  const y100 = h - (100 / top) * h;
  ctx.beginPath(); ctx.moveTo(0, y100); ctx.lineTo(w, y100); ctx.stroke();
}

function drawProfile(id, r, height = 130) {
  const cv = canvasFor(id, height);
  if (!cv) return;
  const { ctx, w, h } = cv;
  const n = r.lat.length;
  const dist = [0];
  for (let i = 1; i < n; i++) dist.push(dist[i - 1] + haversine(r.lat[i - 1], r.lon[i - 1], r.lat[i], r.lon[i]));
  const total = dist[n - 1] || 1;
  const mn = Math.min(...r.ele), mx = Math.max(...r.ele);
  const range = Math.max(20, mx - mn);
  const base = mn - range * 0.05, top = base + range * 1.15;
  ctx.fillStyle = 'rgba(255,109,0,.55)';
  ctx.beginPath(); ctx.moveTo(0, h);
  const stride = Math.max(1, Math.floor(n / (w / 2)));
  for (let i = 0; i < n; i += stride) ctx.lineTo((dist[i] / total) * w, h - ((r.ele[i] - base) / (top - base)) * h);
  ctx.lineTo(w, h - ((r.ele[n - 1] - base) / (top - base)) * h); ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#93a0b4'; ctx.font = '11px system-ui';
  ctx.fillText(`${Math.round(mx)} m`, 6, 14); ctx.fillText(`${Math.round(mn)} m`, 6, h - 6);
}

// ---------- Geodaten ----------
function haversine(lat1, lon1, lat2, lon2) {
  const rad = (d) => (d * Math.PI) / 180;
  const dp = rad(lat2 - lat1), dl = rad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dl / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
}
function destination(lat, lon, bearingDeg, meters) {
  const R = 6371000, d = meters / R, b = (bearingDeg * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180, l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: (p2 * 180) / Math.PI, lon: ((((l2 * 180) / Math.PI) + 540) % 360) - 180 };
}
function loopWaypoints(start, lengthKm, bearing) {
  const side = (lengthKm * 1000) / (3 * 1.3);
  return [start, destination(start.lat, start.lon, bearing, side), destination(start.lat, start.lon, bearing + 60, side), start];
}
function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  let pts = [...doc.getElementsByTagName('trkpt')];
  if (pts.length < 2) pts = [...doc.getElementsByTagName('rtept')];
  if (pts.length < 2) throw new Error('Keine Streckenpunkte in der GPX-Datei');
  const lat = [], lon = [], ele = [];
  let last = 0;
  for (const p of pts) {
    const la = parseFloat(p.getAttribute('lat')), lo = parseFloat(p.getAttribute('lon'));
    if (Number.isNaN(la) || Number.isNaN(lo)) continue;
    const e = parseFloat(p.getElementsByTagName('ele')[0]?.textContent);
    if (!Number.isNaN(e)) last = e;
    lat.push(+la.toFixed(6)); lon.push(+lo.toFixed(6)); ele.push(+last.toFixed(1));
  }
  const nameEl = doc.getElementsByTagName('name')[0];
  return { lat, lon, ele, name: nameEl?.textContent?.trim() || '' };
}
function routeLength(r) {
  let l = 0;
  for (let i = 1; i < r.lat.length; i++) l += haversine(r.lat[i - 1], r.lon[i - 1], r.lat[i], r.lon[i]);
  return l;
}
function routeAscent(r) {
  const sm = r.ele.map((_, i) => { let s = 0, c = 0; for (let j = Math.max(0, i - 3); j <= Math.min(r.ele.length - 1, i + 3); j++) { s += r.ele[j]; c++; } return s / c; });
  let a = 0;
  for (let i = 1; i < sm.length; i++) if (sm[i] > sm[i - 1]) a += sm[i] - sm[i - 1];
  return a;
}

// ---------- Karte ----------
function destroyMap() {
  if (state.map) { try { state.map.remove(); } catch (_) { /* ignorieren */ } state.map = null; }
}
function makeMap(containerId, center, zoom, pitch = 40) {
  destroyMap();
  state.map = new maplibregl.Map({ container: containerId, style: MAP_STYLE, center, zoom, pitch });
  state.map.addControl(new maplibregl.NavigationControl());
  return state.map;
}
function showLine(map, r, sourceId = 'route') {
  const coords = r.lon.map((lo, i) => [lo, r.lat[i]]);
  const apply = () => {
    const geo = { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } };
    if (map.getSource(sourceId)) { map.getSource(sourceId).setData(geo); return; }
    map.addSource(sourceId, { type: 'geojson', data: geo });
    map.addLayer({ id: sourceId + '-casing', type: 'line', source: sourceId, paint: { 'line-color': '#fff', 'line-width': 9, 'line-opacity': 0.9 }, layout: { 'line-join': 'round' } });
    map.addLayer({ id: sourceId + '-line', type: 'line', source: sourceId, paint: { 'line-color': '#ff6d00', 'line-width': 5.5 }, layout: { 'line-join': 'round' } });
  };
  if (map.isStyleLoaded()) apply(); else map.once('load', apply);
  const b = new maplibregl.LngLatBounds();
  coords.forEach((c) => b.extend(c));
  map.fitBounds(b, { padding: 50, duration: 0 });
}

// ---------- Laden ----------
async function loadAll() {
  state.users = await api('GET', '/api/users');
  const saved = localStorage.getItem('rtUser');
  const id = state.users.find((u) => u.id === saved)?.id || state.users[0].id;
  await selectUser(id, false);
  [state.workouts, state.routes, state.folders] = await Promise.all([api('GET', '/api/workouts'), api('GET', '/api/routes'), api('GET', '/api/folders')]);
}
async function selectUser(id, rerender = true) {
  state.user = await api('GET', `/api/users/${encodeURIComponent(id)}`);
  localStorage.setItem('rtUser', id);
  renderUserSelect();
  if (rerender) render();
}
function renderUserSelect() {
  $('#userSel').innerHTML = state.users.map((u) => `<option value="${esc(u.id)}" ${u.id === state.user?.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
}
async function toggleFav(kind, id) {
  const method = isFav(kind, id) ? 'DELETE' : 'PUT';
  state.user.favorites = await api(method, `/api/users/${encodeURIComponent(state.user.id)}/favorites/${kind}/${encodeURIComponent(id)}`);
  render();
}

// ---------- Ansicht: Workouts ----------
function renderWorkouts() {
  const ed = state.editor;
  if (ed) return renderEditor();
  let list = state.workouts.slice();
  if (state.onlyFavs) list = list.filter((w) => isFav('workouts', w.id));
  list.sort((a, b) => Number(isFav('workouts', b.id)) - Number(isFav('workouts', a.id)) || a.name.localeCompare(b.name, 'de'));
  const sel = state.workouts.find((w) => w.id === state.selWorkout) || list[0];
  const ftp = state.user.ftp;
  $('#view').innerHTML = `
    <div class="split">
      <div>
        <div class="row"><button class="primary" id="newW">+ Neues Workout</button>
          <label><input type="checkbox" id="favOnly" ${state.onlyFavs ? 'checked' : ''}> nur Favoriten</label></div>
        <div class="card list">${list.map((w) => `
          <div class="item ${sel && w.id === sel.id ? 'sel' : ''}" data-id="${esc(w.id)}">
            <button class="star ${isFav('workouts', w.id) ? 'on' : ''}" data-star="${esc(w.id)}" title="Favorit">★</button>
            <div class="t"><b>${esc(w.name)}</b><span>${fmtDur(totalSec(w.steps))} · Ø ${Math.round(avgPct(w.steps))} % FTP</span></div>
          </div>`).join('') || '<div class="item muted">Keine Workouts</div>'}</div>
      </div>
      <div class="card">${sel ? `
        <h2>${esc(sel.name)} ${sel.builtIn ? '<span class="chip">eingebaut</span>' : ''}</h2>
        <div class="muted">${esc(sel.description)}</div>
        <div class="row"><span>${fmtDur(totalSec(sel.steps))}</span><span class="muted">Ø ${Math.round((avgPct(sel.steps) * ftp) / 100)} W bei FTP ${ftp} W (${esc(state.user.name)})</span></div>
        <canvas id="wchart"></canvas>
        <div class="row">
          <button class="primary" id="editW">${sel.builtIn ? 'Kopie bearbeiten' : 'Bearbeiten'}</button>
          ${sel.builtIn ? '' : '<button class="danger" id="delW">Löschen</button>'}
        </div>
        <h3>Abschnitte</h3>
        <table><tr><th>#</th><th>Bezeichnung</th><th>Dauer</th><th>% FTP</th><th>Watt</th></tr>
        ${sel.steps.map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s.l)}</td><td>${fmtDur(s.s)}</td>
          <td>${s.a === s.b ? Math.round(s.a) : `${Math.round(s.a)} → ${Math.round(s.b)}`}</td>
          <td>${s.a === s.b ? Math.round((s.a * ftp) / 100) : `${Math.round((s.a * ftp) / 100)} → ${Math.round((s.b * ftp) / 100)}`}</td></tr>`).join('')}
        </table>` : '<p class="muted">Kein Workout gewählt.</p>'}</div>
    </div>`;
  if (sel) drawWorkout('wchart', sel.steps);
  $('#favOnly').onchange = (e) => { state.onlyFavs = e.target.checked; render(); };
  $('#newW').onclick = () => { state.editor = { id: null, name: 'Mein Workout', description: '', steps: [{ s: 600, a: 50, b: 70, l: 'Einrollen' }, { s: 1200, a: 85, b: 85, l: 'Intervall' }] }; render(); };
  document.querySelectorAll('[data-star]').forEach((b) => (b.onclick = guard((e) => { e.stopPropagation(); return toggleFav('workouts', b.dataset.star); })));
  document.querySelectorAll('.item[data-id]').forEach((it) => (it.onclick = () => { state.selWorkout = it.dataset.id; render(); }));
  if (sel) {
    $('#editW').onclick = () => { state.editor = { id: sel.builtIn ? null : sel.id, name: sel.builtIn ? `${sel.name} (Kopie)` : sel.name, description: sel.description, steps: sel.steps.map((s) => ({ ...s })) }; render(); };
    const del = $('#delW');
    if (del) del.onclick = guard(async () => {
      if (!confirm(`„${sel.name}“ für alle Nutzer löschen?`)) return;
      await api('DELETE', `/api/workouts/${encodeURIComponent(sel.id)}`);
      state.workouts = await api('GET', '/api/workouts'); state.selWorkout = null;
      state.user = await api('GET', `/api/users/${encodeURIComponent(state.user.id)}`); render();
    });
  }
}

function renderEditor() {
  const ed = state.editor;
  $('#view').innerHTML = `
    <div class="card">
      <div class="row"><h2 style="margin:0">Workout bearbeiten</h2>
        <button class="primary" id="saveW">Speichern</button><button class="ghost" id="cancelW">Abbrechen</button></div>
      <div class="row"><label class="f">Name<input id="edName" value="${esc(ed.name)}" style="width:320px"></label>
        <label class="f" style="flex:1">Beschreibung<input id="edDesc" value="${esc(ed.description)}"></label></div>
      <canvas id="wchart"></canvas>
      <div class="row muted" id="edSum"></div>
      <table id="edTable"><tr><th>#</th><th>Bezeichnung</th><th>Min</th><th>Sek</th><th>Start %</th><th>Ende %</th><th></th></tr>
      ${ed.steps.map((s, i) => `<tr data-i="${i}">
        <td>${i + 1}</td><td><input type="text" data-f="l" value="${esc(s.l)}"></td>
        <td><input type="number" data-f="min" min="0" value="${Math.floor(s.s / 60)}"></td>
        <td><input type="number" data-f="sec" min="0" max="59" value="${s.s % 60}"></td>
        <td><input type="number" data-f="a" min="10" max="300" value="${Math.round(s.a)}"></td>
        <td><input type="number" data-f="b" min="10" max="300" value="${Math.round(s.b)}"></td>
        <td><button class="small" data-act="up">↑</button> <button class="small" data-act="down">↓</button> <button class="small" data-act="dup">⧉</button> <button class="small" data-act="del">✕</button></td></tr>`).join('')}
      </table>
      <div class="row"><button class="ghost" id="addStep">+ Abschnitt</button></div>
      <h3>Intervalle hinzufügen</h3>
      <div class="row">
        <label class="f">Wiederholungen<input type="number" id="gN" value="5" min="1" max="50"></label>
        <label class="f">Belastung (Sek)<input type="number" id="gOn" value="240" min="5"></label>
        <label class="f">Belastung % FTP<input type="number" id="gOnP" value="115"></label>
        <label class="f">Pause (Sek)<input type="number" id="gOff" value="240" min="0"></label>
        <label class="f">Pause % FTP<input type="number" id="gOffP" value="50"></label>
        <button class="ghost" id="gen">Anhängen</button>
      </div>
    </div>`;
  const redraw = () => {
    drawWorkout('wchart', ed.steps);
    $('#edSum').textContent = `${fmtDur(totalSec(ed.steps))} · Ø ${Math.round(avgPct(ed.steps))} % FTP`;
  };
  redraw();
  $('#edName').oninput = (e) => (ed.name = e.target.value);
  $('#edDesc').oninput = (e) => (ed.description = e.target.value);
  document.querySelectorAll('#edTable tr[data-i]').forEach((tr) => {
    const i = +tr.dataset.i;
    tr.querySelectorAll('input').forEach((inp) => (inp.oninput = () => {
      const g = (f) => +tr.querySelector(`[data-f=${f}]`).value || 0;
      ed.steps[i] = { l: tr.querySelector('[data-f=l]').value, s: Math.max(1, g('min') * 60 + g('sec')), a: g('a'), b: g('b') };
      redraw();
    }));
    tr.querySelectorAll('[data-act]').forEach((btn) => (btn.onclick = () => {
      const act = btn.dataset.act;
      if (act === 'del') ed.steps.splice(i, 1);
      else if (act === 'dup') ed.steps.splice(i + 1, 0, { ...ed.steps[i] });
      else if (act === 'up' && i > 0) [ed.steps[i - 1], ed.steps[i]] = [ed.steps[i], ed.steps[i - 1]];
      else if (act === 'down' && i < ed.steps.length - 1) [ed.steps[i + 1], ed.steps[i]] = [ed.steps[i], ed.steps[i + 1]];
      render();
    }));
  });
  $('#addStep').onclick = () => { ed.steps.push({ s: 300, a: 70, b: 70, l: '' }); render(); };
  $('#gen').onclick = () => {
    const v = (id) => +$(id).value;
    for (let k = 0; k < v('#gN'); k++) {
      ed.steps.push({ s: v('#gOn'), a: v('#gOnP'), b: v('#gOnP'), l: 'Intervall' });
      if (v('#gOff') > 0) ed.steps.push({ s: v('#gOff'), a: v('#gOffP'), b: v('#gOffP'), l: 'Pause' });
    }
    render();
  };
  $('#cancelW').onclick = () => { state.editor = null; render(); };
  $('#saveW').onclick = guard(async () => {
    const body = { name: ed.name, description: ed.description, steps: ed.steps };
    const saved = ed.id ? await api('PUT', `/api/workouts/${encodeURIComponent(ed.id)}`, body) : await api('POST', '/api/workouts', body);
    state.workouts = await api('GET', '/api/workouts');
    state.selWorkout = saved.id; state.editor = null; toast('Workout gespeichert'); render();
  });
}

// ---------- Ansicht: Strecken ----------
const folderOptions = (cur) => `<option value="">(ohne Ordner)</option>${state.folders.map((f) => `<option value="${esc(f)}" ${f === cur ? 'selected' : ''}>${esc(f)}</option>`).join('')}<option value="__new">+ Neuer Ordner …</option>`;
async function askNewFolder() {
  const n = (prompt('Name des neuen Ordners') || '').trim();
  if (!n) return '';
  state.folders = await api('POST', '/api/folders', { name: n });
  return n;
}
function refreshFolderSel(sel, cur) { sel.innerHTML = folderOptions(cur); sel.value = cur; }

function renderRoutes() {
  if (state.planner) return renderPlanner();
  let list = state.routes.slice();
  if (state.onlyFavs) list = list.filter((r) => isFav('routes', r.id));
  list.sort((a, b) => Number(isFav('routes', b.id)) - Number(isFav('routes', a.id)) || a.name.localeCompare(b.name, 'de'));
  const names = [...new Set([...state.folders, ...list.map((r) => r.folder || '')])].sort((x, y) => (x === '' ) - (y === '') || x.localeCompare(y, 'de'));
  const groups = names.filter((n) => !state.onlyFavs || list.some((r) => (r.folder || '') === n))
    .map((n) => ({ name: n, items: list.filter((r) => (r.folder || '') === n) }))
    .filter((g) => g.name !== '' || g.items.length);
  const sel = state.routes.find((r) => r.id === state.selRoute) || list[0];
  $('#view').innerHTML = `
    <div class="split">
      <div>
        <div class="row"><button class="primary" id="newR">+ Strecke planen</button><button class="ghost" id="newF">+ Ordner</button>
          <button class="ghost" id="impR">GPX importieren</button><input type="file" id="gpxIn" accept=".gpx" hidden>
          <label><input type="checkbox" id="favOnly" ${state.onlyFavs ? 'checked' : ''}> nur Favoriten</label></div>
        <div class="card list">${groups.map((g) => `
          <div class="item folder" data-folder="${esc(g.name)}"><b>📁 ${esc(g.name || 'Ohne Ordner')}</b> <span class="muted">${g.items.length}</span>
            ${g.name ? `<button class="small" data-fren="${esc(g.name)}" title="Umbenennen">✎</button><button class="small" data-fdel="${esc(g.name)}" title="Ordner löschen (Strecken bleiben erhalten)">✕</button>` : ''}</div>
          ${g.items.map((r) => `
          <div class="item ${sel && r.id === sel.id ? 'sel' : ''}" data-id="${esc(r.id)}" style="padding-left:24px">
            <button class="star ${isFav('routes', r.id) ? 'on' : ''}" data-star="${esc(r.id)}">★</button>
            <div class="t"><b>${esc(r.name)}</b><span>${fmtKm(r.length)} km · ${r.ascent} Hm</span></div>
          </div>`).join('')}`).join('') || '<div class="item muted">Noch keine Strecken. Plane eine oder importiere eine GPX-Datei.</div>'}</div>
      </div>
      <div class="card">${sel ? `
        <h2>${esc(sel.name)}</h2>
        <div class="row muted"><span>${fmtKm(sel.length)} km</span><span>${sel.ascent} Hm Anstieg</span>
          <label class="f" style="margin-left:auto">Ordner<select id="rFolder">${folderOptions(sel.folder || '')}</select></label></div>
        <div id="rmap" class="map"></div>
        <canvas id="rprof" style="margin-top:10px"></canvas>
        <div class="row"><button class="ghost" id="renR">Umbenennen</button><button class="danger" id="delR">Löschen</button></div>` : '<p class="muted">Keine Strecke gewählt.</p>'}</div>
    </div>`;
  destroyMap();
  $('#favOnly').onchange = (e) => { state.onlyFavs = e.target.checked; render(); };
  $('#newR').onclick = () => { state.planner = { wps: [], markers: [], route: null, cands: [], profile: 'fastbike', km: 50, busy: false }; render(); };
  $('#newF').onclick = guard(async () => { await askNewFolder(); render(); });
  document.querySelectorAll('[data-fren]').forEach((b) => (b.onclick = guard(async (e) => {
    e.stopPropagation(); const from = b.dataset.fren;
    const to = (prompt('Neuer Name für den Ordner', from) || '').trim(); if (!to || to === from) return;
    state.folders = await api('PUT', `/api/folders/${encodeURIComponent(from)}`, { name: to });
    state.routes = await api('GET', '/api/routes'); render();
  })));
  document.querySelectorAll('[data-fdel]').forEach((b) => (b.onclick = guard(async (e) => {
    e.stopPropagation(); const n = b.dataset.fdel;
    if (!confirm(`Ordner „${n}“ löschen? Die Strecken darin bleiben erhalten und landen unter „Ohne Ordner“.`)) return;
    state.folders = await api('DELETE', `/api/folders/${encodeURIComponent(n)}`);
    state.routes = await api('GET', '/api/routes'); render();
  })));
  $('#impR').onclick = () => $('#gpxIn').click();
  $('#gpxIn').onchange = guard(async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const g = parseGpx(await f.text());
    const saved = await api('POST', '/api/routes', { name: g.name || f.name.replace(/\.gpx$/i, ''), lat: g.lat, lon: g.lon, ele: g.ele });
    state.routes = await api('GET', '/api/routes'); state.selRoute = saved.id; toast('Strecke importiert'); render();
  });
  document.querySelectorAll('[data-star]').forEach((b) => (b.onclick = guard((e) => { e.stopPropagation(); return toggleFav('routes', b.dataset.star); })));
  document.querySelectorAll('.item[data-id]').forEach((it) => (it.onclick = () => { state.selRoute = it.dataset.id; render(); }));
  if (sel) {
    guard(async () => {
      const r = await api('GET', `/api/routes/${encodeURIComponent(sel.id)}`);
      const map = makeMap('rmap', [r.lon[0], r.lat[0]], 11);
      showLine(map, r);
      drawProfile('rprof', r);
    })();
    $('#rFolder').onchange = guard(async (e) => {
      let f = e.target.value;
      if (f === '__new') { f = await askNewFolder(); if (!f) { render(); return; } }
      await api('PUT', `/api/routes/${encodeURIComponent(sel.id)}`, { folder: f });
      state.routes = await api('GET', '/api/routes'); state.folders = await api('GET', '/api/folders'); toast('Verschoben'); render();
    });
    $('#renR').onclick = guard(async () => {
      const name = prompt('Neuer Name', sel.name); if (!name) return;
      await api('PUT', `/api/routes/${encodeURIComponent(sel.id)}`, { name });
      state.routes = await api('GET', '/api/routes'); render();
    });
    $('#delR').onclick = guard(async () => {
      if (!confirm(`„${sel.name}“ für alle Nutzer löschen?`)) return;
      await api('DELETE', `/api/routes/${encodeURIComponent(sel.id)}`);
      state.routes = await api('GET', '/api/routes'); state.selRoute = null;
      state.user = await api('GET', `/api/users/${encodeURIComponent(state.user.id)}`); render();
    });
  }
}

function renderPlanner() {
  const p = state.planner;
  $('#view').innerHTML = `
    <div class="split">
      <div class="card">
        <div class="row"><h2 style="margin:0">Routenplaner</h2><button class="ghost" id="back">Zurück</button></div>
        <h3>1. Eigene Route</h3>
        <div class="muted">Auf die Karte klicken: erster Punkt = Start, weitere = Zwischenziele und Ziel. Für einen Rundkurs den Start zuletzt nochmal setzen.</div>
        <div class="row"><label class="f">Profil<select id="pProfile">
          <option value="fastbike">Rennrad (schnell)</option><option value="trekking">Trekking (ruhige Straßen)</option><option value="gravel">Gravel</option></select></label>
          <button class="ghost" id="pUndo">Zurück</button><button class="ghost" id="pClear">Leeren</button></div>
        <h3>2. Rundkurs vorschlagen</h3>
        <div class="muted">Karte so verschieben, dass die Mitte auf dem Startpunkt liegt.</div>
        <div class="row"><input type="range" id="pKm" min="20" max="120" step="5" value="${p.km}"><span id="pKmL">${p.km} km</span></div>
        <button class="ghost" id="pLoops">Rundkurse berechnen</button>
        <div id="pCands"></div>
        <div id="pInfo" class="muted" style="margin-top:10px"></div>
        <div id="pSave"></div>
      </div>
      <div><div id="pmap" class="map" style="height:560px"></div><canvas id="pprof" style="margin-top:10px"></canvas></div>
    </div>`;
  const map = makeMap('pmap', [6.9603, 50.9375], 11, 30);
  $('#pProfile').value = p.profile;
  const setInfo = (t, err) => { $('#pInfo').textContent = t || ''; $('#pInfo').style.color = err ? '#ff8a80' : ''; };

  const drawRoute = () => {
    if (p.route) { showLine(map, p.route); drawProfile('pprof', p.route); } else if (map.getSource('route')) { map.getSource('route').setData({ type: 'FeatureCollection', features: [] }); }
    $('#pSave').innerHTML = p.route ? `<h3>Ergebnis</h3><div><b>${fmtKm(routeLength(p.route))} km · ${Math.round(routeAscent(p.route))} Hm</b></div>
      <div class="row"><input id="pName" value="${esc(p.route.name || 'Geplante Strecke')}" style="flex:1"></div>
      <div class="row"><label class="f" style="flex:1">Ordner<select id="pFolder">${folderOptions(p.folder || '')}</select></label><button class="primary" id="pSaveBtn">Speichern</button></div>` : '';
    const pf = $('#pFolder');
    if (pf) pf.onchange = guard(async () => { if (pf.value === '__new') { const n = await askNewFolder(); p.folder = n || ''; refreshFolderSel(pf, p.folder); } else p.folder = pf.value; });
    const sb = $('#pSaveBtn');
    if (sb) sb.onclick = guard(async () => {
      const name = $('#pName').value.trim() || 'Strecke';
      const saved = await api('POST', '/api/routes', { name, folder: p.folder || '', lat: p.route.lat, lon: p.route.lon, ele: p.route.ele });
      state.routes = await api('GET', '/api/routes'); state.folders = await api('GET', '/api/folders'); state.selRoute = saved.id; state.planner = null; toast('Strecke gespeichert'); render();
    });
  };
  const fetchRoute = async (wps, profile) => {
    const lonlats = wps.map((w) => `${w.lon.toFixed(6)},${w.lat.toFixed(6)}`).join('|');
    const gpx = await api('GET', `/api/brouter?lonlats=${encodeURIComponent(lonlats)}&profile=${profile}`);
    const g = parseGpx(gpx);
    return { lat: g.lat, lon: g.lon, ele: g.ele };
  };
  const recalc = guard(async () => {
    if (p.wps.length < 2) { p.route = null; drawRoute(); setInfo(''); return; }
    p.cands = []; $('#pCands').innerHTML = ''; setInfo('Berechne Route …');
    try { p.route = { ...(await fetchRoute(p.wps, p.profile)), name: 'Geplante Strecke' }; setInfo(''); } catch (e) { p.route = null; setInfo(e.message, true); }
    drawRoute();
  });
  const refreshMarkers = () => {
    p.markers.forEach((m) => m.remove()); p.markers = [];
    p.wps.forEach((w, i) => {
      const color = i === 0 ? '#2e7d32' : i === p.wps.length - 1 ? '#c62828' : '#1565c0';
      p.markers.push(new maplibregl.Marker({ color }).setLngLat([w.lon, w.lat]).addTo(map));
    });
  };
  map.on('click', (e) => { p.wps.push({ lat: e.lngLat.lat, lon: e.lngLat.lng }); refreshMarkers(); recalc(); });
  $('#back').onclick = () => { state.planner = null; render(); };
  $('#pUndo').onclick = () => { p.wps.pop(); refreshMarkers(); recalc(); };
  $('#pClear').onclick = () => { p.wps = []; refreshMarkers(); recalc(); };
  $('#pProfile').onchange = (e) => { p.profile = e.target.value; recalc(); };
  $('#pKm').oninput = (e) => { p.km = +e.target.value; $('#pKmL').textContent = `${p.km} km`; };
  $('#pLoops').onclick = guard(async () => {
    const c = map.getCenter(); const start = { lat: c.lat, lon: c.lng };
    p.wps = [start]; refreshMarkers(); p.route = null; setInfo('Berechne Rundkurse …');
    const first = Math.floor(Math.random() * 120);
    const names = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
    const results = await Promise.all([0, 120, 240].map(async (off) => {
      const bearing = (first + off) % 360;
      try {
        const r = await fetchRoute(loopWaypoints(start, p.km, bearing), p.profile);
        return { ...r, name: `Rundkurs ${p.km} km (${names[Math.floor(((bearing + 22.5) % 360) / 45)]})` };
      } catch (_) { return null; }
    }));
    p.cands = results.filter(Boolean);
    if (!p.cands.length) { setInfo('Keine Rundkurse gefunden. Kartenmitte auf eine Straße legen oder die Länge ändern.', true); return; }
    setInfo('');
    $('#pCands').innerHTML = p.cands.map((c, i) => `<div class="item" data-c="${i}"><div class="t"><b>${esc(c.name)}</b><span>${fmtKm(routeLength(c))} km · ${Math.round(routeAscent(c))} Hm</span></div></div>`).join('');
    document.querySelectorAll('[data-c]').forEach((el) => (el.onclick = () => { p.route = p.cands[+el.dataset.c]; drawRoute(); }));
    p.route = p.cands[0]; drawRoute();
  });
}

// ---------- Ansicht: Verlauf ----------
async function renderRides() {
  $('#view').innerHTML = '<div class="card"><h2>Verlauf</h2><div id="rides" class="muted">Lade …</div></div>';
  try {
    const rides = await api('GET', `/api/users/${encodeURIComponent(state.user.id)}/rides`);
    $('#rides').innerHTML = rides.length ? `<table><tr><th>Datum</th><th>Workout</th><th>Strecke</th><th>Zeit</th><th>Distanz</th><th>Ø Watt</th><th></th></tr>
      ${rides.map((r) => `<tr><td>${new Date(r.date).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}</td>
        <td>${esc(r.workout || '–')}</td><td>${esc(r.route || '–')}</td>
        <td>${r.durationS != null ? fmtDur(r.durationS) : '–'}</td><td>${r.distanceM != null ? fmtKm(r.distanceM) + ' km' : '–'}</td><td>${r.avgPower ?? '–'}</td>
        <td><a href="/api/users/${encodeURIComponent(state.user.id)}/rides/${encodeURIComponent(r.id)}/fit"><button class="small">FIT</button></a>
        <button class="small" data-del="${esc(r.id)}">✕</button></td></tr>`).join('')}</table>` : '<span class="muted">Noch keine Fahrten. Fahrten werden nach dem Ende automatisch aus der Tablet-App hierher übertragen.</span>';
    document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = guard(async () => {
      if (!confirm('Fahrt löschen?')) return;
      await api('DELETE', `/api/users/${encodeURIComponent(state.user.id)}/rides/${encodeURIComponent(b.dataset.del)}`); render();
    })));
  } catch (e) { $('#rides').textContent = e.message; }
}

// ---------- Ansicht: Profil ----------
const ICON_EMOJI = { bike: '🚴', mountain: '⛰️', bolt: '⚡', flame: '🔥', star: '⭐', heart: '❤️', sun: '☀️', leaf: '🍃', rocket: '🚀', paw: '🐾', trophy: '🏆', coffee: '☕' };
const AVATAR_COLORS = ['#2979FF', '#00BFA5', '#FF6D00', '#D500F9', '#FFC400', '#F50057', '#76FF03', '#00B8D4'];

function renderProfile() {
  const u = state.user;
  let icon = u.icon || 'bike', color = u.color || AVATAR_COLORS[0];
  $('#view').innerHTML = `
    <div class="card"><h2>Profil von ${esc(u.name)}</h2>
      <div class="form">
        <label class="f">Name<input id="uName" value="${esc(u.name)}"></label>
        <div class="f">Icon und Farbe (für die Profilwahl in der App)
          <div class="row" id="uIcons" style="flex-wrap:wrap">${Object.entries(ICON_EMOJI).map(([k, e]) => `<button type="button" class="ghost" data-icon="${k}" style="font-size:22px;min-width:44px">${e}</button>`).join('')}</div>
          <div class="row" id="uColors" style="flex-wrap:wrap">${AVATAR_COLORS.map((c) => `<button type="button" data-color="${c}" aria-label="Farbe ${c}" style="width:32px;height:32px;border-radius:50%;background:${c};border:2px solid transparent"></button>`).join('')}</div>
          <div id="uPrev" style="width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:32px"></div>
        </div>
        <label class="f">FTP (Watt)<input id="uFtp" type="number" value="${u.ftp}" min="50" max="600"></label>
        <label class="f">Körpergewicht (kg)<input id="uKg" type="number" step="0.5" value="${u.riderKg}"></label>
        <label class="f">Gewicht Rad + Ausrüstung (kg)<input id="uBike" type="number" step="0.5" value="${u.bikeKg}"></label>
        <label class="f">Steigungs-Intensität: <span id="uGfL">${Math.round(u.gradeFactor * 100)} %</span>
          <input id="uGf" type="range" min="0.2" max="1" step="0.1" value="${u.gradeFactor}"></label>
        <div class="row"><button class="primary" id="uSave">Speichern</button><button class="danger" id="uDel">Nutzer löschen</button></div>
      </div></div>`;
  const paint = () => {
    $('#uPrev').style.background = color; $('#uPrev').textContent = ICON_EMOJI[icon] || '🚴';
    document.querySelectorAll('[data-icon]').forEach((b) => (b.style.outline = b.dataset.icon === icon ? '2px solid ' + color : 'none'));
    document.querySelectorAll('[data-color]').forEach((b) => (b.style.borderColor = b.dataset.color === color ? '#fff' : 'transparent'));
  };
  document.querySelectorAll('[data-icon]').forEach((b) => (b.onclick = () => { icon = b.dataset.icon; paint(); }));
  document.querySelectorAll('[data-color]').forEach((b) => (b.onclick = () => { color = b.dataset.color; paint(); }));
  paint();
  $('#uGf').oninput = (e) => ($('#uGfL').textContent = `${Math.round(e.target.value * 100)} %`);
  $('#uSave').onclick = guard(async () => {
    await api('PUT', `/api/users/${encodeURIComponent(u.id)}`, { name: $('#uName').value, ftp: +$('#uFtp').value, riderKg: +$('#uKg').value, bikeKg: +$('#uBike').value, gradeFactor: +$('#uGf').value, icon, color });
    state.users = await api('GET', '/api/users'); await selectUser(u.id, false); renderUserSelect(); toast('Gespeichert'); render();
  });
  $('#uDel').onclick = guard(async () => {
    if (!confirm(`Nutzer „${u.name}“ mit allen Fahrten löschen?`)) return;
    await api('DELETE', `/api/users/${encodeURIComponent(u.id)}`);
    state.users = await api('GET', '/api/users'); await selectUser(state.users[0].id);
  });
}

// ---------- Steuerung ----------
function render() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  if (state.tab !== 'routes') destroyMap();
  const fn = { workouts: renderWorkouts, routes: renderRoutes, rides: renderRides, profile: renderProfile }[state.tab];
  guard(async () => fn())();
}

async function init() {
  document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; state.editor = null; state.planner = null; render(); }));
  $('#userSel').onchange = guard((e) => selectUser(e.target.value));
  $('#addUser').onclick = guard(async () => {
    const name = prompt('Name des neuen Nutzers'); if (!name) return;
    const u = await api('POST', '/api/users', { name });
    state.users = await api('GET', '/api/users'); await selectUser(u.id);
  });
  try {
    await loadAll();
    render();
  } catch (e) {
    $('#view').innerHTML = `<div class="card">Server nicht erreichbar: ${esc(e.message)}</div>`;
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}
