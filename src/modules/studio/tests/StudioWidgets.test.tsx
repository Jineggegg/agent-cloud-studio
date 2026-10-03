import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';

// Most tests place only SNR widgets, which read their data from props; any network call there would be a bug.
const mocks = vi.hoisted(() => ({ quota: vi.fn(), trading212: { status: vi.fn(), overview: vi.fn(), history: vi.fn() } }));
vi.mock('@/shared/api', () => ({
  api: { studio: { quota: mocks.quota, trading212: mocks.trading212 } },
  readApiJson: async (response: Response) => response.json(),
}));
// jsdom never upgrades NumberFlow's custom element, so a figure that changes (剩余 → 已用) would throw there;
// this stand-in prints the formatted figure.
vi.mock('@number-flow/react', () => ({
  default: ({ value, suffix = '', format, locales }: { value: number; suffix?: string; format?: Intl.NumberFormatOptions; locales?: string }) =>
    <span>{`${format ? new Intl.NumberFormat(locales, format).format(value) : value}${suffix}`}</span>,
}));

import { StudioWidgets } from '@/modules/studio/StudioWidgets';
import { installPointerEvent, layOutSortablesInARow, layOutSortablesInGrid, moveOnePlaceWithKeyboard } from '@/modules/studio/tests/sortableTestHelpers';

const STORAGE_KEY = 'studio-widgets-v1';
const SNR = { connected: true, phase: '2', manifest: { version: '3.0' } } as unknown as Parameters<typeof StudioWidgets>[0]['snr'];
const MOUSE = { button: 0, isPrimary: true, pointerType: 'mouse' } as const;

