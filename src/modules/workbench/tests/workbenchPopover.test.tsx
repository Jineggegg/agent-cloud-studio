import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { LazyMotion, domMax } from 'motion/react';
import { afterEach, expect, test, vi } from 'vitest';

import { WorkbenchPopover } from '@/modules/workbench/WorkbenchPopover';

function renderPopover() {
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  render(<LazyMotion features={domMax} strict>
    <WorkbenchPopover open anchor={anchor} onClose={() => undefined} label="切换项目">
      <input aria-label="搜索项目" data-autofocus />
      <button type="button" role="menuitem">超级教授</button>
    </WorkbenchPopover>
  </LazyMotion>);
}

const pointer = (fine: boolean) => vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
  matches: query.includes('any-pointer: fine') ? fine : false,
  media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined,
  addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
}) as MediaQueryList);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

test('with a mouse or trackpad the search field takes focus, ready to type', async () => {
  pointer(true);
  renderPopover();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '搜索项目' })));
});

test('on a touch-only device the first item takes focus, so the soft keyboard does not cover the list', async () => {
  pointer(false);
  renderPopover();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '超级教授' })));
});
