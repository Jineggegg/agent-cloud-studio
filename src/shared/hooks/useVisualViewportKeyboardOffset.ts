import { useEffect } from 'react';

// Pinch zoom also shrinks the visual viewport; only an unzoomed one measures the keyboard.
const ZOOM_TOLERANCE = 0.01;

/**
 * Used by the project-workspace and workbench modules to keep their fixed full-screen shells above the soft
 * keyboard in iOS Safari, which ignores `interactive-widget=resizes-content` and does not shrink `dvh` for it.
 * Publishes on <html>:
 * - `--keyboard-height`: the part of the layout viewport the keyboard covers below the visible area;
 * - `--viewport-offset-top`: how far Safari panned the page up to reveal the focused field.
 * A shell placed at `top: var(--viewport-offset-top)` and `bottom: var(--keyboard-height)` fills exactly what the
 * owner can see. Both are 0 without a soft keyboard (or where the browser resizes the layout viewport itself).
 */
export function useVisualViewportKeyboardOffset() {
  useEffect(() => {
    const visualViewport = window.visualViewport;
    if (!visualViewport) {
      return undefined;
    }
    const root = document.documentElement;

    const update = () => {
      const zoomed = Math.abs(visualViewport.scale - 1) > ZOOM_TOLERANCE;
      const offsetTop = zoomed ? 0 : Math.max(0, visualViewport.offsetTop);
      const keyboardHeight = zoomed ? 0 : Math.max(0, Math.round(window.innerHeight - visualViewport.height - offsetTop));
      root.style.setProperty('--keyboard-height', `${keyboardHeight}px`);
      root.style.setProperty('--viewport-offset-top', `${Math.round(offsetTop)}px`);
      // Safari can leave the page panned after the keyboard closes; nothing in a full-screen shell scrolls the page.
      if (keyboardHeight === 0 && offsetTop === 0 && window.scrollY !== 0) window.scrollTo(0, 0);
    };

    update();
    visualViewport.addEventListener('resize', update);
    visualViewport.addEventListener('scroll', update);
    return () => {
      visualViewport.removeEventListener('resize', update);
      visualViewport.removeEventListener('scroll', update);
      root.style.removeProperty('--keyboard-height');
      root.style.removeProperty('--viewport-offset-top');
    };
  }, []);
}