beforeAll(installPointerEvent);
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(STORAGE_KEY, JSON.stringify([
    { id: 'w-a', type: 'snr', size: 'small' },
    { id: 'w-b', type: 'snr', size: 'medium' },
    { id: 'w-c', type: 'snr', size: 'small' },
  ]));
});
afterEach(() => {
  cleanup();
  // Run the drag's self-removing click guards so they cannot outlive the test.
  if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

const onOpen = vi.fn();
function renderWidgets(editing: boolean) {
  const onEnterEdit = vi.fn();
  onOpen.mockReset();
  render(<StudioWidgets editing={editing} snr={SNR} onEnterEdit={onEnterEdit} onOpen={onOpen} galleryOpen={false} onGalleryClose={vi.fn()} />);
  return onEnterEdit;
}

function cards() {
  return Array.from(screen.getByRole('region', { name: '小组件' }).querySelectorAll<HTMLElement>('[data-sort-id]'));
}

function card(id: string) {
  const found = cards().find(item => item.dataset.sortId === id);
  if (!found) throw new Error(`no widget ${id}`);
  return found;
}

function shownOrder() {
  return cards().map(item => item.dataset.sortId);
}

function savedOrder() {
  return (JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as { id: string }[]).map(widget => widget.id);
}

// The copy of a dragged widget that dnd-kit's DragOverlay draws under the pointer.
function liftedCopy() {
  return document.querySelector<HTMLElement>('.widget-drag-overlay > .widget');
}

// dnd-kit's DragOverlay keeps a copy of the lifted card for one microtask after a drop (where its drop animation
// would run); this lets that pass.
async function settleOverlay() {
  await act(async () => { await Promise.resolve(); });
}

// The studio stylesheets as text. Vitest blanks CSS imports (even `?raw`) and the frontend program has no Node
// types, so Node's fs is loaded through a specifier TypeScript does not try to resolve. (jsdom's URL cannot
// resolve against a file: URL, hence the plain path arithmetic.)
async function readStylesheet(name: string) {
  const fsModule = 'node:fs';
  const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as { readFileSync: (path: string, encoding: 'utf8') => string };
  const testsDir = decodeURIComponent(import.meta.url.replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1')).replace(/\/[^/]*$/, '');
  return readFileSync(`${testsDir}/../${name}`, 'utf8');
}

// Small widgets take one column of the grid, medium and large ones two.
const spanOfWidget = (item: Element) => item.classList.contains('widget-small') ? 1 : 2;

function savedSizes() {
  return (JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as { size: string }[]).map(widget => widget.size);
}

test('a long press on a widget asks the home screen to enter edit mode; a short press does not', () => {
  vi.useFakeTimers();
  const onEnterEdit = renderWidgets(false);
  const [first, second] = cards();

  fireEvent.pointerDown(second, MOUSE);
  act(() => { vi.advanceTimersByTime(200); });
  fireEvent.pointerUp(second);
  expect(onEnterEdit).not.toHaveBeenCalled();

  fireEvent.pointerDown(first, MOUSE);
  act(() => { vi.advanceTimersByTime(500); });
  expect(onEnterEdit).toHaveBeenCalledTimes(1);
  fireEvent.pointerUp(first);
  // Lifting without moving changes nothing.
  expect(savedOrder()).toEqual(['w-a', 'w-b', 'w-c']);
});

test('touch and Apple Pencil pointers are left to the touch sensor, so neither lifts a widget through the pointer path', () => {
  vi.useFakeTimers();
  const onEnterEdit = renderWidgets(false);
  const [first, second] = cards();
  // A pen on the pointer path is cancelled by Safari's panning as soon as it moves; the touch sensor prevents that.
  fireEvent.pointerDown(first, { button: 0, isPrimary: true, pointerType: 'touch' });
  act(() => { vi.advanceTimersByTime(800); });
  fireEvent.pointerDown(second, { button: 0, isPrimary: true, pointerType: 'pen' });
  act(() => { vi.advanceTimersByTime(800); });
  expect(onEnterEdit).not.toHaveBeenCalled();
});

test('outside edit mode widgets are not focusable and show no edit controls', () => {
  renderWidgets(false);
  expect(cards().every(item => !item.hasAttribute('tabindex'))).toBe(true);
  expect(screen.queryByRole('button', { name: /移除/ })).toBeNull();
  expect(screen.queryByRole('slider')).toBeNull();
});

test('a widget dragged to a new place keeps that order on this device', async () => {
  const rects = layOutSortablesInARow();
  renderWidgets(true);
  await moveOnePlaceWithKeyboard(cards()[0], 'ArrowRight');
  expect(shownOrder()).toEqual(['w-b', 'w-a', 'w-c']);
  expect(savedOrder()).toEqual(['w-b', 'w-a', 'w-c']);
  rects.mockRestore();
  expect(mocks.quota).not.toHaveBeenCalled();
});

test('with small and medium widgets in two columns, a small widget dragged onto a medium one lands below it, exactly as previewed', async () => {
  vi.useFakeTimers();
  localStorage.setItem(STORAGE_KEY, JSON.stringify([
    { id: 'w-a', type: 'snr', size: 'medium' },
    { id: 'w-b', type: 'snr', size: 'small' },
    { id: 'w-c', type: 'snr', size: 'small' },
    { id: 'w-d', type: 'snr', size: 'medium' },
  ]));
  // Rows of 100px cells: a a / b c / d d (the default widget set has this shape on a phone).
  const rects = layOutSortablesInGrid(2, spanOfWidget);
  renderWidgets(true);

  fireEvent.pointerDown(card('w-b'), { ...MOUSE, clientX: 50, clientY: 150 });
  fireEvent.pointerMove(document, { clientX: 58, clientY: 156 });
  fireEvent.pointerMove(document, { clientX: 150, clientY: 250 });
  // The grid reorders while the pointer is still down, so the preview is the real layout: b's empty slot already
  // sits on a row of its own below d, and the card itself rides in the overlay.
  expect(shownOrder()).toEqual(['w-a', 'w-c', 'w-d', 'w-b']);
  expect(card('w-b').classList.contains('is-placeholder')).toBe(true);
  expect(liftedCopy()?.getAttribute('aria-hidden')).toBe('true');
  expect(liftedCopy()?.textContent).toContain('SNR 实验室');

  fireEvent.pointerUp(document, { clientX: 150, clientY: 250 });
  await settleOverlay();
  // The drop keeps exactly what was shown (rows: a a / c _ / d d / b _).
  expect(shownOrder()).toEqual(['w-a', 'w-c', 'w-d', 'w-b']);
  expect(savedOrder()).toEqual(['w-a', 'w-c', 'w-d', 'w-b']);
  expect(card('w-b').getBoundingClientRect().top).toBeGreaterThan(card('w-d').getBoundingClientRect().top);
  expect(card('w-b').classList.contains('is-placeholder')).toBe(false);
  expect(liftedCopy()).toBeNull();
  rects.mockRestore();
});

test('Esc during a drag puts every widget back where it was before the drag', async () => {
  vi.useFakeTimers();
  // Rows: a _ / b b / c _.
  const rects = layOutSortablesInGrid(2, spanOfWidget);
  renderWidgets(true);
  fireEvent.pointerDown(card('w-a'), { ...MOUSE, clientX: 50, clientY: 50 });
  fireEvent.pointerMove(document, { clientX: 58, clientY: 56 });
  fireEvent.pointerMove(document, { clientX: 80, clientY: 150 });
  expect(shownOrder()).toEqual(['w-b', 'w-a', 'w-c']);
  fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' });
  await settleOverlay();
  expect(shownOrder()).toEqual(['w-a', 'w-b', 'w-c']);
  expect(savedOrder()).toEqual(['w-a', 'w-b', 'w-c']);
  expect(liftedCopy()).toBeNull();
  rects.mockRestore();
});

test('the widget grid places cards in their saved order, never back-filling gaps (a drop could not predict that)', async () => {
  const stylesheets = [await readStylesheet('studio.css'), await readStylesheet('studio-home.css')];
  const widgetGridRules = stylesheets.flatMap(css => [...css.matchAll(/\.widget-grid[^{,]*\{[^}]*\}/g)].map(match => match[0]));
  expect(widgetGridRules.some(rule => rule.includes('grid-template-columns'))).toBe(true);
  expect(widgetGridRules.filter(rule => /grid-auto-flow\s*:[^;}]*dense/.test(rule))).toEqual([]);
});

test('the lifted copy of a Trading 212 widget reuses the grid\'s reading instead of fetching again', async () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([{ id: 'w-t', type: 'trading212', size: 'medium' }, { id: 'w-s', type: 'snr', size: 'small' }]));
  mocks.trading212.status.mockResolvedValue(Response.json([{ env: 'live', configured: false, source: null }]));
  const rects = layOutSortablesInARow();
  renderWidgets(true);
  expect(await screen.findByText('未接入账户')).toBeTruthy();

  const tradingCard = card('w-t');
  tradingCard.focus();
  fireEvent.keyDown(tradingCard, { code: 'Space', key: ' ' });
  expect(liftedCopy()?.textContent).toContain('未接入账户');
  expect(mocks.trading212.status).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' });
  rects.mockRestore();
});

