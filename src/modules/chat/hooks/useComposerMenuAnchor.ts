import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { AnchoredMenuPlacement } from '@/shared/types';
import { placeAnchoredMenu, readMenuBounds, sameMenuPlacement } from '@/shared/utils';

/**
 * Positions a composer popover against its trigger: above it and right-aligned by default (the composer sits at the
 * bottom), flipping below when there is no room above, always inside the visible viewport. Once the menu has
 * rendered its natural height decides the flip, so it never opens on a side where it would have to scroll needlessly.
 * Used by chat's ComposerModelMenu, ComposerPermissionMenu and ScheduleMessagePopover.
 */
export function useComposerMenuAnchor(
  isOpen: boolean,
  onClose: () => void,
  preferredWidth = 320,
) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Where the open menu sits; null while closed or before the trigger has been measured.
  const [anchor, setAnchor] = useState<AnchoredMenuPlacement | null>(null);

  const updateAnchor = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    const next = placeAnchoredMenu(rect, {
      bounds: readMenuBounds(),
      viewportHeight: window.innerHeight,
      width: preferredWidth,
      preferredSide: 'above',
      align: 'end',
      contentHeight: menuRef.current?.scrollHeight,
    });
    setAnchor((current) => (sameMenuPlacement(current, next) ? current : next));
  }, [preferredWidth]);

  // Re-placed once the panel exists, with its real height; `sameMenuPlacement` stops this at one extra pass.
  useLayoutEffect(() => {
    if (isOpen && anchor) {
      updateAnchor();
    }
  }, [anchor, isOpen, updateAnchor]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        onClose();
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
      triggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', updateAnchor);
    window.addEventListener('scroll', updateAnchor, true);
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    updateAnchor();

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', updateAnchor);
      window.removeEventListener('scroll', updateAnchor, true);
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [isOpen, onClose, updateAnchor]);

  return { triggerRef, menuRef, anchor, updateAnchor };
}
