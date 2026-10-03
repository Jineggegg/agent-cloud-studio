import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const providers = vi.hoisted(() => ({ models: vi.fn(), createModel: vi.fn(), updateModel: vi.fn(), deleteModel: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { providers, user: { preferences: vi.fn(), savePreferences: vi.fn(async () => Response.json({})) } } }));

const { StudioSettingsModels } = await import('@/modules/studio/StudioSettingsModels');
const { readModelDefaults, writeProviderModelPreferences } = await import('@/shared/modelDefaults');
const { resetUserPreferences } = await import('@/shared/userSettings');

type Option = {
  value: string; label: string; description?: string; aliases?: string[]; longContextValue?: string; recommended?: boolean;
  effort?: { default: string; values: { value: string }[] }; isCustom?: boolean; recordId?: number;
};
const EFFORT = { default: 'high', values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }] };
const BUILT_IN: Option[] = [
  { value: 'default', label: 'Default (recommended)', effort: EFFORT },
  { value: 'claude-opus-5-5', label: 'Opus 5.5', effort: EFFORT },
  { value: 'haiku', label: 'Haiku' },
];
let claudeOptions: Option[] = BUILT_IN;
const envelope = (models: unknown) => Response.json({ success: true, data: { models } });
// 模型 (the defaults) and, one level in, 模型列表 (the list); both together where a test spans the two.
const renderDefaults = (onOpenCatalog = vi.fn()) => render(<MemoryRouter><StudioSettingsModels onOpenCatalog={onOpenCatalog} /></MemoryRouter>);
const renderCatalog = () => render(<MemoryRouter><StudioSettingsModels view="catalog" /></MemoryRouter>);
const renderBoth = () => render(<MemoryRouter><StudioSettingsModels /><StudioSettingsModels view="catalog" /></MemoryRouter>);

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
  renderDefaults();
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
  renderBoth();
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
  renderCatalog();
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
  renderDefaults();
  await screen.findByLabelText('默认模型');
  fireEvent.click(screen.getByRole('radio', { name: 'Codex' }));
  expect(await screen.findByRole('option', { name: 'GPT-6 Sol' })).toBeTruthy();
  expect(providers.models).toHaveBeenLastCalledWith('codex');
});

test('the Claude list shows one row per family with its description, and a legacy default keeps its 1M switch', async () => {
  claudeOptions = [
    { value: 'claude-fable-5-1', label: 'Fable 5.1', description: '最强的 Claude', aliases: ['fable', 'best'], longContextValue: 'claude-fable-5-1[1m]', effort: EFFORT },
    { value: 'claude-opus-5-5', label: 'Opus 5.5', description: '复杂推理和编码的首选', recommended: true, aliases: ['opus', 'default'], longContextValue: 'claude-opus-5-5[1m]', effort: EFFORT },
    { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', description: '最快、最省', aliases: ['haiku'] },
  ] as Option[];
  writeProviderModelPreferences('claude', { model: 'opus[1m]', effort: 'max' });
  renderBoth();

  const model = await screen.findByLabelText('默认模型') as HTMLSelectElement;
  expect(model.value).toBe('claude-opus-5-5');
  expect((screen.getByLabelText('推理强度') as HTMLSelectElement).value).toBe('max');
  const longContext = screen.getByRole('switch', { name: '1M 上下文' }) as HTMLInputElement;
  expect(longContext.checked).toBe(true);
  const list = screen.getByRole('list', { name: 'Claude Code 模型' });
  expect(within(list).getByText('复杂推理和编码的首选')).toBeTruthy();
  expect(within(list).queryByText('claude-opus-5-5')).toBeNull();

  fireEvent.click(longContext);
  expect(readModelDefaults().claude).toEqual({ model: 'claude-opus-5-5', effort: 'max' });
  fireEvent.click(screen.getByRole('switch', { name: '1M 上下文' }));
  expect(readModelDefaults().claude?.model).toBe('claude-opus-5-5[1m]');
  // Switching family keeps the 1M window where the new default has one; Haiku has none, so no switch.
  fireEvent.change(model, { target: { value: 'claude-fable-5-1' } });
  expect(readModelDefaults().claude?.model).toBe('claude-fable-5-1[1m]');
  fireEvent.change(model, { target: { value: 'claude-haiku-4-5-20251001' } });
  expect(readModelDefaults().claude?.model).toBe('claude-haiku-4-5-20251001');
  expect(screen.queryByRole('switch', { name: '1M 上下文' })).toBeNull();
});

test('模型 keeps the list one level in, with how many models are available', async () => {
  const openCatalog = vi.fn();
  renderDefaults(openCatalog);
  const row = await screen.findByRole('button', { name: /管理模型列表/ });
  expect(row.textContent).toContain('3 个可用');
  expect(screen.queryByRole('button', { name: /^隐藏 / })).toBeNull();
  fireEvent.click(row);
  expect(openCatalog).toHaveBeenCalledTimes(1);
  // The workbench shortcuts for new Claude and Codex sessions sit on the same page.
  expect(screen.getByRole('link', { name: /Claude Code/ }).getAttribute('href')).toBe('/work?new=claude');
});