test('edit mode shows a resize corner instead of move and resize buttons', () => {
  renderWidgets(true);
  expect(screen.queryByRole('button', { name: /前移|后移|放大|缩小/ })).toBeNull();
  expect(screen.getAllByRole('slider', { name: '调整 SNR 实验室 大小' }).map(handle => handle.getAttribute('aria-valuetext'))).toEqual(['小', '中', '小']);
});

test('dragging a widget corner snaps it between small, medium and large, without lifting the widget', () => {
  vi.useFakeTimers();
  const onEnterEdit = renderWidgets(true);
  const first = card('w-a');
  // A small widget is one 100px cell; the grid has no gap in jsdom.
  vi.spyOn(first, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) } as DOMRect);
  const handle = screen.getAllByRole('slider', { name: '调整 SNR 实验室 大小' })[0];

  fireEvent.pointerDown(handle, { ...MOUSE, clientX: 100, clientY: 100 });
  // Less than half a cell further changes nothing.
  fireEvent.pointerMove(handle, { clientX: 140, clientY: 120 });
  expect(savedSizes()).toEqual(['small', 'medium', 'small']);
  // Past half a cell to the right: two columns.
  fireEvent.pointerMove(handle, { clientX: 170, clientY: 120 });
  expect(savedSizes()).toEqual(['medium', 'medium', 'small']);
  // And down as well: two rows, the large size.
  fireEvent.pointerMove(handle, { clientX: 190, clientY: 180 });
  expect(savedSizes()).toEqual(['large', 'medium', 'small']);
  expect(first.classList.contains('widget-large')).toBe(true);
  // Back towards the start: small again.
  fireEvent.pointerMove(handle, { clientX: 110, clientY: 110 });
  fireEvent.pointerMove(handle, { clientX: 190, clientY: 110 });
  fireEvent.pointerUp(handle, { clientX: 190, clientY: 110 });
  expect(savedSizes()).toEqual(['medium', 'medium', 'small']);
  // Moving the pointer after the drag ended resizes nothing.
  fireEvent.pointerMove(handle, { clientX: 300, clientY: 300 });
  expect(savedSizes()).toEqual(['medium', 'medium', 'small']);

  act(() => { vi.advanceTimersByTime(800); });
  expect(onEnterEdit).not.toHaveBeenCalled();
  expect(liftedCopy()).toBeNull();
});

