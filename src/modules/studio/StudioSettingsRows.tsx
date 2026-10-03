import type { ReactNode } from 'react';

import { IconChevronRight, IconExternalLink } from '@/modules/studio/icons/tabler';

/** The small monochrome glyph card at the start of a settings row (the home screen's card icons, in miniature). */
export function SettingsIcon({ children }: { children: ReactNode }) {
  return <span className="settings-icon" aria-hidden="true">{children}</span>;
}

/**
 * A row that opens another page, iOS-style: icon, title, an optional subtitle, the current value in grey and a
 * chevron. `selected` marks the page shown beside the list on a wide screen.
 */
export function SettingsLinkRow({ icon, title, subtitle, detail, selected, onClick }: {
  icon?: ReactNode; title: string; subtitle?: string; detail?: ReactNode; selected?: boolean; onClick: () => void;
}) {
  return <button type="button" className={`ios-row settings-link ${icon ? '' : 'no-icon'}`} aria-current={selected ? 'page' : undefined} onClick={onClick}>
    {icon && <SettingsIcon>{icon}</SettingsIcon>}
    <span className="ios-row-body"><strong>{title}</strong>{subtitle && <small>{subtitle}</small>}</span>
    {detail !== undefined && detail !== null && detail !== '' && <span className="ios-row-detail">{detail}</span>}
    <IconChevronRight size={18} className="chevron" aria-hidden="true" />
  </button>;
}

/** A row that leaves Studio for another site, opened in a new tab. */
export function SettingsExternalRow({ icon, title, subtitle, href }: { icon?: ReactNode; title: string; subtitle?: string; href: string }) {
  return <a className={`ios-row settings-link ${icon ? '' : 'no-icon'}`} href={href} target="_blank" rel="noreferrer">
    {icon && <SettingsIcon>{icon}</SettingsIcon>}
    <span className="ios-row-body"><strong>{title}</strong>{subtitle && <small>{subtitle}</small>}</span>
    <IconExternalLink size={16} className="chevron" aria-hidden="true" />
  </a>;
}

/** A plain label and value, like 关于本机's 版本 and 型号. */
export function SettingsValueRow({ title, value, mono = false }: { title: string; value: ReactNode; mono?: boolean }) {
  return <div className="ios-row no-icon settings-value">
    <span className="ios-row-body"><strong>{title}</strong></span>
    <span className={`ios-row-detail ${mono ? 'mono' : ''}`}>{value}</span>
  </div>;
}
