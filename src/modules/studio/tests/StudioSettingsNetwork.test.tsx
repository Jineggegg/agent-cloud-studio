import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type * as ApiModule from '@/shared/api';
import type { StudioNetworkInfo } from '@/shared/types';
import type * as UtilsModule from '@/shared/utils';

const mocks = vi.hoisted(() => ({
  network: vi.fn(),
  networkGuide: vi.fn(),
  handoff: vi.fn(),
  buildHandoffUrl: vi.fn(),
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));
vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { studio: { network: mocks.network, networkGuide: mocks.networkGuide, handoff: mocks.handoff } } };
});
// jsdom cannot navigate to another origin, so the target URL becomes a same-document hash.
vi.mock('@/shared/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilsModule>();
  return { ...actual, buildHandoffUrl: mocks.buildHandoffUrl };
});
vi.mock('sonner', () => ({ toast: mocks.toast }));

const { StudioSettingsNetwork } = await import('@/modules/studio/StudioSettingsNetwork');

const PUBLIC_ORIGIN = 'https://studio.ajarche.com';
const TAILNET_ORIGIN = 'https://laptop-acgghbuq.tail6e45f0.ts.net:8443';

function networkInfo(overrides: Partial<StudioNetworkInfo> = {}): StudioNetworkInfo {
  return {
    ingresses: [
      { id: 'public', label: '公网域名', origin: PUBLIC_ORIGIN, configured: true, isDefault: true },
      { id: 'tailnet', label: 'Tailscale · AJ 通道', origin: TAILNET_ORIGIN, configured: true, isDefault: false },
    ],
    current: 'public',
    session: 'password',
    guidance: ['两个入口通向同一个数据库。', '在中国大陆：选 AJ 的出口节点。'],
    ...overrides,
  };
}

// What a door's /health looks like to the page's CORS probe:
// - true / 'ok': Studio answered (its /health carries Access-Control-Allow-Origin: *);
// - 'access': Cloudflare Access redirected to its login, seen as an opaque redirect (redirect: 'manual');
// - 'error-page': a readable non-2xx answer;
// - false / 'down': a network or CORS failure, e.g. Cloudflare's 1033 page, which has no CORS headers.
type ProbeAnswer = boolean | 'ok' | 'access' | 'error-page' | 'down';
function stubProbes(answers: Record<string, ProbeAnswer>) {
  const probe = vi.fn(async (url: string, _init?: RequestInit) => {
    const origin = Object.keys(answers).find(candidate => url === `${candidate}/health`);
    const answer = origin === undefined ? 'down' : answers[origin];
    if (answer === true || answer === 'ok') return Response.json({ status: 'ok', version: '1.37.3' });
    if (answer === 'access') return { type: 'opaqueredirect', ok: false, status: 0 } as Response;
    if (answer === 'error-page') return new Response('<h1>Error 1033</h1>', { status: 530 });
    throw new TypeError('Failed to fetch');
  });
  vi.stubGlobal('fetch', probe);
  return probe;
}

