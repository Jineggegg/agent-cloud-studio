import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ status: vi.fn(), overview: vi.fn(), history: vi.fn(), activity: vi.fn() }));
vi.mock('@/shared/api', () => ({
  api: { studio: { trading212: mocks } },
  readApiJson: async (response: Response) => {
    const value = await response.json();
    if (!response.ok) throw Error(value.error);
    return value;
  },
}));

const { StudioTrading212 } = await import('@/modules/studio/StudioTrading212');

const OVERVIEW = {
  env: 'live', currency: 'GBP', totalValue: 1234.5, fetchedAt: '2026-10-02T09:00:00Z',
  cash: { available: 100, reserved: 0, inPies: 0 },
  investments: { value: 1134.5, cost: 1000, unrealized: 134.5, realized: -20 },
  changes: { today: { amount: -12.3, percent: -0.99, since: '2026-10-01T17:00:00Z', flowAdjusted: true }, yesterday: null },
  recordedSince: '2026-09-30T09:00:00Z',
  positions: [
    { ticker: 'AAPL_US_EQ', name: 'Apple', currency: 'USD', quantity: 2, averagePrice: 150, currentPrice: 200, value: 800, cost: 700, pnl: 100, fx: null, openedAt: '' },
    { ticker: 'MSFT_US_EQ', name: 'Microsoft', currency: 'USD', quantity: 1, averagePrice: 350, currentPrice: 330, value: 334.5, cost: 300, pnl: -5, fx: null, openedAt: '' },
  ],
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

test('without a key file the view explains setup and never calls the broker', async () => {
  mocks.status.mockResolvedValue(Response.json([{ env: 'live', configured: false, source: null }, { env: 'demo', configured: false, source: null }]));
  render(<StudioTrading212 />);
  expect(await screen.findByText('尚未接入 Trading 212')).toBeTruthy();
  expect(mocks.overview).not.toHaveBeenCalled();
});

test('shows balance, signed day change, curve and positions, with no order controls', async () => {
  mocks.status.mockResolvedValue(Response.json([{ env: 'live', configured: true, source: 'trading212-connector' }, { env: 'demo', configured: false, source: null }]));
  mocks.overview.mockResolvedValue(Response.json(OVERVIEW));
  mocks.history.mockResolvedValue(Response.json([{ at: '2026-09-30T09:00:00Z', value: 1200, unrealized: 100 }, { at: '2026-10-02T09:00:00Z', value: 1234.5, unrealized: 134.5 }]));
  mocks.activity.mockResolvedValue(Response.json([]));
  render(<StudioTrading212 />);
  const hero = await screen.findByRole('region', { name: '总资产' });
  expect(within(hero).getByText('£1,234.50')).toBeTruthy();
  expect(within(hero).getByText(/−£12\.30/)).toBeTruthy();
  expect(screen.getByRole('img', { name: /总资产曲线/ })).toBeTruthy();
  expect(screen.getByText('Apple')).toBeTruthy();
  expect(screen.getByText('记录不足', { exact: false })).toBeTruthy();
  expect(mocks.overview).toHaveBeenCalledWith('live');
  expect(screen.queryByRole('button', { name: /买入|卖出|下单/ })).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: '1周' }));
  expect(await screen.findByText('Apple')).toBeTruthy();
});
