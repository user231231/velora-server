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

function exampleRoutes() {
  const c = (id, name, region, description, a, b) => ({
    id, name: region ? `${name} (${region})` : name, description, profile: 'fastbike',
    waypoints: [{ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }],
  });
  return [
    c('ex_alpe', "Alpe d'Huez", 'Frankreich', "21 Kehren von Le Bourg-d'Oisans, ca. 13 km mit rund 8 %.", [45.0547, 6.0325], [45.0917, 6.0689]),
    c('ex_ventoux', 'Mont Ventoux (ab Bédoin)', 'Frankreich', 'Der Klassiker durch den Wald und über die kahle Mondlandschaft, ca. 21 km.', [44.1233, 5.1783], [44.1739, 5.2786]),
    c('ex_stilfser', 'Stilfser Joch (ab Prato)', 'Italien', '48 Kehren auf 2.757 m Höhe, über 24 km Anstieg.', [46.6125, 10.5875], [46.5287, 10.4531]),
    c('ex_tourmalet', 'Col du Tourmalet (ab Luz)', 'Frankreich', 'Pyrenäen-Riese, rund 19 km mit durchschnittlich 7 %.', [42.873, -0.0033], [42.9087, 0.1433]),
    c('ex_galibier', 'Col du Galibier (ab Valloire)', 'Frankreich', 'Hochalpiner Pass auf 2.642 m, ca. 18 km.', [45.1673, 6.4286], [45.0643, 6.4075]),
    c('ex_feldberg', 'Feldberg (Schwarzwald)', 'Deutschland', 'Von Todtnau auf den höchsten Gipfel des Schwarzwalds.', [47.8273, 7.9455], [47.874, 8.004]),
    c('ex_glockner', 'Großglockner Hochalpenstraße', 'Österreich', 'Von Fusch zum Hochtor, über 20 km Dauerklettern.', [47.288, 12.819], [47.085, 12.845]),
  ];
}

module.exports = { builtInWorkouts, exampleRoutes, EXAMPLE_FOLDER: 'Beispiele' };
