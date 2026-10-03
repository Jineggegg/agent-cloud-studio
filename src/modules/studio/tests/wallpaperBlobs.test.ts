import { describe, expect, test } from 'vitest';

import {
  BLOB_POINTS, COLOUR_CHANGE_MS, COLOUR_MS, WALLPAPER_BLOBS, WALLPAPER_COLOURS,
  blobFrameInterval, blobOutline, blobStops, wallpaperBase, wallpaperColourAt,
} from '@/modules/studio/utils/wallpaperBlobs';

// The moment a colour's change into the next begins, on its `turn`.
const changeStarts = (turn: number) => turn * COLOUR_MS + COLOUR_MS - COLOUR_CHANGE_MS;
// The alpha of an hsla() colour string.
const alphaOf = (color: string) => Number(color.match(/, ([\d.]+)\)$/)?.[1]);

describe('scene colour', () => {
  test('takes turns in the approved order, one colour at a time, and comes round again to azure', () => {
    const order = Array.from({ length: 5 }, (_, turn) => wallpaperColourAt(turn * COLOUR_MS + 1).name);
    expect(order).toEqual(['天蓝', '薄荷', '草绿', '橙', '天蓝']);
    // Each colour holds for 15–25 s before it starts to change.
    expect(COLOUR_MS - COLOUR_CHANGE_MS).toBeGreaterThanOrEqual(15_000);
    expect(COLOUR_MS - COLOUR_CHANGE_MS).toBeLessThanOrEqual(25_000);
    expect(wallpaperColourAt(changeStarts(0) - 1)).toEqual({ ...WALLPAPER_COLOURS[0], glow: 1 });
    // A clock that has not started (or a bad value) still gives the first colour.
    expect(wallpaperColourAt(-5).name).toBe('天蓝');
    expect(wallpaperColourAt(Number.NaN).name).toBe('天蓝');
  });

  test('changes gradually over several seconds, never in a jump', () => {
    for (let turn = 0; turn < WALLPAPER_COLOURS.length; turn++) {
      let previous = wallpaperColourAt(changeStarts(turn));
      for (let at = changeStarts(turn); at <= (turn + 1) * COLOUR_MS; at += 100) {
        const now = wallpaperColourAt(at);
        expect(Math.abs(now.hue - previous.hue)).toBeLessThan(5);
        expect(Math.abs(now.lightness - previous.lightness)).toBeLessThan(1);
        expect(Math.abs(now.glow - previous.glow)).toBeLessThan(0.05);
        previous = now;
      }
      // Half-way through, it is between the two colours.
      const from = WALLPAPER_COLOURS[turn].hue;
      const to = WALLPAPER_COLOURS[(turn + 1) % WALLPAPER_COLOURS.length].hue;
      const middle = wallpaperColourAt(changeStarts(turn) + COLOUR_CHANGE_MS / 2).hue;
      expect(middle).toBeCloseTo((from + to) / 2, 6);
    }
  });

  test('never passes through purple, pink or red, whatever the moment', () => {
    for (let at = 0; at < COLOUR_MS * WALLPAPER_COLOURS.length * 2; at += 250) {
      const { hue } = wallpaperColourAt(at);
      expect(hue).toBeGreaterThanOrEqual(25);
      expect(hue).toBeLessThanOrEqual(215);
    }
  });

  test('dims the glow only part-way through a long change of hue', () => {
    // Azure to mint is a short step: barely any dip.
    expect(wallpaperColourAt(changeStarts(0) + COLOUR_CHANGE_MS / 2).glow).toBeGreaterThan(0.8);
    // Orange back to azure crosses half the wheel: the old colour fades out and the new one blooms.
    expect(wallpaperColourAt(changeStarts(3) + COLOUR_CHANGE_MS / 2).glow).toBeLessThan(0.5);
    expect(wallpaperColourAt(4 * COLOUR_MS + 1).glow).toBe(1);
  });
});

