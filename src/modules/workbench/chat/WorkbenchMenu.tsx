import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Check } from 'lucide-react';

import type { WorkbenchMenuItem, WorkbenchMenuSection } from '@/shared/types';
import { useAnchoredPopover } from '@/modules/workbench/chat/hooks/useAnchoredPopover';
import { WorkbenchFloatingPanel } from '@/modules/workbench/chat/WorkbenchFloatingPanel';

type WorkbenchMenuProps = {
  // Accessible name of the trigger button.
  label: string;
  triggerClassName: string;
  trigger: ReactNode;
  sections: WorkbenchMenuSection[];
  // Which side of the trigger the panel prefers: above a composer chip, below the header pill. It flips when the
  // preferred side has no room for it.
  placement?: 'up' | 'down';
  align?: 'start' | 'end';
  disabled?: boolean;
  // Panel width on a tablet or desktop; a phone gets a full-width sheet instead.
  width?: number;
  // Controlled open state, for a menu another control opens (the effort popover's model row opens the model menu).
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * Used by the workbench chat column's header pill and composer chips: a glass pull-down menu of radio rows (and
 * switch rows) in sections. It opens anchored to its trigger like an iPadOS menu, growing from the button and
 * flipping above or below to stay on screen, and as a bottom sheet on a phone (useAnchoredPopover,
 * WorkbenchFloatingPanel). Closes on selection (switches stay open), outside press and Escape; arrow keys move
 * between rows.
 */
export function WorkbenchMenu({
  label,
  triggerClassName,
  trigger,
  sections,
  placement = 'down',
  align = 'start',
  disabled,
  width = 300,
  open: controlledOpen,
  onOpenChange,
}: WorkbenchMenuProps) {
  // Whether the menu is showing when no parent controls it.
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  };
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const layout = useAnchoredPopover({
    open,
    triggerRef,
    panelRef: menuRef,
    preferredSide: placement === 'up' ? 'above' : 'below',
    align,
    width,
    onDismiss: () => setOpen(false),
  });

  const panelShown = layout !== null;
  useEffect(() => {
    if (!panelShown) return undefined;
    // Focus the checked row (or the first) once the panel exists, so keyboard users land inside it. Without scrolling:
    // iOS would otherwise pan the page to the focused row while the menu is still growing in.
    const frame = requestAnimationFrame(() => {
      const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)');
      const checked = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]:not(:disabled)');
      (checked ?? items?.[0])?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [panelShown]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? []);
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const selectItem = (item: WorkbenchMenuItem) => {
    item.onSelect();
    // A switch is a setting inside the menu, not a choice that ends it.
    if (item.kind !== 'toggle') close(true);
  };

  const visibleSections = sections.filter((section) => section.items.length > 0 || section.note);

  return (
    <div className="wbc-menu-anchor">
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={panelShown ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {trigger}
      </button>
      <WorkbenchFloatingPanel layout={layout} panelRef={menuRef} id={menuId} role="menu" label={label} className="wbc-menu" onKeyDown={onMenuKeyDown}>
        {visibleSections.map((section) => (
          <div className="wbc-menu-section" role="group" aria-label={section.title} key={section.key}>
            {section.title && <div className={`wbc-menu-title${section.icon ? ' has-icon' : ''}`}>{section.icon}{section.title}</div>}
            {section.items.map((item) => {
              const rowId = `${menuId}-${section.key}-${item.key}`;
              const isToggle = item.kind === 'toggle';
              return (
                <button
                  key={item.key}
                  type="button"
                  role={isToggle ? 'menuitemcheckbox' : 'menuitemradio'}
                  aria-checked={Boolean(item.checked)}
                  aria-labelledby={`${rowId}-label`}
                  aria-describedby={item.hint ? `${rowId}-hint` : undefined}
                  disabled={item.disabled}
                  className={`wbc-menu-item${item.tone === 'danger' ? ' is-danger' : ''}${isToggle ? ' is-toggle' : ''}`}
                  onClick={() => selectItem(item)}
                >
                  {!isToggle && (
                    <span className="wbc-menu-check" aria-hidden="true">{item.checked && <Check size={15} strokeWidth={2.6} />}</span>
                  )}
                  {item.icon && <span className="wbc-menu-icon" aria-hidden="true">{item.icon}</span>}
                  <span className="wbc-menu-text">
                    <span className="wbc-menu-label">
                      <span id={`${rowId}-label`}>{item.label}</span>
                      {item.badge && <span className="wbc-menu-badge">{item.badge}</span>}
                    </span>
                    {item.hint && <span className="wbc-menu-hint" id={`${rowId}-hint`}>{item.hint}</span>}
                  </span>
                  {isToggle && <span className={`wbc-menu-switch${item.checked ? ' is-on' : ''}`} aria-hidden="true" />}
                </button>
              );
            })}
            {section.note && <p className="wbc-menu-note">{section.note}</p>}
          </div>
        ))}
      </WorkbenchFloatingPanel>
    </div>
  );
}
