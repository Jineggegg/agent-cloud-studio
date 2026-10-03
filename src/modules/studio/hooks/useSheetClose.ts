import { useCallback, useEffect, useRef, useState } from 'react';

import { STUDIO_MOTION_OUT_MS } from '@/shared/constants';

const prefersReducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * Used by the home screen's sheets (App 资源库, the widget gallery, AJ 出口): closing plays the sheet's way out
 * (`.studio-layer.closing` in studio.css, STUDIO_MOTION_OUT_MS) before `onClose` unmounts it, instead of it vanishing
 * at once. Under reduced motion it closes straight away. A second close while one is under way does nothing.
 */
export function useSheetClose(onClose: () => void) {
  // True while the sheet plays its way out; it takes no input meanwhile.
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const latestOnClose = useRef<() => void>(() => {});
  useEffect(() => { latestOnClose.current = onClose; });
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const close = useCallback(() => {
    if (closingRef.current) return;
    if (prefersReducedMotion()) { latestOnClose.current(); return; }
    closingRef.current = true;
    setClosing(true);
    timer.current = window.setTimeout(() => {
      closingRef.current = false;
      setClosing(false);
      latestOnClose.current();
    }, STUDIO_MOTION_OUT_MS);
  }, []);
  return { closing, close };
}