describe('blobs', () => {
  test('are one to three bubbles that drift in their own part of the screen without leaving it', () => {
    expect(WALLPAPER_BLOBS.length).toBeGreaterThanOrEqual(1);
    expect(WALLPAPER_BLOBS.length).toBeLessThanOrEqual(3);
    for (const blob of WALLPAPER_BLOBS) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (let at = 0; at < 600_000; at += 1000) {
        const { x, y } = blobOutline(blob, at, 1366, 1024);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(1366);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(1024);
        xs.push(x);
        ys.push(y);
      }
      // Over ten minutes each bubble visibly moves about.
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(1366 * 0.15);
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(1024 * 0.15);
    }
  });

  test('leave most of the screen empty: together they cover about a quarter of it', () => {
    const [width, height] = [1366, 1024];
    const side = Math.max(width, height);
    // Their resting discs, before the blur softens the rims away.
    const share = WALLPAPER_BLOBS.reduce((sum, blob) => sum + Math.PI * (side * blob.radius) ** 2, 0) / (width * height);
    expect(share).toBeGreaterThan(0.15);
    expect(share).toBeLessThan(0.3);
  });

  test('drift slowly: a 30 fps frame moves a blob by a pixel or so, its rim by a few at most', () => {
    for (const blob of WALLPAPER_BLOBS) {
      for (let at = 0; at < 120_000; at += 777) {
        const now = blobOutline(blob, at, 1366, 1024);
        const next = blobOutline(blob, at + 1000 / 30, 1366, 1024);
        expect(Math.hypot(next.x - now.x, next.y - now.y)).toBeLessThan(1.5);
        next.points.forEach(([x, y], index) => {
          expect(Math.hypot(x - now.points[index][0], y - now.points[index][1])).toBeLessThan(4);
        });
      }
    }
  });

  test('stay round but soft: the rim bulges and squashes a little, and the shape keeps changing', () => {
    const blob = WALLPAPER_BLOBS[0];
    const reaches = (at: number) => {
      const { x, y, radius, points } = blobOutline(blob, at, 1000, 800);
      expect(points).toHaveLength(BLOB_POINTS);
      return points.map(([px, py]) => Math.hypot(px - x, py - y) / radius);
    };
    const first = reaches(0);
    expect(Math.min(...first)).toBeGreaterThan(0.75);
    expect(Math.max(...first)).toBeLessThan(1.3);
    // Not a perfect circle, and not the same shape five seconds later.
    expect(Math.max(...first) - Math.min(...first)).toBeGreaterThan(0.05);
    const later = reaches(5000);
    expect(later.some((reach, index) => Math.abs(reach - first[index]) > 0.03)).toBe(true);
  });

  test('breathe: the radius swells and settles', () => {
    const radii = Array.from({ length: 40 }, (_, step) => blobOutline(WALLPAPER_BLOBS[1], step * 500, 1000, 800).radius);
    expect(Math.max(...radii) / Math.min(...radii)).toBeGreaterThan(1.08);
  });
});

describe('colours drawn', () => {
  test('both blobs share the scene hue, the second a little lighter', () => {
    const colour = wallpaperColourAt(1);
    const [first, second] = WALLPAPER_BLOBS.map(blob => blobStops(colour, blob, true)[0][1]);
    expect(first).toMatch(/^hsla\(206\.0, 92\.0%, 56\.0%, /);
    expect(second).toMatch(/^hsla\(212\.0, 92\.0%, 65\.0%, /);
  });

  test('glow fully at night and softer, lighter by day, fading toward the rim', () => {
    const colour = wallpaperColourAt(1);
    const night = blobStops(colour, WALLPAPER_BLOBS[0], true);
    const day = blobStops(colour, WALLPAPER_BLOBS[0], false);
    expect(night.map(([offset]) => offset)).toEqual([0, 0.5, 1]);
    expect(alphaOf(night[0][1])).toBeCloseTo(WALLPAPER_BLOBS[0].opacity, 4);
    expect(alphaOf(day[0][1])).toBeLessThan(alphaOf(night[0][1]));
    // Nothing at the rim: no edge, just the empty wallpaper round it.
    expect(alphaOf(night[2][1])).toBe(0);
    expect(day[0][1]).toMatch(/^hsla\(206\.0, 96\.0%, 66\.0%, /);
  });

  test('keep the base plain: near-black at night, near-white by day, with only a breath of the hue', () => {
    const colour = { ...WALLPAPER_COLOURS[3], glow: 1 };
    expect(wallpaperBase(colour, true)).toEqual(['hsl(30.0, 6%, 6.5%)', 'hsl(30.0, 4%, 3.5%)']);
    expect(wallpaperBase(colour, false)).toEqual(['hsl(30.0, 18%, 98%)', 'hsl(30.0, 10%, 96.5%)']);
  });
});

describe('frame rate', () => {
  test('is capped at 30 fps on high-density screens and devices that ask for less', () => {
    expect(blobFrameInterval({ devicePixelRatio: 2, prefersLess: false })).toBeCloseTo(1000 / 30, 6);
    expect(blobFrameInterval({ devicePixelRatio: 1, prefersLess: true })).toBeCloseTo(1000 / 30, 6);
    expect(blobFrameInterval({ devicePixelRatio: 1, prefersLess: false })).toBe(0);
  });
});
