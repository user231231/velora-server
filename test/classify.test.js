'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { autoType, durationCat } = require('../classify');

const st = (s, a, b = a) => ({ s, a, b, l: '' });
const rep = (n, ...steps) => Array.from({ length: n }, () => steps).flat();

test('Zwift-Ausdauer mit kurzen Tempo-Stücken bleibt Ausdauer', () => {
  const steps = [
    st(600, 47, 68), ...rep(3, st(120, 70), st(130, 75), st(120, 80), st(125, 85), st(125, 55)),
    st(130, 75), st(125, 85), st(115, 90), st(130, 55), st(300, 52),
  ];
  assert.equal(autoType(steps), 'endurance');
});

test('Sweet Spot: lange Blöcke am Stück', () => {
  assert.equal(autoType([st(600, 50, 70), st(1200, 90), st(300, 55), st(1200, 90), st(600, 50)]), 'sweetspot');
  assert.equal(autoType([st(600, 50, 70), ...rep(3, st(600, 90), st(300, 55))]), 'sweetspot');
});

test('Schwelle: 2x20 bei 100 %, auch viele kurze harte Intervalle', () => {
  assert.equal(autoType([st(600, 55), st(1200, 100), st(300, 55), st(1200, 100), st(300, 50)]), 'threshold');
  assert.equal(autoType([st(600, 55), ...rep(10, st(60, 100), st(60, 55))]), 'threshold');
});

test('VO2max und Sprint haben Vorrang', () => {
  assert.equal(autoType([st(600, 55), ...rep(5, st(180, 120), st(180, 50))]), 'vo2');
  assert.equal(autoType([st(1200, 55), ...rep(8, st(20, 180), st(100, 50))]), 'vo2');
  // viele kurze Spitzen plus Schwelle: trotzdem VO2max
  assert.equal(autoType([st(600, 55), st(600, 100), ...rep(3, st(60, 130), st(120, 55))]), 'vo2');
});

test('Regeneration und Ausdauer', () => {
  assert.equal(autoType([st(2400, 45)]), 'recovery');
  assert.equal(autoType([st(3600, 68)]), 'endurance');
});

test('Dauerkategorie', () => {
  assert.equal(durationCat([st(1500, 60)]), 'dur30');
  assert.equal(durationCat([st(1801, 60)]), 'dur60');
  assert.equal(durationCat([st(4500, 60)]), 'dur90');
  assert.equal(durationCat([st(7200, 60)]), 'dur90p');
});