test('the resize corner is a slider for the keyboard and stays within the three sizes', () => {
  renderWidgets(true);
  const handle = screen.getAllByRole('slider', { name: '调整 SNR 实验室 大小' })[0];
  handle.focus();
  fireEvent.keyDown(handle, { key: 'ArrowRight', code: 'ArrowRight' });
  expect(savedSizes()[0]).toBe('medium');
  fireEvent.keyDown(handle, { key: 'End', code: 'End' });
  expect(savedSizes()[0]).toBe('large');
  expect(handle.getAttribute('aria-valuetext')).toBe('大');
  fireEvent.keyDown(handle, { key: 'ArrowUp', code: 'ArrowUp' });
  expect(savedSizes()[0]).toBe('large');
  fireEvent.keyDown(handle, { key: 'Home', code: 'Home' });
  expect(savedSizes()[0]).toBe('small');
  // The keys resize; they never pick the widget up.
  expect(liftedCopy()).toBeNull();
  expect(savedOrder()).toEqual(['w-a', 'w-b', 'w-c']);
});

test('a large widget is kept on this device and shows its detail rows', () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([{ id: 'w-a', type: 'snr', size: 'large' }, { id: 'w-x', type: 'snr', size: 'huge' }]));
  renderWidgets(false);
  expect(cards().map(item => item.className.includes('widget-large'))).toEqual([true]);
  expect(screen.getByText('数据集')).toBeTruthy();
  expect(screen.getByText('规则')).toBeTruthy();
});

test('edit mode removes widgets, and the layout is remembered', () => {
  renderWidgets(true);
  fireEvent.click(screen.getAllByRole('button', { name: '移除 SNR 实验室' })[1]);
  expect(savedOrder()).toEqual(['w-a', 'w-c']);
});

test('a tap on a widget opens its app with the card as the zoom origin; edit mode has no open button', () => {
  renderWidgets(false);
  const first = card('w-a');
  vi.spyOn(first, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 20, left: 10, top: 20, right: 110, bottom: 120, width: 100, height: 100, toJSON: () => ({}) } as DOMRect);
  fireEvent.click(screen.getAllByRole('button', { name: '打开 SNR 实验室' })[0]);
  expect(onOpen).toHaveBeenCalledWith('snr', expect.objectContaining({ left: 10, width: 100 }));
  cleanup();
  renderWidgets(true);
  expect(screen.queryByRole('button', { name: /打开/ })).toBeNull();
});

test('the eye on the Trading 212 widget hides every amount, is remembered on this device and does not open the app', async () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([{ id: 'w-t', type: 'trading212', size: 'large' }]));
  localStorage.removeItem('studio-widgets-hide-amounts');
  const overview = {
    env: 'live', currency: 'GBP', totalValue: 10071.22, fetchedAt: '2026-10-02T10:00:00Z',
    cash: { available: 5789, reserved: 0, inPies: 0 }, investments: { value: 3483, cost: 3400, unrealized: 39, realized: 0 },
    changes: { today: { amount: 12.5, percent: 0.12, since: '2026-10-02T00:00:00Z', flowAdjusted: false }, yesterday: null },
    recordedSince: null,
    positions: [{ ticker: 'VUSA', name: 'Vanguard S&P 500', currency: 'GBP', quantity: 1, averagePrice: 1, currentPrice: 1, value: 2000, cost: 1980, pnl: 18.99, fx: null, openedAt: '2026-01-01' }],
  };
  mocks.trading212.status.mockImplementation(async () => Response.json([{ env: 'live', configured: true, source: 'file' }]));
  mocks.trading212.overview.mockImplementation(async () => Response.json(overview));
  mocks.trading212.history.mockImplementation(async () => Response.json([]));
  renderWidgets(false);
  const eye = await screen.findByRole('button', { name: '隐藏金额' });
  const tradingCard = card('w-t');
  expect(tradingCard.textContent).toContain('5,789');
  fireEvent.click(eye);
  expect(onOpen).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '显示金额' }).getAttribute('aria-pressed')).toBe('true');
  expect(tradingCard.textContent).toContain('金额已隐藏');
  expect(tradingCard.textContent).not.toMatch(/5,789|3,483|18\.99|10,071|12\.50/);
  expect(localStorage.getItem('studio-widgets-hide-amounts')).toBe('1');
  cleanup();
  renderWidgets(false);
  expect(await screen.findByRole('button', { name: '显示金额' })).toBeTruthy();
});

