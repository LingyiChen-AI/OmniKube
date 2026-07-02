import { useMemo, useState } from 'react';
import { CheckOutlined, CopyOutlined, EnterOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

/**
 * CodeBox — a polished, theme-independent code surface used both as a
 * controlled editor and as a read-only viewer.
 *
 * Design (ui-ux-pro-max): a code panel must *read* as code, so the surface is
 * a fixed very-dark navy in BOTH light and dark themes (terminal aesthetic),
 * with Fira Code, comfortable line-height, a sticky line-number gutter and
 * horizontal scroll for long lines (no wrap by default, toggle to wrap).
 *
 * Implementation: a transparent <textarea> layered over a <pre> mirror inside a
 * single scroll container. The container drives both axes; the gutter is
 * position:sticky so numbers stay pinned during horizontal scroll. No JS
 * scroll-sync, so the caret and text never drift apart.
 */

// Fixed code-surface palette — intentionally not token-driven so the box looks
// identical (and unmistakably "code") under either app theme.
const C = {
  bg: '#0E1424',
  gutterBg: '#0A0E1A',
  toolbarBg: '#0A0E1A',
  border: '#26304A',
  text: '#E6EAF2',
  lineNo: '#5B6680',
  caret: '#A5B4FC',
} as const;

export interface CodeBoxProps {
  /** Optional so it can be driven by an AntD Form.Item (which injects value). */
  value?: string;
  /** Omit (or set readOnly) to render a read-only viewer. */
  onChange?: (next: string) => void;
  readOnly?: boolean;
  /** Small uppercase label shown at the left of the toolbar, e.g. "YAML". */
  label?: string;
  placeholder?: string;
  showLineNumbers?: boolean;
  /** Toolbar with label + wrap/copy actions. */
  toolbar?: boolean;
  /** Fixed height; when omitted the box grows to content up to maxHeight. */
  height?: number | string;
  minHeight?: number | string;
  maxHeight?: number | string;
  fontSize?: number;
  ariaLabel?: string;
  autoFocus?: boolean;
}

export default function CodeBox({
  value = '',
  onChange,
  readOnly,
  label,
  placeholder,
  showLineNumbers = true,
  toolbar = true,
  height,
  minHeight = 120,
  maxHeight,
  fontSize = 12.75,
  ariaLabel,
  autoFocus,
}: CodeBoxProps) {
  const { t } = useTranslation();
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);

  const editable = !!onChange && !readOnly;
  const lineHeight = 1.65;
  // height="100%" → fill the parent flex column instead of a fixed height.
  const fill = height === '100%';

  const lineCount = useMemo(() => {
    let n = 1;
    for (let i = 0; i < value.length; i += 1) if (value[i] === '\n') n += 1;
    return n;
  }, [value]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — silently ignore */
    }
  };

  const codeBase: React.CSSProperties = {
    margin: 0,
    padding: '12px 16px',
    fontFamily: "'Fira Code', 'SFMono-Regular', Consolas, Menlo, monospace",
    fontSize,
    lineHeight,
    fontVariantLigatures: 'none',
    tabSize: 2,
    whiteSpace: wrap ? 'pre-wrap' : 'pre',
    wordBreak: wrap ? 'break-word' : 'normal',
    overflowWrap: wrap ? 'anywhere' : 'normal',
  };

  return (
    <div
      className="ok-codebox"
      style={{
        width: '100%',
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        background: C.bg,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 24px rgba(2,6,23,0.28)',
        ...(fill ? { flex: 1, minHeight: 0 } : null),
      }}
    >
      {toolbar && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 8px 6px 14px',
            background: C.toolbarBg,
            borderBottom: `1px solid ${C.border}`,
          }}
        >
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontFamily: "'Fira Code', monospace",
              fontSize: 11,
              letterSpacing: 1,
              textTransform: 'uppercase',
              color: C.lineNo,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {label || ''}
          </span>
          <button
            type="button"
            className={`ok-codebox__btn${wrap ? ' ok-codebox__btn--active' : ''}`}
            onClick={() => setWrap((w) => !w)}
            aria-pressed={wrap}
            title={t('editor.wrap')}
          >
            <EnterOutlined style={{ fontSize: 13 }} />
            <span>{t('editor.wrap')}</span>
          </button>
          <button
            type="button"
            className="ok-codebox__btn"
            onClick={handleCopy}
            title={t('editor.copy')}
          >
            {copied ? (
              <CheckOutlined style={{ fontSize: 13, color: '#34D399' }} />
            ) : (
              <CopyOutlined style={{ fontSize: 13 }} />
            )}
            <span>{copied ? t('editor.copied') : t('editor.copy')}</span>
          </button>
        </div>
      )}

      <div
        className="ok-codebox__scroll"
        style={{
          position: 'relative',
          overflow: 'auto',
          ...(fill ? { flex: 1, minHeight: 0 } : { height, minHeight, maxHeight }),
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            minWidth: '100%',
            minHeight: '100%',
            alignItems: 'stretch',
          }}
        >
          {showLineNumbers && (
            <div
              aria-hidden
              style={{
                position: 'sticky',
                left: 0,
                zIndex: 1,
                flex: '0 0 auto',
                background: C.gutterBg,
                borderRight: `1px solid ${C.border}`,
                padding: '12px 0',
                userSelect: 'none',
                textAlign: 'right',
                fontFamily: "'Fira Code', monospace",
                fontSize,
                lineHeight,
                color: C.lineNo,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i} style={{ padding: '0 12px 0 16px', minWidth: 22 }}>
                  {i + 1}
                </div>
              ))}
            </div>
          )}

          <div style={{ position: 'relative', flex: '1 0 auto' }}>
            {/* Invisible mirror: sizes the column so the editor scrolls as one
                unit and the textarea always has room for its last line. In
                read-only mode it becomes the visible, selectable text. */}
            <pre
              aria-hidden={editable}
              style={{
                ...codeBase,
                color: editable ? 'transparent' : C.text,
                userSelect: editable ? 'none' : 'text',
              }}
            >
              {editable ? value + '\n' : value}
            </pre>
            {editable && (
              <textarea
                value={value}
                onChange={(e) => onChange?.(e.target.value)}
                placeholder={placeholder}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                wrap={wrap ? 'soft' : 'off'}
                aria-label={ariaLabel || label || 'code editor'}
                autoFocus={autoFocus}
                style={{
                  ...codeBase,
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  border: 0,
                  outline: 'none',
                  resize: 'none',
                  background: 'transparent',
                  color: C.text,
                  caretColor: C.caret,
                  overflow: 'hidden',
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