const door = (name: RegExp) => screen.getByRole('radio', { name });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  window.history.replaceState(null, '', '/apps/connections');
  mocks.buildHandoffUrl.mockReturnValue('#handoff-test');
  mocks.handoff.mockResolvedValue(Response.json({ code: 'c'.repeat(43), target: 'tailnet', origin: TAILNET_ORIGIN, expiresAt: '2026-10-02T10:00:00Z' }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('lists both doors with the default tag, the current badge and live reachability', async () => {
  mocks.network.mockResolvedValue(Response.json(networkInfo()));
  stubProbes({ [PUBLIC_ORIGIN]: true, [TAILNET_ORIGIN]: false });
  render(<StudioSettingsNetwork />);

  const publicDoor = await screen.findByRole('radio', { name: /公网域名/ });
  expect(publicDoor.getAttribute('aria-checked')).toBe('true');
  expect(within(publicDoor).getByText('默认')).toBeTruthy();
  expect(within(publicDoor).getByText('当前')).toBeTruthy();
  expect(within(publicDoor).getByText(PUBLIC_ORIGIN)).toBeTruthy();
  await waitFor(() => expect(within(publicDoor).getByText(/^\d+ ms$/)).toBeTruthy());

  const tailnetDoor = door(/Tailscale/);
  expect(tailnetDoor.getAttribute('aria-checked')).toBe('false');
  expect(within(tailnetDoor).queryByText('当前')).toBeNull();
  await waitFor(() => expect(within(tailnetDoor).getByText('不可达')).toBeTruthy());
  // The first guidance line is the section's own explanation; the rest are listed.
  expect(screen.getByText('在中国大陆：选 AJ 的出口节点。')).toBeTruthy();
  // The guide is served by Studio itself, not linked to GitHub.
  expect(screen.queryByRole('link', { name: /设置说明/ })).toBeNull();
  expect(screen.getByRole('button', { name: /设置说明/ })).toBeTruthy();
});

test('the probe is a CORS request that tells Studio apart from Access and Cloudflare error pages', async () => {
  mocks.network.mockResolvedValue(Response.json(networkInfo({ current: 'tailnet' })));
  const probe = stubProbes({ [PUBLIC_ORIGIN]: 'access', [TAILNET_ORIGIN]: 'ok' });
  render(<StudioSettingsNetwork />);

  await waitFor(() => expect(within(door(/公网域名/)).getByText('需 Access 验证')).toBeTruthy());
  await waitFor(() => expect(within(door(/Tailscale/)).getByText(/^\d+ ms$/)).toBeTruthy());
  for (const [, init] of probe.mock.calls) {
    expect(init).toMatchObject({ mode: 'cors', redirect: 'manual', credentials: 'omit' });
  }
  expect(probe.mock.calls.map(([url]) => url).sort()).toEqual([`${TAILNET_ORIGIN}/health`, `${PUBLIC_ORIGIN}/health`]);
});

test('a readable error page or a non-Studio answer counts as unreachable', async () => {
  mocks.network.mockResolvedValue(Response.json(networkInfo()));
  stubProbes({ [PUBLIC_ORIGIN]: true, [TAILNET_ORIGIN]: 'error-page' });
  render(<StudioSettingsNetwork />);
  await waitFor(() => expect(within(door(/Tailscale/)).getByText('不可达')).toBeTruthy());

  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ hello: 'not studio' })));
  fireEvent.click(screen.getByRole('button', { name: /重新检测/ }));
  await waitFor(() => expect(within(door(/公网域名/)).getByText('不可达')).toBeTruthy());
});

test('a door behind Cloudflare Access is switched to without the unreachable warning', async () => {
  mocks.network.mockResolvedValue(Response.json(networkInfo({ current: 'tailnet' })));
  mocks.handoff.mockResolvedValue(Response.json({ code: 'a'.repeat(43), target: 'public', origin: PUBLIC_ORIGIN, expiresAt: '2026-10-02T10:00:00Z' }));
  stubProbes({ [PUBLIC_ORIGIN]: 'access', [TAILNET_ORIGIN]: true });
  render(<StudioSettingsNetwork />);
  await waitFor(() => expect(within(door(/公网域名/)).getByText('需 Access 验证')).toBeTruthy());

  fireEvent.click(door(/公网域名/));
  await waitFor(() => expect(mocks.handoff).toHaveBeenCalledWith('public', undefined));
  expect(mocks.toast).not.toHaveBeenCalled();
});

