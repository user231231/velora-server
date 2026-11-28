'use strict';
// Automatische Einordnung von Workouts. Einzige Stelle für die Regeln: Web und App zeigen nur an.
// Grundlage sind Prozent-FTP-Werte, abgetastet im 5-Sekunden-Raster, in Reihenfolge der Abschnitte.

const DURATION_CATS = [
  { id: 'dur30', title: 'Unter 30 Minuten', badge: '30', color: '#0090d0', kind: 'duration' },
  { id: 'dur60', title: '30 bis 60 Minuten', badge: '30–60', color: '#00be55', kind: 'duration' },
  { id: 'dur90', title: '60 bis 90 Minuten', badge: '60–90', color: '#ff7f00', kind: 'duration' },
  { id: 'dur90p', title: 'Über 90 Minuten', badge: '90+', color: '#ff5020', kind: 'duration' },
];
const TYPE_CATS = [
  { id: 'recovery', title: 'Regeneration', badge: 'REGENERATION', color: '#8a88a8', kind: 'type' },
  { id: 'endurance', title: 'Ausdauer', badge: 'AUSDAUER', color: '#0090d0', kind: 'type' },
  { id: 'sweetspot', title: 'Tempo & Sweet Spot', badge: 'TEMPO & SWEET SPOT', color: '#00be55', kind: 'type' },
  { id: 'threshold', title: 'Schwelle', badge: 'SCHWELLE', color: '#f9c600', kind: 'type' },
  { id: 'vo2', title: 'VO2max & Sprint', badge: 'VO2MAX & SPRINT', color: '#e41f1f', kind: 'type' },
];
const TYPE_IDS = new Set(TYPE_CATS.map((c) => c.id));
const DURATION_IDS = new Set(DURATION_CATS.map((c) => c.id));

const totalSeconds = (steps) => steps.reduce((a, s) => a + s.s, 0);

function samples(steps) {
  const out = [];
  for (const st of steps) {
    const n = Math.max(1, Math.floor(st.s / 5));
    for (let i = 0; i < n; i++) out.push({ p: st.a + ((st.b - st.a) * (i + 0.5)) / n, sec: st.s / n });
  }
  return out;
}

// Summe aller zusammenhängenden Blöcke im Bereich [lo, hi) mit mindestens minSec Länge.
function sustained(sm, lo, hi, minSec) {
  let cur = 0;
  let sum = 0;
  const flush = () => { if (cur >= minSec) sum += cur; cur = 0; };
  for (const x of sm) {
    if (x.p >= lo && x.p < hi) cur += x.sec; else flush();
  }
  flush();
  return sum;
}

function durationCat(steps) {
  const t = totalSeconds(steps);
  return t <= 1800 ? 'dur30' : t <= 3600 ? 'dur60' : t <= 5400 ? 'dur90' : 'dur90p';
}

// Trainingsart: genau eine, nach Priorität VO2max, Schwelle, Tempo/Sweet Spot, Ausdauer, Regeneration.
function autoType(steps) {
  const sm = samples(steps);
  const total = sm.reduce((a, x) => a + x.sec, 0) || 1;
  const share = [0, 0, 0, 0, 0, 0];
  let avg = 0;
  for (const x of sm) {
    const z = x.p < 55 ? 0 : x.p < 76 ? 1 : x.p < 91 ? 2 : x.p < 106 ? 3 : x.p < 121 ? 4 : 5;
    share[z] += x.sec / total;
    avg += (x.p * x.sec) / total;
  }
  const high = share[3] + share[4] + share[5];
  if (share[4] + share[5] >= 0.06) return 'vo2';
  if (sustained(sm, 95, 106, 300) >= 600) return 'threshold';
  if (sustained(sm, 76, 97, 360) >= 720) return 'sweetspot';
  if (high >= 0.05) return 'threshold'; // viele kurze harte Intervalle ohne Dauerblock
  if (avg <= 58 && high < 0.02) return 'recovery';
  return 'endurance';
}

module.exports = { DURATION_CATS, TYPE_CATS, TYPE_IDS, DURATION_IDS, durationCat, autoType };
