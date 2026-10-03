import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const settings = vi.hoisted(() => ({
  apiKeys: vi.fn(),
  credentials: vi.fn(),
  createApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  toggleApiKey: vi.fn(),
  createCredential: vi.fn(),
  deleteCredential: vi.fn(),
  toggleCredential: vi.fn(),
}));
vi.mock('@/shared/api', () => ({ api: { settings } }));

const { default: CredentialsSettingsTab } = await import('@/modules/settings/tabs/api-settings/CredentialsSettingsTab');
await import('@/modules/i18n');

/**
 * API keys work outside the session, so the Settings tab asks for the Studio password before one
 * is created or a disabled one is turned back on (the server checks it). The suite runs in English.
 */

const json = (body: unknown, status = 200) => async () => Response.json(body, { status });
const DISABLED_KEY = { id: '7', key_name: 'script', api_key: 'ck_1234567...', created_at: '2026-09-01T00:00:00Z', last_used: null, is_active: false };

beforeEach(() => {
  vi.clearAllMocks();
  settings.apiKeys.mockImplementation(json({ apiKeys: [DISABLED_KEY] }));
  settings.credentials.mockImplementation(json({ credentials: [] }));
});
afterEach(cleanup);

test('creating an API key sends the password and shows the server\'s refusal', async () => {
  settings.createApiKey
    .mockImplementationOnce(json({ success: false, error: { code: 'AUTH_STEP_UP_FAILED', message: '密码不正确' } }, 403))
    .mockImplementation(json({ success: true, apiKey: { id: 8, keyName: 'laptop', apiKey: 'ck_secret' } }));
  render(<CredentialsSettingsTab />);
  fireEvent.click(await screen.findByRole('button', { name: /New API Key/ }));
  fireEvent.change(screen.getByPlaceholderText('API Key Name (e.g., Production Server)'), { target: { value: 'laptop' } });

  const create = screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;
  // No password, no request.
  expect(create.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Studio login password'), { target: { value: 'guess' } });
  fireEvent.click(create);
  expect((await screen.findByRole('alert')).textContent).toBe('密码不正确');
  expect(settings.createApiKey).toHaveBeenCalledWith('laptop', 'guess');

  fireEvent.change(screen.getByLabelText('Studio login password'), { target: { value: 'right' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(settings.createApiKey).toHaveBeenLastCalledWith('laptop', 'right'));
  expect(await screen.findByText('ck_secret')).toBeTruthy();
});

test('turning a disabled key back on asks for the password; turning one off does not', async () => {
  settings.toggleApiKey.mockImplementation(json({ success: true }));
  render(<CredentialsSettingsTab />);
  fireEvent.click(await screen.findByRole('button', { name: 'Inactive' }));
  // Nothing is sent until the password is given.
  expect(settings.toggleApiKey).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Studio login password'), { target: { value: 'right' } });
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
  await waitFor(() => expect(settings.toggleApiKey).toHaveBeenCalledWith('7', true, 'right'));

  cleanup();
  vi.clearAllMocks();
  settings.apiKeys.mockImplementation(json({ apiKeys: [{ ...DISABLED_KEY, is_active: true }] }));
  settings.credentials.mockImplementation(json({ credentials: [] }));
  settings.toggleApiKey.mockImplementation(json({ success: true }));
  render(<CredentialsSettingsTab />);
  fireEvent.click(await screen.findByRole('button', { name: 'Active' }));
  await waitFor(() => expect(settings.toggleApiKey).toHaveBeenCalledWith('7', false));
});
