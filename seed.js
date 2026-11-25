'use strict';
// Eingebaute Workouts. IDs und Aufbau entsprechen lib/core/workout.dart der App.

const step = (s, a, b, l = '') => ({ s, a, b: b == null ? a : b, l });
const repeat = (n, block) => Array.from({ length: n }, () => block).flat();

function builtInWorkouts() {
  const ramp = [];
  for (let p = 40; p <= 200; p += 5) ramp.push(step(60, p, null, `Stufe ${p} %`));
  return [
    {
      id: 'builtin_z2_60',
      name: 'Grundlage 60 min',
      description: 'Lockere Ausdauer im Bereich Z2, ideal für Regenerationstage.',
      steps: [step(600, 45, 65, 'Einrollen'), step(2700, 65, null, 'Grundlage'), step(300, 60, 40, 'Ausrollen')],
    },
    {
      id: 'builtin_ss_3x12',
      name: 'Sweet Spot 3×12',
      description: 'Drei Blöcke à 12 Minuten bei 90 % FTP. Effizient für die Schwelle.',
      steps: [
        step(600, 50, 70, 'Einrollen'),
        ...repeat(3, [step(720, 90, null, 'Sweet Spot'), step(240, 55, null, 'Pause')]),
        step(300, 55, 40, 'Ausrollen'),
      ],
    },
    {
      id: 'builtin_vo2_5x4',
      name: 'VO2max 5×4',
      description: 'Fünf harte Intervalle à 4 Minuten bei 115 % FTP.',
      steps: [
        step(720, 50, 75, 'Einrollen'),
        ...repeat(5, [step(240, 115, null, 'Intervall'), step(240, 50, null, 'Pause')]),
        step(300, 55, 40, 'Ausrollen'),
      ],
    },
    {
      id: 'builtin_overunder',
      name: 'Über/Unter 3×9',
      description: 'Wechsel zwischen 95 % und 105 % FTP, trainiert das Abbauen von Laktat.',
      steps: [
        step(600, 50, 70, 'Einrollen'),
        ...repeat(3, [
          ...repeat(3, [step(120, 95, null, 'Unter'), step(60, 105, null, 'Über')]),
          step(240, 55, null, 'Pause'),
        ]),
        step(300, 55, 40, 'Ausrollen'),
      ],
    },
    {
      id: 'builtin_30_30',
      name: '30/30 Kurzintervalle',
      description: '3 Sätze à 8 × (30 s hart / 30 s locker).',
      steps: [
        step(600, 50, 70, 'Einrollen'),
        ...repeat(3, [
          ...repeat(8, [step(30, 130, null, 'Hart'), step(30, 50, null, 'Locker')]),
          step(300, 50, null, 'Pause'),
        ]),
        step(300, 55, 40, 'Ausrollen'),
      ],
    },
    {
      id: 'builtin_ramp',
      name: 'Rampentest',
      description: 'Alle 60 s +5 % FTP, bis du nicht mehr kannst. FTP-Schätzung: 75 % der besten Minute.',
      steps: ramp,
    },
  ].map((w) => ({ ...w, builtIn: true }));
}

module.exports = { builtInWorkouts };