test('with amounts hidden the Trading 212 widget still shows today’s change as a coloured, signed percentage with an arrow', async () => {
  const overview = (amount: number, percent: number) => ({
    env: 'live', currency: 'GBP', totalValue: 10071.22, fetchedAt: '2026-10-02T10:00:00Z',
    cash: { available: 5789, reserved: 0, inPies: 0 }, investments: { value: 3483, cost: 3400, unrealized: 39, realized: 0 },
    changes: { today: { amount, percent, since: '2026-10-02T00:00:00Z', flowAdjusted: false }, yesterday: null },
    recordedSince: null, positions: [],
  });
  localStorage.setItem(STORAGE_KEY, JSON.stringify([{ id: 'w-t', type: 'trading212', size: 'medium' }]));
  localStorage.setItem('studio-widgets-hide-amounts', '1');
  mocks.trading212.status.mockImplementation(async () => Response.json([{ env: 'live', configured: true, source: 'file' }]));
  mocks.trading212.history.mockImplementation(async () => Response.json([]));

  mocks.trading212.overview.mockImplementation(async () => Response.json(overview(12.5, 1.24)));
  renderWidgets(false);
  await screen.findByRole('button', { name: '显示金额' });
  let today = card('w-t').querySelector('.widget-today') as HTMLElement;
  expect(today.className).toContain('gain');
  expect(today.querySelector('[data-icon="arrow-up-right"]')).toBeTruthy();
  expect(today.textContent).toBe('盈利+1.24% 今日');
  // Only the percentage: no amount, total, cash or change in money anywhere on the card.
  expect(card('w-t').textContent).not.toMatch(/12\.50|10,071|5,789|3,483/);
  cleanup();

  mocks.trading212.overview.mockImplementation(async () => Response.json(overview(-30.1, -0.3)));
  renderWidgets(false);
  await screen.findByRole('button', { name: '显示金额' });
  today = card('w-t').querySelector('.widget-today') as HTMLElement;
  expect(today.className).toContain('loss');
  expect(today.querySelector('[data-icon="arrow-down-right"]')).toBeTruthy();
  expect(today.textContent).toBe('亏损−0.30% 今日');
  expect(card('w-t').textContent).not.toMatch(/30\.10/);
  // Showing the amounts again keeps the same red, signed line with the money added.
  fireEvent.click(screen.getByRole('button', { name: '显示金额' }));
  expect((card('w-t').querySelector('.widget-today') as HTMLElement).textContent).toBe('亏损−30.10（0.30%）今日');
});

// ── Quota widgets: 剩余 / 已用 and the items chosen in Settings (studio-quota-display-v1) ──

const QUOTA_PREFERENCES_KEY = 'studio-quota-display-v1';
const QUOTA_SNAPSHOTS = [
  { provider: 'claude', available: true, balances: [], source: 'usage-api', observedAt: new Date().toISOString(), stale: false,
    windows: [
      { id: 'five_hour', label: '5 小时', usedPercent: 9, windowMinutes: 300, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() },
      { id: 'seven_day', label: '每周', usedPercent: 4, windowMinutes: 10080, resetsAt: null },
      { id: 'weekly_scoped:fable', label: '每周 · Fable', usedPercent: 0, windowMinutes: 10080, resetsAt: null, model: 'Fable' },
    ],
    credits: [{ id: 'cinder_cove', label: '云端额度', usedPercent: 8.4, currency: 'USD', limit: 250, used: 21, remaining: 229, endsAt: null, endKind: 'expires' }] },
  { provider: 'codex', available: false, windows: [], balances: [], source: 'unavailable', observedAt: null, stale: false, note: '暂无 Codex 用量' },
  { provider: 'deepseek', available: true, windows: [], balances: [{ currency: 'CNY', total: 253.99, granted: 0, toppedUp: 253.99 }], source: 'official', observedAt: new Date().toISOString(), stale: false },
];

function placeQuotaWidgets(claudeSize: 'medium' | 'large') {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([{ id: 'w-claude', type: 'claude', size: claudeSize }, { id: 'w-deepseek', type: 'deepseek', size: 'small' }]));
  mocks.quota.mockImplementation(async () => Response.json(QUOTA_SNAPSHOTS));
}

