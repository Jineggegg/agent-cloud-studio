import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { Check } from 'lucide-react';

type WorkbenchMenuItem = {
  key: string;
  label: string;
  hint?: string;
  // Drawn between the check and the label, e.g. a provider's mark.
  icon?: ReactNode;
  checked?: boolean;
  disabled?: boolean;
  tone?: 'danger';
  onSelect: () => void;
};

type WorkbenchMenuSection = {
  key: string;
  title?: string;
  // Shown under the section, e.g. why its items are locked.
  note?: string;
  items: WorkbenchMenuItem[];
};

type WorkbenchMenuProps = {
  // Accessible name of the trigger button.
  label: string;
  triggerClassName: string;
  trigger: ReactNode;
  sections: WorkbenchMenuSection[];
  // Opens above the trigger (composer) or below it (header).
  placement?: 'up' | 'down';
  align?: 'start' | 'end';
  disabled?: boolean;
};

const MENU_SPRING = { type: 'spring', stiffness: 520, damping: 34, mass: 0.7 } as const;

/**
 * Used by the workbench chat column's header pill and composer chips: a glass popover menu of radio items in
 * sections. Closes on selection, outside press and Escape; arrow keys move between items.
 */
export function WorkbenchMenu({
  label,
  triggerClassName,
  trigger,
  sections,
  placement = 'down',
  align = 'start',
  disabled,
}: WorkbenchMenuProps) {
  // Whether the popover is showing; owned here because nothing outside needs to open it.
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    // Focus the checked item (or the first) once the panel exists, so keyboard users land inside it.
    const frame = requestAnimationFrame(() => {
      const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)');
      const checked = menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)');
      (checked ?? items?.[0])?.focus();
    });
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      cancelAnimationFrame(frame);
    };
  }, [open]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
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

  const visibleSections = sections.filter((section) => section.items.length > 0 || section.note);

  return (
    <div className="wbc-menu-anchor" ref={anchorRef}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger}
      </button>
      <AnimatePresence>
        {open && (
          <m.div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={label}
            className={`wbc-menu is-${placement} align-${align}`}
            initial={{ opacity: 0, scale: 0.94, y: placement === 'up' ? 8 : -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.12 } }}
            transition={MENU_SPRING}
            onKeyDown={onMenuKeyDown}
          >
            {visibleSections.map((section) => (
              <div className="wbc-menu-section" role="group" aria-label={section.title} key={section.key}>
                {section.title && <div className="wbc-menu-title">{section.title}</div>}
                {section.items.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    role="menuitemradio"
                    aria-checked={Boolean(item.checked)}
                    disabled={item.disabled}
                    className={`wbc-menu-item${item.tone === 'danger' ? ' is-danger' : ''}`}
                    onClick={() => {
                      item.onSelect();
                      close(true);
                    }}
                  >
                    <span className="wbc-menu-check" aria-hidden="true">{item.checked && <Check size={15} strokeWidth={2.6} />}</span>
                    {item.icon && <span className="wbc-menu-icon" aria-hidden="true">{item.icon}</span>}
                    <span className="wbc-menu-text">
                      <span className="wbc-menu-label">{item.label}</span>
                      {item.hint && <span className="wbc-menu-hint">{item.hint}</span>}
                    </span>
                  </button>
                ))}
                {section.note && <p className="wbc-menu-note">{section.note}</p>}
              </div>
            ))}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
