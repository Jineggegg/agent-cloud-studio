import { describe, expect, test } from 'vitest';

import { BEAM_COUNT, BEAM_FAMILY_MS, beamFamilyAt, beamFrameInterval, beamStops, easeHue, resetBeam, spawnBeam, stepBeam } from '@/modules/studio/utils/wallpaperBeams';

// A fixed "random" source, so a beam's every random choice is the same known number.
const always = (value: number) => () => value;
const FRAME_MS = 1000 / 60;

describe('colour families', () => {
  test('take turns every 40 s in the approved order, and come round again to gold', () => {
    const order = Array.from({ length: 9 }, (_, step) => beamFamilyAt(step * BEAM_FAMILY_MS + 1).name);
    expect(order).toEqual(['金', '橙', '珊瑚', '玫瑰', '紫', '靛蓝', '青', '翠', '金']);
    expect(beamFamilyAt(0).hue).toBe(46);
    expect(beamFamilyAt(BEAM_FAMILY_MS - 1).name).toBe('金');
    expect(beamFamilyAt(BEAM_FAMILY_MS).name).toBe('橙');
    // A clock that has not started (or a bad value) still gives the first family.
    expect(beamFamilyAt(-5).name).toBe('金');
  });
});

describe('hue easing', () => {
  test('takes the shorter way round the colour wheel', () => {
    // Rose (340) toward coral (10) passes through 0, not back through 180.
    const halfway = easeHue(340, 10, 1000);
    expect(halfway > 340 || halfway < 10).toBe(true);
    const backwards = easeHue(10, 340, 1000);
    expect(backwards < 10 || backwards > 340).toBe(true);
  });

  test('changes nothing in no time and has all but arrived after about 10 s, at any frame rate', () => {
    expect(easeHue(46, 28, 0)).toBe(46);
    expect(Math.abs(easeHue(46, 28, 10_000) - 28)).toBeLessThan(0.5);
    // Sixty small steps land where one large one does.
    let stepped = 46;
    for (let frame = 0; frame < 60; frame++) stepped = easeHue(stepped, 28, 1000 / 60);
    expect(stepped).toBeCloseTo(easeHue(46, 28, 1000), 6);
  });
});

describe('beams', () => {
  test('spawn within the BeamsBackground ranges, coloured within ±25° of the family', () => {
    for (const value of [0, 0.5, 0.999]) {
      const beam = spawnBeam(1000, 800, 46, always(value));
      expect(beam.angle).toBeGreaterThanOrEqual(-35);
      expect(beam.angle).toBeLessThanOrEqual(-25);
      expect(beam.width).toBeGreaterThanOrEqual(30);
      expect(beam.width).toBeLessThanOrEqual(160);
      expect(beam.length).toBe(800 * 2.5);
      expect(beam.speed).toBeGreaterThanOrEqual(0.5);
      expect(beam.speed).toBeLessThanOrEqual(1.8);
      expect(beam.opacity).toBeGreaterThanOrEqual(0.12);
      expect(beam.opacity).toBeLessThanOrEqual(0.3);
      expect(Math.abs(beam.spread)).toBeLessThanOrEqual(25);
      expect(beam.hue).toBeCloseTo((46 + beam.spread + 360) % 360, 6);
    }
  });

  test('rise by their speed per 60 fps frame and pulse, whatever the frame rate', () => {
    const beam = spawnBeam(1000, 800, 46, always(0.5));
    const oneFrame = stepBeam(beam, 0, BEAM_COUNT, 1000, 800, 46, FRAME_MS);
    expect(oneFrame.y).toBeCloseTo(beam.y - beam.speed, 6);
    expect(oneFrame.pulse).toBeCloseTo(beam.pulse + beam.pulseSpeed, 6);
    // At 30 fps a step covers two frames' rise.
    expect(stepBeam(beam, 0, BEAM_COUNT, 1000, 800, 46, FRAME_MS * 2).y).toBeCloseTo(beam.y - beam.speed * 2, 6);
  });

  test('ease toward a new family instead of jumping to it', () => {
    const beam = { ...spawnBeam(1000, 800, 46, always(0.5)), spread: 0, hue: 46 };
    const next = stepBeam(beam, 0, BEAM_COUNT, 1000, 800, 28, FRAME_MS);
    expect(next.hue).toBeLessThan(46);
    expect(next.hue).toBeGreaterThan(45);
  });

  test('start again below the screen, in their column, once wholly above it', () => {
    const gone = { ...spawnBeam(900, 800, 46, always(0.5)), y: -2200 };
    for (const index of [0, 1, 2]) {
      const again = stepBeam(gone, index, 30, 900, 800, 46, FRAME_MS, always(0.5));
      expect(again.y).toBe(800 + 100);
      // Columns of 300 px; with the middle random value each beam sits at its column's centre.
      expect(again.x).toBe(index * 300 + 150);
      expect(again.width).toBeGreaterThanOrEqual(100);
      expect(again.width).toBeLessThanOrEqual(160);
    }
    // Reset beams spread evenly over the family: the first at -25°, later ones further round.
    expect(resetBeam(gone, 0, 30, 900, 800).spread).toBe(-25);
    expect(resetBeam(gone, 15, 30, 900, 800).spread).toBe(0);
  });

  test('a beam still on screen is not reset', () => {
    const beam = { ...spawnBeam(900, 800, 46, always(0.5)), y: 100 };
    expect(stepBeam(beam, 0, 30, 900, 800, 46, FRAME_MS).y).toBeLessThan(100);
  });
});

describe('gradient', () => {
  test('fades in and out along the beam, pulses ±20 % and is softer on the light wallpaper', () => {
    const alphas = (pulse: number, strength: number) => beamStops({ hue: 46, opacity: 0.3, pulse }, strength)
      .map(([, color]) => Number(/, ([\d.]+)\)$/.exec(color)![1]));
    const calm = alphas(0, 1);
    expect(calm).toEqual([0, 0.12, 0.24, 0.24, 0.12, 0]);
    expect(Math.max(...alphas(Math.PI / 2, 1))).toBeCloseTo(0.3, 4);
    expect(Math.max(...alphas(-Math.PI / 2, 1))).toBeCloseTo(0.18, 4);
    expect(Math.max(...alphas(0, 0.55))).toBeCloseTo(0.24 * 0.55, 4);
    expect(beamStops({ hue: 46, opacity: 0.3, pulse: 0 }, 1)[2][1]).toMatch(/^hsla\(46\.0, 85%, 65%, /);
  });
});

describe('frame rate', () => {
  test('is capped at 30 fps on high-density screens and devices that ask for less', () => {
    expect(beamFrameInterval({ devicePixelRatio: 1, prefersLess: false })).toBe(0);
    expect(beamFrameInterval({ devicePixelRatio: 2, prefersLess: false })).toBeCloseTo(1000 / 30);
    expect(beamFrameInterval({ devicePixelRatio: 1, prefersLess: true })).toBeCloseTo(1000 / 30);
  });
});
