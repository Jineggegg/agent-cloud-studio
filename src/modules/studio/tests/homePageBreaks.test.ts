import { describe, expect, test } from 'vitest';

import { movePageBreaks, releasePageBreak, tidyPageBreaks } from '@/modules/studio/utils/homeLayout';

const shown = ['a', 'b', 'c', 'd', 'e'];

describe('page breaks', () => {
  test('an icon that leaves the start of its page hands it to the icon after it', () => {
    expect(releasePageBreak(['c'], shown, 'c')).toEqual(['d']);
    // Nothing after it, or it never began a page: nothing to hand on.
    expect(releasePageBreak(['e'], shown, 'e')).toEqual([]);
    expect(releasePageBreak(['c'], shown, 'b')).toEqual(['c']);
    expect(releasePageBreak(undefined, shown, 'b')).toEqual([]);
  });

  test('a drop backwards onto the start of a page begins it; a drop forwards joins that page', () => {
    // a b | c d e: e dropped on c begins the second page.
    expect(movePageBreaks(['c'], shown, 'e', 'c')).toEqual(['e']);
    // a dropped on c lands after it, so c still begins the page.
    expect(movePageBreaks(['c'], shown, 'a', 'c')).toEqual(['c']);
    // c (the page's start) swapped with d: d begins the page now.
    expect(movePageBreaks(['c'], shown, 'c', 'd')).toEqual(['d']);
    expect(movePageBreaks(['c'], shown, 'c', 'c')).toEqual(['c']);
  });

  test('tidying drops breaks on icons that are gone or first, and leaves none as undefined', () => {
    expect(tidyPageBreaks(['c', 'x', 'a', 'c'], shown)).toEqual(['c']);
    expect(tidyPageBreaks(['a'], shown)).toBeUndefined();
  });
});
