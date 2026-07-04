import { useCallback, useMemo, useRef } from 'react';
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

// Fixed code-surface palette, matching CodeBox so the panes read as "code"
// under either app theme.
const C = {
  bg: '#0E1424',
  gutterBg: '#0A0E1A',
  headerBg: '#0A0E1A',
  border: '#26304A',
  text: '#E6EAF2',
  lineNo: '#5B6680',
} as const;

function bgFor(type: DiffRow['type'], side: 'left' | 'right'): string | undefined {
  if (type === 'equal') return undefined;
  if (type === 'mod') return MOD_BG;
  if (type === 'del') return side === 'left' ? DEL_BG : undefined;
  return side === 'right' ? ADD_BG : undefined;
}

/** Non-color-dependent marker so the diff reads without relying on color. */
function signFor(type: DiffRow['type'], side: 'left' | 'right'): string {
  if (type === 'equal') return '';
  if (type === 'mod') return '~';
  if (type === 'del') return side === 'left' ? '-' : '';
  return side === 'right' ? '+' : '';
}

const fontFamily = "'Fira Code', 'SFMono-Regular', Consolas, Menlo, monospace";
const fontSize = 12.5;
const lineHeight = 1.6;

function Pane({
  rows,
  side,
  scrollRef,
  onScroll,
}: {
  rows: DiffRow[];
  side: 'left' | 'right';
  scrollRef: React.RefObject<HTMLDivElement>;
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      style={{
        flex: 1,
        minWidth: 0,
        overflow: 'auto',
      }}
    >
      <div style={{ display: 'inline-flex', minWidth: '100%' }}>
        <div
          aria-hidden
          style={{
            position: 'sticky',
            left: 0,
            zIndex: 1,
            flex: '0 0 auto',
            background: C.gutterBg,
            borderRight: `1px solid ${C.border}`,
          }}
        >
          {rows.map((r, i) => {
            const no = side === 'left' ? r.leftNo : r.rightNo;
            return (
              <div
                key={i}
                style={{
                  minWidth: 34,
                  padding: '0 10px',
                  textAlign: 'right',
                  userSelect: 'none',
                  color: C.lineNo,
                  fontFamily,
                  fontSize,
                  lineHeight,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {no ?? ''}
              </div>
            );
          })}
        </div>
        <div style={{ flex: '1 0 auto' }}>
          {rows.map((r, i) => {
            const text = side === 'left' ? r.left : r.right;
            const isBlank = text === undefined;
            const bg = bgFor(r.type, side);
            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  background: bg,
                  minHeight: fontSize * lineHeight,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    flex: '0 0 14px',
                    userSelect: 'none',
                    textAlign: 'center',
                    fontFamily,
                    fontSize,
                    lineHeight,
                    fontWeight: 600,
                    opacity: 0.85,
                    color: C.text,
                  }}
                >
                  {signFor(r.type, side)}
                </span>
                <span
                  style={{
                    whiteSpace: 'pre',
                    flex: 1,
                    paddingRight: 16,
                    fontFamily,
                    fontSize,
                    lineHeight,
                    color: isBlank ? 'transparent' : C.text,
                  }}
                >
                  {isBlank ? ' ' : text}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Two-pane side-by-side code-style diff of two YAML strings. */
export default function DiffView({ original, current }: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const rows = useMemo(() => buildSideBySide(original, current), [original, current]);
  const changed = rows.some((r) => r.type !== 'equal');

  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  // Guard against feedback loops when mirroring scrollTop between panes.
  const syncing = useRef<'left' | 'right' | null>(null);

  const onScrollLeft = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (syncing.current === 'right') {
      syncing.current = null;
      return;
    }
    syncing.current = 'left';
    const target = rightRef.current;
    if (target) target.scrollTop = e.currentTarget.scrollTop;
  }, []);

  const onScrollRight = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (syncing.current === 'left') {
      syncing.current = null;
      return;
    }
    syncing.current = 'right';
    const target = leftRef.current;
    if (target) target.scrollTop = e.currentTarget.scrollTop;
  }, []);

  if (!changed) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={t('editor.noChange')}
        style={{ padding: '48px 0' }}
      />
    );
  }

  const swatch = (color: string, label: string) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 10, height: 10, borderRadius: 3, background: color, display: 'inline-block' }} />
      <span style={{ fontSize: 11, color: C.lineNo }}>{label}</span>
    </span>
  );

  const paneTitle: React.CSSProperties = {
    flex: 1,
    padding: '6px 14px',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: C.lineNo,
    fontFamily,
  };

  return (
    <div
      aria-label="diff"
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
        border: `1px solid ${token.colorBorder}`,
        borderRadius: token.borderRadiusLG,
        overflow: 'hidden',
        background: C.bg,
      }}
    >
      {/* Top bar: legend, spans both panels. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 14,
          padding: '6px 14px',
          background: C.headerBg,
          borderBottom: `1px solid ${C.border}`,
        }}
      >
        {swatch(ADD_BAR, t('editor.diffAdded'))}
        {swatch(DEL_BAR, t('editor.diffRemoved'))}
        {swatch(MOD_BAR, t('editor.diffModified'))}
      </div>

      {/* Pane headers. */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${C.border}` }}>
        <div style={{ ...paneTitle, borderRight: `1px solid ${C.border}` }}>{t('editor.original')}</div>
        <div style={paneTitle}>{t('editor.current')}</div>
      </div>

      {/* Two code panes. */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            borderRight: `1px solid ${C.border}`,
          }}
        >
          <Pane rows={rows} side="left" scrollRef={leftRef} onScroll={onScrollLeft} />
        </div>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
          <Pane rows={rows} side="right" scrollRef={rightRef} onScroll={onScrollRight} />
        </div>
      </div>
    </div>
  );
}
