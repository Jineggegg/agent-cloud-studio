import type { ReactNode, Ref } from 'react';
import { Check } from 'lucide-react';

import { cn } from '@/shared/utils';
import type { AnchoredMenuPlacement } from '@/shared/types';

/**
 * Shared shell for the composer popovers (model/effort and permissions) so both
 * menus share one surface, one heading style and one row style.
 *
 * Used by chat's ComposerModelMenu and ComposerPermissionMenu.
 */
export function ComposerMenuSurface({
  anchor,
  menuRef,
  ariaLabel,
  children,
}: {
  anchor: AnchoredMenuPlacement;
  menuRef: Ref<HTMLDivElement>;
  ariaLabel: string;
  children: ReactNode;
}) {
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      data-side={anchor.side}
      className="fixed z-[100] overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl"
      style={{
        top: anchor.top,
        bottom: anchor.bottom,
        left: anchor.left,
        width: anchor.width,
        maxHeight: anchor.maxHeight,
        transformOrigin: anchor.transformOrigin,
      }}
    >
      {children}
    </div>
  );
}

/** Used by chat's ComposerModelMenu and ComposerPermissionMenu to label a section of the popover. */
export function ComposerMenuHeading({ children }: { children: ReactNode }) {
  return (
    <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">{children}</p>
  );
}

/** Used by chat's ComposerModelMenu to divide its model and effort sections. */
export function ComposerMenuSeparator() {
  return <div className="my-1 h-px bg-border" aria-hidden />;
}

/** Used by chat's ComposerModelMenu to tag the recommended model (推荐) after its label. */
export function ComposerMenuBadge({ children }: { children: ReactNode }) {
  return (
    <span className="ml-1.5 inline-flex items-center rounded-full bg-primary/10 px-1.5 align-[1px] text-[10px] font-medium leading-4 text-primary">
      {children}
    </span>
  );
}

/** Used by chat's ComposerModelMenu as the 1M-context toggle: a small switch reflecting `checked`. */
export function ComposerMenuSwitch({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors',
        checked ? 'bg-primary' : 'bg-muted-foreground/30',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-3 w-3 rounded-full bg-background shadow transition-transform',
          checked ? 'translate-x-3.5' : 'translate-x-0.5',
        )}
      />
    </span>
  );
}

/** Used by chat's ComposerModelMenu and ComposerPermissionMenu to render one selectable row with its checked state. */
export function ComposerMenuItem({
  label,
  description,
  icon,
  isSelected,
  onSelect,
  role = 'menuitemradio',
  trailing,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  isSelected: boolean;
  onSelect: () => void;
  role?: 'menuitemradio' | 'menuitemcheckbox' | 'menuitem';
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === 'menuitem' ? undefined : isSelected}
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
        'hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
        isSelected ? 'text-foreground' : 'text-foreground/90',
        className,
      )}
    >
      {icon && <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate leading-5">{label}</span>
        {description && (
          <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{description}</span>
        )}
      </span>
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
        {trailing ?? (isSelected ? <Check className="h-3.5 w-3.5 text-foreground" /> : null)}
      </span>
    </button>
  );
}
