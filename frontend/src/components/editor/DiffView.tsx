import { useMemo } from 'react';
import { Empty, theme } from 'antd';
import { useTranslation } from 'react-i18next';
import { buildSideBySide, type DiffRow } from './diff';

interface Props {
  original: string;
  current: string;
}

const ADD_BG = 'rgba(34,197,94,0.16)';
const DEL_BG = 'rgba(239,68,68,0.16)';
const MOD_BG = 'rgba(245,158,11,0.15)';
const ADD_BAR = '#22C55E';
const DEL_BAR = '#EF4444';
const MOD_BAR = '#F59E0B';

function bgFor(type: DiffRow['type'], side: 'left' | 'right'): string | undefined {
  if (type === 'equal') return undefined;
  if (type === 'mod') return MOD_BG;
  if (type === 'del') return side === 'left' ? DEL_BG : undefined;
  return side === 'right' ? ADD_BG : undefined;
}

function barFor(type: DiffRow['type'], side: 'left' | 'right'): string | undefined {
  if (type === 'equal') return undefined;
  if (type === 'mod') return MOD_BAR;
  if (type === 'del') return side === 'left' ? DEL_BAR : undefined;
  return side === 'right' ? ADD_BAR : undefined;
}

/** Non-color-dependent marker so the diff reads without relying on color. */
function signFor(type: DiffRow['type'], side: 'left' | 'right'): string {
  if (type === 'equal') return '';
  if (type === 'mod') return '~';
  if (type === 'del') return side === 'left' ? '-' : '';
  return side === 'right' ? '+' : '';
}

function Side({
  row,
  side,
  gutterColor,
}: {
  row: DiffRow;
  side: 'left' | 'right';
  gutterColor: string;
}) {
  const no = side === 'left' ? row.leftNo : row.rightNo;
  const text = side === 'left' ? row.left : row.right;
  const bg = bgFor(row.type, side);
  const bar = barFor(row.type, side);
  return (
    <div style={{ display: 'flex', background: bg, minHeight: 21 }}>
      <span style={{ flex: '0 0 3px', background: bar || 'transparent' }} />
      <span
        style={{
          flex: '0 0 44px',
          textAlign: 'right',
          paddingRight: 10,
          userSelect: 'none',
          color: gutterColor,
          opacity: 0.7,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {no ?? ''}
      </span>
      <span
        aria-hidden
        style={{ flex: '0 0 14px', userSelect: 'none', textAlign: 'center', opacity: 0.85, fontWeight: 600 }}
      >
        {signFor(row.type, side)}
      </span>
      <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1, paddingRight: 8 }}>
        {text ?? ''}
      </span>
    </div>
  );
}

/** Colored side-by-side line diff of two YAML strings. */
export default function DiffView({ original, current }: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const rows = useMemo(() => buildSideBySide(original, current), [original, current]);
  const changed = rows.some((r) => r.type !== 'equal');

  if (!changed) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={t('editor.noChange')}
        style={{ padding: '48px 0' }}
      />
    );
  }

  const colTitle: React.CSSProperties = {
    flex: 1,
    padding: '7px 14px',
    fontSize: 11.5,
    fontWeight: 600,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: token.colorTextSecondary,
  };
  const swatch = (color: string, label: string) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 10, height: 10, borderRadius: 3, background: color, display: 'inline-block' }} />
      <span style={{ fontSize: 11, color: token.colorTextTertiary }}>{label}</span>
    </span>
  );

  return (
    <div
      aria-label="diff"
      style={{
        border: `1px solid ${token.colorBorder}`,
        borderRadius: token.borderRadiusLG,
        overflow: 'hidden',
        background: token.colorBgContainer,
      }}
    >
      {/* Header: column titles + legend */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorFillQuaternary,
        }}
      >
        <div style={{ ...colTitle, borderRight: `1px solid ${token.colorBorderSecondary}` }}>
          {t('editor.original')}
        </div>
        <div style={colTitle}>{t('editor.current')}</div>
        <div style={{ display: 'flex', gap: 14, padding: '0 14px', flex: '0 0 auto' }}>
          {swatch(ADD_BAR, t('editor.diffAdded'))}
          {swatch(DEL_BAR, t('editor.diffRemoved'))}
          {swatch(MOD_BAR, t('editor.diffModified'))}
        </div>
      </div>

      <div style={{ overflow: 'auto', fontFamily: token.fontFamilyCode, fontSize: 12.5, lineHeight: 1.6 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', minWidth: 720 }}>
          <div style={{ borderRight: `1px solid ${token.colorBorderSecondary}` }}>
            {rows.map((r, i) => (
              <Side key={`l${i}`} row={r} side="left" gutterColor={token.colorTextTertiary} />
            ))}
          </div>
          <div>
            {rows.map((r, i) => (
              <Side key={`r${i}`} row={r} side="right" gutterColor={token.colorTextTertiary} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
