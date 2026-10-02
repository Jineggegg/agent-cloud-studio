import type { StudioGlyph } from '@/shared/types';
import { StudioTileIcon } from '@/modules/studio/StudioTileIcon';

// Must match the server's allowed tones and glyphs.
const TONES: Record<string, string> = { sage: '青灰绿', clay: '陶土', slate: '石板蓝', graphite: '石墨', sand: '沙色', stone: '岩灰', moss: '苔绿', rose: '灰玫瑰' };
const GLYPHS: Record<StudioGlyph, string> = {
  folder: '文件夹', activity: '波形', graduation: '学位帽', candles: 'K 线', chart: '折线', mail: '邮件', terminal: '终端', sparkles: '星芒', book: '书', globe: '地球',
};

/** Used by StudioProjectEditor and StudioBuildComposer to choose a home-screen icon's colour family and glyph. */
export function StudioIconPicker({ tone, glyph, onChange }: {
  tone: string; glyph: string;
  onChange: (patch: { tone: string } | { glyph: StudioGlyph }) => void;
}) {
  return <div className="ios-list picker-list">
    <div className="tone-picker" role="radiogroup" aria-label="图标颜色">
      {Object.entries(TONES).map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={tone === value} aria-label={label}
        className={`tone-swatch tone-${value}`} onClick={() => onChange({ tone: value })} />)}
    </div>
    <div className="glyph-picker" role="radiogroup" aria-label="图标符号">
      {(Object.entries(GLYPHS) as [StudioGlyph, string][]).map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={glyph === value}
        aria-label={label} className="glyph-option" onClick={() => onChange({ glyph: value })}>
        <StudioTileIcon tone={glyph === value ? tone : 'ghost'} glyph={value} size={18} variant="small" />
      </button>)}
    </div>
  </div>;
}
