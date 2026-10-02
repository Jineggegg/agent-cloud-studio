import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const providers = vi.hoisted(() => ({ models: vi.fn(), createModel: vi.fn(), updateModel: vi.fn(), deleteModel: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { providers, user: { preferences: vi.fn(), savePreferences: vi.fn(async () => Response.json({})) } } }));

const { StudioSettingsModels } = await import('@/modules/studio/StudioSettingsModels');
const { readModelDefaults } = await import('@/shared/modelDefaults');
const { resetUserPreferences } = await import('@/shared/userSettings');

type Option = { value: string; label: string; effort?: { default: string; values: { value: string }[] }; isCustom?: boolean; recordId?: number };
const EFFORT = { default: 'high', values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }] };
const BUILT_IN: Option[] = [
  { value: 'default', label: 'Default (recommended)', effort: EFFORT },
  { value: 'claude-opus-5-5', label: 'Opus 5.5', effort: EFFORT },
  { value: 'haiku', label: 'Haiku' },
];
let claudeOptions: Option[] = BUILT_IN;
const envelope = (models: unknown) => Response.json({ success: true, data: { models } });

beforeEach(() => {
  resetUserPreferences();
  localStorage.clear();
  claudeOptions = BUILT_IN;
  providers.models.mockImplementation(async (provider: string) => envelope(provider === 'claude'
    ? { DEFAULT: 'default', OPTIONS: claudeOptions }
    : { DEFAULT: 'gpt-6-sol', OPTIONS: [{ value: 'gpt-6-sol', label: 'GPT-6 Sol' }] }));
});
afterEach(cleanup);

test('the default model and effort are saved for new sessions and seed this device\'s composer', async () => {
  render(<StudioSettingsModels />);
  const model = await screen.findByLabelText('默认模型');
  fireEvent.change(model, { target: { value: 'claude-opus-5-5' } });
  fireEvent.change(screen.getByLabelText('推理强度'), { target: { value: 'max' } });
  expect(readModelDefaults().claude).toEqual({ model: 'claude-opus-5-5', effort: 'max' });
  expect(localStorage.getItem('claude-model')).toBe('claude-opus-5-5');
  expect(localStorage.getItem('claude-effort')).toBe('max');
  // A model without effort levels clears the effort and disables the picker.
  fireEvent.change(model, { target: { value: 'haiku' } });
  expect(readModelDefaults().claude).toEqual({ model: 'haiku' });
  expect((screen.getByLabelText('推理强度') as HTMLSelectElement).disabled).toBe(true);
});

test('built-in models are hidden from the menus and can be restored', async () => {
  render(<StudioSettingsModels />);
  fireEvent.click(await screen.findByRole('button', { name: '隐藏 Opus 5.5' }));
  expect(readModelDefaults().claude?.hidden).toEqual(['claude-opus-5-5']);
  expect(within(screen.getByLabelText('默认模型')).queryByText('Opus 5.5')).toBeNull();
  const hiddenList = screen.getByRole('list', { name: '已隐藏的模型' });
  fireEvent.click(within(hiddenList).getByRole('button', { name: '恢复 Opus 5.5' }));
  expect(readModelDefaults().claude?.hidden).toEqual([]);
  expect(screen.queryByRole('list', { name: '已隐藏的模型' })).toBeNull();
});

test('custom models are added and deleted through the model API', async () => {
  providers.createModel.mockImplementation(async (_provider: string, input: { id: string; model: string }) => {
    claudeOptions = [...claudeOptions, { value: input.id, label: input.model, isCustom: true, recordId: 7 }];
    return Response.json({ success: true });
  });
  providers.deleteModel.mockImplementation(async () => {
    claudeOptions = claudeOptions.filter(option => !option.isCustom);
    return Response.json({ success: true });
  });
  render(<StudioSettingsModels />);
  fireEvent.click(await screen.findByRole('button', { name: '添加模型' }));
  fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'claude-test-1' } });
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '测试模型' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await screen.findByRole('button', { name: '删除 测试模型' });
  expect(providers.createModel).toHaveBeenCalledWith('claude', { id: 'claude-test-1', model: '测试模型' });
  fireEvent.click(screen.getByRole('button', { name: '删除 测试模型' }));
  fireEvent.click(await screen.findByRole('button', { name: '删除' }));
  await waitFor(() => expect(providers.deleteModel).toHaveBeenCalledWith('claude', 7));
  await waitFor(() => expect(screen.queryByText('测试模型')).toBeNull());
});

test('each CLI has its own list', async () => {
  render(<StudioSettingsModels />);
  await screen.findByLabelText('默认模型');
  fireEvent.click(screen.getByRole('radio', { name: 'Codex' }));
  expect(await screen.findByRole('option', { name: 'GPT-6 Sol' })).toBeTruthy();
  expect(providers.models).toHaveBeenLastCalledWith('codex');
});
