'use strict';
// Liest Workout-Dateien im FIT-Format (Garmin) und wandelt sie in Velora-Abschnitte um.
// Unterstützt: Zeit- und Distanz-Abschnitte, Leistungsziele (% FTP oder Watt), Wiederholungen.

const MSG_WORKOUT = 26;
const MSG_WORKOUT_STEP = 27;
const FILE_TYPE_WORKOUT = 5;

class FitError extends Error {}

function parseFit(buf) {
  if (buf.length < 14 || buf.subarray(8, 12).toString('latin1') !== '.FIT') throw new FitError('Keine gültige FIT-Datei');
  const headerSize = buf[0];
  const dataSize = buf.readUInt32LE(4);
  const end = Math.min(buf.length, headerSize + dataSize);
  const defs = new Map();
  const messages = [];
  let fileType = null;
  let pos = headerSize;
  while (pos < end) {
    const h = buf[pos++];
    if (h & 0x80) {
      // komprimierter Zeitstempel: Datensatz ohne eigenes Zeitfeld
      const def = defs.get((h >> 5) & 0x03);
      if (!def) throw new FitError('Beschädigte FIT-Datei');
      pos += def.size;
      continue;
    }
    const local = h & 0x0f;
    if (h & 0x40) {
      pos += 1; // reserviert
      const little = buf[pos++] === 0;
      const global = little ? buf.readUInt16LE(pos) : buf.readUInt16BE(pos);
      pos += 2;
      const n = buf[pos++];
      const fields = [];
      let size = 0;
      for (let i = 0; i < n; i++) {
        fields.push({ num: buf[pos], size: buf[pos + 1], base: buf[pos + 2] });
        size += buf[pos + 1];
        pos += 3;
      }
      if (h & 0x20) {
        const dn = buf[pos++];
        for (let i = 0; i < dn; i++) { size += buf[pos + 1]; pos += 3; }
      }
      defs.set(local, { global, little, fields, size });
    } else {
      const def = defs.get(local);
      if (!def) throw new FitError('Beschädigte FIT-Datei');
      if (pos + def.size > buf.length) throw new FitError('FIT-Datei ist abgeschnitten');
      const msg = {};
      let p = pos;
      for (const f of def.fields) {
        if (f.base === 0x07) {
          const raw = buf.subarray(p, p + f.size);
          const z = raw.indexOf(0);
          msg[f.num] = raw.subarray(0, z < 0 ? raw.length : z).toString('utf8');
        } else if (f.size === 1) {
          msg[f.num] = buf[p];
        } else if (f.size === 2) {
          msg[f.num] = def.little ? buf.readUInt16LE(p) : buf.readUInt16BE(p);
        } else if (f.size === 4) {
          msg[f.num] = def.little ? buf.readUInt32LE(p) : buf.readUInt32BE(p);
        }
        p += f.size;
      }
      pos += def.size;
      if (def.global === 0 && msg[0] !== undefined) fileType = msg[0];
      messages.push({ global: def.global, f: msg });
    }
  }
  return { fileType, messages };
}

const INTENSITY = { 0: 'Intervall', 1: 'Pause', 2: 'Einrollen', 3: 'Ausrollen' };
const DEFAULT_PCT = { 0: 75, 1: 45, 2: 55, 3: 50 };
const INVALID32 = 0xffffffff;
const clampPct = (v) => Math.max(10, Math.min(300, Math.round(v)));

/** Gibt { name, steps:[{s,a,b,l}], warnings:[] } zurück. ftp wird nur für Watt-Ziele gebraucht. */
function fitToWorkout(buf, { ftp = 200, fallbackName = 'Importiertes Workout' } = {}) {
  const { fileType, messages } = parseFit(buf);
  if (fileType !== null && fileType !== FILE_TYPE_WORKOUT) {
    throw new FitError('Das ist keine Workout-Datei (vermutlich eine aufgezeichnete Fahrt)');
  }
  const warnings = new Set();
  const wk = messages.find((m) => m.global === MSG_WORKOUT);
  const raw = messages.filter((m) => m.global === MSG_WORKOUT_STEP).map((m) => m.f);
  if (raw.length === 0) throw new FitError('Keine Workout-Abschnitte gefunden');
  raw.sort((x, y) => (x[254] ?? 0) - (y[254] ?? 0));

  const out = [];
  const startOf = new Map();
  for (const st of raw) {
    const idx = st[254] ?? startOf.size;
    startOf.set(idx, out.length);
    const dType = st[1];
    if (dType === 6) {
      // wiederhole ab Abschnitt <Wert> so oft, bis <Ziel> Durchläufe erreicht sind
      const from = startOf.get(st[2]);
      const count = Math.max(1, Math.min(200, st[4] || 1));
      if (from === undefined) { warnings.add('Eine Wiederholung konnte nicht zugeordnet werden'); continue; }
      const block = out.slice(from);
      for (let c = 1; c < count; c++) for (const b of block) out.push({ ...b });
      continue;
    }
    if (dType >= 7 && dType !== 14) warnings.add('Wiederholungen nach Bedingung wurden einmal gezählt');
    let s;
    if (dType === 0 && st[2] !== undefined && st[2] !== INVALID32) s = Math.round(st[2] / 1000);
    else if (dType === 1 && st[2] !== undefined && st[2] !== INVALID32) { s = Math.round((st[2] / 100) / 8.33); warnings.add('Distanz-Abschnitte mit 30 km/h in Zeit umgerechnet'); }
    else { s = 300; warnings.add('Abschnitte ohne feste Dauer wurden mit 5 min angesetzt'); }
    s = Math.max(1, Math.min(86400, s));

    const inten = st[7] ?? 0;
    let a = DEFAULT_PCT[inten] ?? 70;
    let b = a;
    if (st[3] === 4) { // Leistungsziel
      const lo = st[5], hi = st[6];
      const toPct = (v) => (v > 1000 ? ((v - 1000) / ftp) * 100 : v);
      if (lo !== undefined && hi !== undefined && lo !== INVALID32 && hi !== INVALID32 && (lo || hi)) {
        if (lo > 1000 || hi > 1000) warnings.add(`Watt-Ziele mit FTP ${ftp} W in % umgerechnet`);
        a = toPct(lo);
        b = toPct(hi);
        if (inten !== 2 && inten !== 3) { a = b = (a + b) / 2; }
      } else if (st[4] !== undefined && st[4] !== INVALID32 && st[4] > 1000) {
        a = b = toPct(st[4]);
        warnings.add(`Watt-Ziele mit FTP ${ftp} W in % umgerechnet`);
      } else {
        warnings.add('Leistungszonen ohne Wattangabe wurden durch Standardwerte ersetzt');
      }
    } else {
      warnings.add('Abschnitte ohne Leistungsziel haben Standardwerte (nach Intensität)');
    }
    out.push({ s, a: clampPct(a), b: clampPct(b), l: String(st[0] || INTENSITY[inten] || '').slice(0, 60) });
  }
  if (out.length === 0) throw new FitError('Keine Workout-Abschnitte gefunden');
  if (out.length > 500) throw new FitError('Mehr als 500 Abschnitte');
  return { name: (wk && wk.f[8]) || fallbackName, steps: out, warnings: [...warnings] };
}

module.exports = { parseFit, fitToWorkout, FitError };
