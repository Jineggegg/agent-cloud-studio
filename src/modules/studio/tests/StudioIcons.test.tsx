import { render } from '@testing-library/react';
import { expect, test } from 'vitest';

import * as tabler from '@/modules/studio/icons/tabler';
import { StudioTileIcon } from '@/modules/studio/StudioTileIcon';

// Every frontend source file, as text, to check which icons it imports.
const SOURCES = import.meta.glob<string>(['/src/**/*.ts', '/src/**/*.tsx', '!/src/**/tests/**'], { query: '?raw', import: 'default', eager: true });
const studioSources = Object.entries(SOURCES).filter(([path]) => path.startsWith('/src/modules/studio/'));

function iconOf(element: Element) {
  const svg = element.querySelector('svg');
  return { brand: svg?.getAttribute('data-brand') ?? null, icon: svg?.getAttribute('data-icon') ?? null };
}

test('built-in products with an official mark show it; everything else keeps a Tabler glyph', () => {
  const cases: [product: string | undefined, glyph: string, expected: { brand: string | null; icon: string | null }][] = [
    ['github', 'pull-request', { brand: 'github', icon: null }],
    ['deepseek', 'sparkles', { brand: 'deepseek', icon: null }],
    ['claude', 'sparkles', { brand: 'claude', icon: null }],
    // Codex is OpenAI's.
    ['codex', 'terminal', { brand: 'openai', icon: null }],
    // Built-in apps without a published mark, and every project, keep their glyph.
    ['memory', 'book', { brand: null, icon: 'book' }],
    ['aj-exit', 'globe', { brand: null, icon: 'world' }],
    ['workspace', 'terminal', { brand: null, icon: 'terminal-2' }],
    ['project:github-mirror', 'activity', { brand: null, icon: 'activity' }],
    [undefined, 'graduation', { brand: null, icon: 'school' }],
    // An unknown glyph falls back to a folder.
    ['project:old', 'no-such-glyph', { brand: null, icon: 'folder' }],
  ];
  for (const [product, glyph, expected] of cases) {
    const { container, unmount } = render(<StudioTileIcon tone="stone" glyph={glyph} product={product} />);
    expect({ product, ...iconOf(container) }).toEqual({ product, ...expected });
    unmount();
  }
});

test('brand marks and Tabler glyphs are drawn in the current colour and hidden from assistive technology', () => {
  const { container } = render(<><StudioTileIcon tone="stone" glyph="book" product="github" /><tabler.IconBook size={20} /></>);
  const [mark, glyph] = Array.from(container.querySelectorAll('svg'));
  expect(mark.getAttribute('fill')).toBe('currentColor');
  expect(glyph.getAttribute('stroke')).toBe('currentColor');
  // Tabler's 2 px stroke is lightened to sit beside the filled marks.
  expect(glyph.getAttribute('stroke-width')).toBe('1.75');
  expect(glyph.getAttribute('width')).toBe('20');
  expect(glyph.getAttribute('aria-hidden')).toBe('true');
  expect(glyph.querySelectorAll('path').length).toBeGreaterThan(0);
});

test('every Tabler icon the app imports is in the vendored set and draws something', () => {
  const imported = new Set<string>();
  for (const [, text] of Object.entries(SOURCES)) {
    for (const match of text.matchAll(/import \{([^}]*)\} from '@\/modules\/studio\/icons\/tabler'/g)) {
      for (const name of match[1].split(',').map(part => part.trim()).filter(Boolean)) imported.add(name);
    }
  }
  expect(imported.size).toBeGreaterThan(40);
  const vendored = tabler as Record<string, unknown>;
  const missing = [...imported].filter(name => typeof vendored[name] !== 'function');
  expect(missing).toEqual([]);
  for (const [name, Icon] of Object.entries(tabler)) {
    const { container, unmount } = render(<Icon />);
    expect({ name, paths: container.querySelectorAll('svg > path').length > 0 }).toEqual({ name, paths: true });
    unmount();
  }
});

test('Studio draws its line icons with Tabler, not lucide', () => {
  expect(studioSources.length).toBeGreaterThan(30);
  expect(studioSources.filter(([, text]) => text.includes("from 'lucide-react'")).map(([path]) => path)).toEqual([]);
});