test('quota rings show what is left by default and follow a change of 剩余 / 已用 and of the chosen items at once', async () => {
  placeQuotaWidgets('medium');
  renderWidgets(false);
  const session = await screen.findByTitle('5 小时 剩余 91%');
  expect(session.textContent).toContain('剩余');
  expect(session.textContent).toContain('2 小时后重置');
  expect(screen.getByTitle('每周 剩余 96%')).toBeTruthy();
  // Per-model windows and credits are off until chosen.
  expect(screen.queryByTitle(/Fable|云端额度/)).toBeNull();
  expect(card('w-deepseek').textContent).toContain('253.99');

  // Settings (here, another tab) flips to 已用, hides 5 小时 and the DeepSeek balance, and adds Fable.
  localStorage.setItem(QUOTA_PREFERENCES_KEY, JSON.stringify({
    mode: 'used', items: { 'claude:window:five_hour': false, 'claude:window:weekly_scoped:fable': true, 'deepseek:balance': false },
  }));
  act(() => { window.dispatchEvent(new StorageEvent('storage', { key: QUOTA_PREFERENCES_KEY })); });
  expect(screen.getByTitle('每周 已用 4%')).toBeTruthy();
  expect(screen.getByTitle('每周 · Fable 已用 0%')).toBeTruthy();
  expect(screen.queryByTitle(/5 小时/)).toBeNull();
  expect(card('w-deepseek').textContent).toContain('已在 设置 → 额度显示 中隐藏');
  expect(card('w-deepseek').textContent).not.toContain('253.99');
});

test('a large quota widget lists every chosen item, credits with their amounts, and says when all are hidden', async () => {
  localStorage.setItem(QUOTA_PREFERENCES_KEY, JSON.stringify({ mode: 'remaining', items: { 'claude:credit:cinder_cove': true } }));
  placeQuotaWidgets('large');
  renderWidgets(false);
  await screen.findByTitle('云端额度 剩余 92%');
  const rows = card('w-claude').querySelectorAll('.widget-rows li');
  expect(Array.from(rows).map(row => row.querySelector('span')?.textContent)).toEqual(['5 小时', '每周', '云端额度']);
  expect(rows[2].textContent).toContain('剩余 $229 / $250');
  expect(rows[2].querySelector('strong')?.textContent).toBe('剩余 92%');

  cleanup();
  localStorage.setItem(QUOTA_PREFERENCES_KEY, JSON.stringify({ mode: 'remaining', items: { 'claude:window:five_hour': false, 'claude:window:seven_day': false } }));
  renderWidgets(false);
  expect(await screen.findByText('已在 设置 → 额度显示 中隐藏')).toBeTruthy();
});

test('figures from an earlier read stay on the card, with their age in the badge and the server note in its tooltip and the footnote', async () => {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const claudeFrom = (minutes: number, stale: boolean) => ({
    ...QUOTA_SNAPSHOTS[0], observedAt: ago(minutes), stale, note: `Claude 用量接口暂时限流，显示 ${minutes} 分钟前的读数。`,
  });
  const show = async (claude: object) => {
    cleanup();
    localStorage.setItem(STORAGE_KEY, JSON.stringify([{ id: 'w-medium', type: 'claude', size: 'medium' }, { id: 'w-large', type: 'claude', size: 'large' }]));
    mocks.quota.mockImplementation(async () => Response.json([claude, QUOTA_SNAPSHOTS[1], QUOTA_SNAPSHOTS[2]]));
    renderWidgets(false);
    expect((await screen.findAllByTitle('5 小时 剩余 91%')).length).toBe(2);
    return (id: string) => card(id).querySelector('.widget-source');
  };

  let badge = await show(claudeFrom(12, false));
  for (const id of ['w-medium', 'w-large']) {
    expect(badge(id)?.textContent).toBe('12 分钟前');
    expect(badge(id)?.getAttribute('title')).toBe('官方：Claude 用量接口暂时限流，显示 12 分钟前的读数。');
    expect(badge(id)?.classList.contains('is-stale')).toBe(false);
    expect(card(id).querySelector('.widget-note')).toBeNull();
  }
  expect(card('w-large').querySelector('.widget-footnote')?.textContent).toBe('Claude 用量接口暂时限流，显示 12 分钟前的读数。');

  // Flagged stale: the rings stay, the badge turns orange.
  badge = await show(claudeFrom(38, true));
  expect(badge('w-medium')?.textContent).toBe('38 分钟前');
  expect(badge('w-medium')?.classList.contains('is-stale')).toBe(true);

  // A fresh read keeps its source badge and the time it was read.
  badge = await show(QUOTA_SNAPSHOTS[0]);
  expect(badge('w-medium')?.textContent).toBe('官方');
  expect(card('w-large').querySelector('.widget-footnote')?.textContent).toMatch(/^更新于 /);
});