test('the guide opens inside Studio from the server copy of docs/network.md', async () => {
  mocks.network.mockResolvedValue(Response.json(networkInfo()));
  mocks.networkGuide.mockResolvedValue(Response.json({
    markdown: '# 连接方式：一个后端，两个入口\n\n见 [WSL 部署](deployment-wsl.md) 和 [Tailscale Serve](https://tailscale.com/kb/1312/serve)。\n\n| 变量 | 作用 |\n| --- | --- |\n| `STUDIO_PUBLIC_ORIGIN` | 公网入口 |\n',
  }));
  stubProbes({ [PUBLIC_ORIGIN]: true, [TAILNET_ORIGIN]: true });
  render(<StudioSettingsNetwork />);

  fireEvent.click(await screen.findByRole('button', { name: /设置说明/ }));
  const dialog = await screen.findByRole('dialog', { name: '连接方式说明' });
  expect(await within(dialog).findByRole('heading', { name: '连接方式：一个后端，两个入口' })).toBeTruthy();
  expect(mocks.networkGuide).toHaveBeenCalledTimes(1);
  // Relative repository links become text; absolute links open in a new tab.
  expect(within(dialog).queryByRole('link', { name: 'WSL 部署' })).toBeNull();
  expect(within(dialog).getByText('WSL 部署')).toBeTruthy();
  const external = within(dialog).getByRole('link', { name: 'Tailscale Serve' });
  expect(external.getAttribute('target')).toBe('_blank');
  expect(external.getAttribute('rel')).toBe('noreferrer');
  expect(within(dialog).getByRole('table')).toBeTruthy();

  fireEvent.click(within(dialog).getByRole('button', { name: '完成' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('a guide that cannot be read says why', async () => {
  mocks.network.mockResolvedValue(Response.json(networkInfo()));
  mocks.networkGuide.mockResolvedValue(Response.json(
    { success: false, error: { code: 'NETWORK_GUIDE_MISSING', message: '这台服务器上没有找到连接方式说明（docs/network.md）' } },
    { status: 404 },
  ));
  stubProbes({ [PUBLIC_ORIGIN]: true, [TAILNET_ORIGIN]: true });
  render(<StudioSettingsNetwork />);

  fireEvent.click(await screen.findByRole('button', { name: /设置说明/ }));
  expect((await screen.findByRole('alert')).textContent).toContain('没有找到连接方式说明');
});

test('choosing the other door hands the session off and navigates there', async () => {
  mocks.network.mockResolvedValue(Response.json(networkInfo()));
  stubProbes({ [PUBLIC_ORIGIN]: true, [TAILNET_ORIGIN]: true });
  render(<StudioSettingsNetwork />);
  await waitFor(() => expect(within(door(/Tailscale/)).getByText(/^\d+ ms$/)).toBeTruthy());

  fireEvent.click(door(/Tailscale/));

  await waitFor(() => expect(window.location.hash).toBe('#handoff-test'));
  expect(mocks.handoff).toHaveBeenCalledWith('tailnet', undefined);
  expect(mocks.buildHandoffUrl).toHaveBeenCalledWith(TAILNET_ORIGIN, 'c'.repeat(43));
  expect(localStorage.getItem('studio-ingress-v1')).toBe('tailnet');
  // The door already serving this page is not a switch.
  fireEvent.click(door(/公网域名/));
  expect(mocks.handoff).toHaveBeenCalledTimes(1);
});

test('an unreachable door asks first and only switches from the toast action', async () => {
  mocks.network.mockResolvedValue(Response.json(networkInfo()));
  stubProbes({ [PUBLIC_ORIGIN]: true, [TAILNET_ORIGIN]: false });
  render(<StudioSettingsNetwork />);
  await waitFor(() => expect(within(door(/Tailscale/)).getByText('不可达')).toBeTruthy());

  fireEvent.click(door(/Tailscale/));
  expect(mocks.handoff).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledTimes(1);
  const options = mocks.toast.mock.calls[0][1] as { action: { label: string; onClick: () => void } };
  expect(options.action.label).toBe('仍然前往');

  options.action.onClick();
  await waitFor(() => expect(mocks.handoff).toHaveBeenCalledWith('tailnet', undefined));
});

test('a Tailscale session asks for the password before moving to the public door', async () => {
  mocks.network.mockResolvedValue(Response.json(networkInfo({ current: 'tailnet', session: 'tailscale' })));
  mocks.handoff.mockResolvedValue(Response.json({ code: 'p'.repeat(43), target: 'public', origin: PUBLIC_ORIGIN, expiresAt: '2026-10-02T10:00:00Z' }));
  stubProbes({ [PUBLIC_ORIGIN]: true, [TAILNET_ORIGIN]: true });
  render(<StudioSettingsNetwork />);

  fireEvent.click(await screen.findByRole('radio', { name: /公网域名/ }));
  expect(mocks.handoff).not.toHaveBeenCalled();
  const field = screen.getByLabelText('密码');
  fireEvent.change(field, { target: { value: 'hunter22' } });
  fireEvent.click(screen.getByRole('button', { name: '切换' }));

  await waitFor(() => expect(mocks.handoff).toHaveBeenCalledWith('public', 'hunter22'));
  await waitFor(() => expect(mocks.buildHandoffUrl).toHaveBeenCalledWith(PUBLIC_ORIGIN, 'p'.repeat(43)));
});

test('the server can still require the password, and a wrong one is reported', async () => {
  mocks.network.mockResolvedValue(Response.json(networkInfo({ current: 'tailnet' })));
  mocks.handoff
    .mockResolvedValueOnce(Response.json({ success: false, error: { code: 'AUTH_HANDOFF_PASSWORD_REQUIRED', message: 'password' } }, { status: 403 }))
    .mockResolvedValueOnce(Response.json({ success: false, error: { code: 'AUTH_INVALID_CREDENTIALS', message: '密码不正确' } }, { status: 401 }));
  stubProbes({ [PUBLIC_ORIGIN]: true, [TAILNET_ORIGIN]: true });
  render(<StudioSettingsNetwork />);
  await waitFor(() => expect(within(door(/公网域名/)).getByText(/^\d+ ms$/)).toBeTruthy());

  fireEvent.click(door(/公网域名/));
  fireEvent.change(await screen.findByLabelText('密码'), { target: { value: 'wrong-one' } });
  fireEvent.click(screen.getByRole('button', { name: '切换' }));

  await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('密码不正确'));
  expect(mocks.buildHandoffUrl).not.toHaveBeenCalled();
});

test('an unconfigured door cannot be chosen, and a failed load offers a retry', async () => {
  mocks.network.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  stubProbes({ [PUBLIC_ORIGIN]: true });
  render(<StudioSettingsNetwork />);

  mocks.network.mockResolvedValue(Response.json(networkInfo({
    current: 'local',
    ingresses: [
      { id: 'public', label: '公网域名', origin: PUBLIC_ORIGIN, configured: true, isDefault: true },
      { id: 'tailnet', label: 'Tailscale · AJ 通道', origin: null, configured: false, isDefault: false },
    ],
  })));
  fireEvent.click(await screen.findByRole('button', { name: /读取失败/ }));

  const tailnetDoor = await screen.findByRole('radio', { name: /Tailscale/ });
  expect((tailnetDoor as HTMLButtonElement).disabled).toBe(true);
  expect(within(tailnetDoor).getByText('未配置')).toBeTruthy();
  expect(screen.getByText('当前 · 本机地址')).toBeTruthy();
});

test('a remembered door that differs from this one is offered as a shortcut', async () => {
  localStorage.setItem('studio-ingress-v1', 'tailnet');
  mocks.network.mockResolvedValue(Response.json(networkInfo()));
  stubProbes({ [PUBLIC_ORIGIN]: true, [TAILNET_ORIGIN]: true });
  render(<StudioSettingsNetwork />);

  const shortcut = await screen.findByRole('button', { name: /此设备上次选择了「Tailscale · AJ 通道」/ });
  await waitFor(() => expect(within(door(/Tailscale/)).getByText(/^\d+ ms$/)).toBeTruthy());
  fireEvent.click(shortcut);
  await waitFor(() => expect(mocks.handoff).toHaveBeenCalledWith('tailnet', undefined));
});
