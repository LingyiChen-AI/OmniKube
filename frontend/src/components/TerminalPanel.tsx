import { useEffect, useRef, useState } from 'react';
import { Alert, Space, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

type ConnState = 'connecting' | 'open' | 'closed' | 'error';

interface Props {
  /** WebSocket URL (already includes token & params). */
  url: string;
  /** Interactive (exec) vs read-only (logs). */
  interactive: boolean;
}

const xtermTheme = {
  background: '#0A0E1A',
  foreground: '#D6E0F5',
  cursor: '#0EA5E9',
  selectionBackground: 'rgba(14,165,233,0.35)',
  black: '#0A0E1A',
  brightBlack: '#6B7793',
  red: '#EF4444',
  green: '#22C55E',
  yellow: '#F59E0B',
  blue: '#60A5FA',
  magenta: '#A78BFA',
  cyan: '#38BDF8',
  white: '#E6EAF2',
};

export default function TerminalPanel({ url, interactive }: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ConnState>('connecting');

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      fontFamily: "'Fira Code', monospace",
      fontSize: 13,
      cursorBlink: interactive,
      disableStdin: !interactive,
      convertEol: true,
      theme: xtermTheme,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    try {
      fit.fit();
    } catch {
      /* ignore */
    }

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN && interactive) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };

    ws.onopen = () => {
      setState('open');
      sendResize();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        term.write(ev.data);
      } else {
        term.write(new Uint8Array(ev.data));
      }
    };
    ws.onerror = () => setState('error');
    ws.onclose = () => {
      setState('closed');
      term.write('\r\n\x1b[90m── connection closed ──\x1b[0m\r\n');
    };

    let inputDisposable: { dispose: () => void } | undefined;
    if (interactive) {
      inputDisposable = term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      });
    }

    const onResize = () => {
      try {
        fit.fit();
        sendResize();
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(containerRef.current);

    return () => {
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      inputDisposable?.dispose();
      ws.close();
      term.dispose();
    };
  }, [url, interactive]);

  const stateTag: Record<ConnState, { color: string; label: string }> = {
    connecting: { color: 'gold', label: t('terminal.connecting') },
    open: { color: 'green', label: t('terminal.connected') },
    closed: { color: 'default', label: t('terminal.closed') },
    error: { color: 'red', label: t('terminal.error') },
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Space style={{ marginBottom: 8 }}>
        <Tag color={stateTag[state].color}>{stateTag[state].label}</Tag>
      </Space>
      {state === 'error' && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 8 }}
          message={t('terminal.wsFailed')}
          description={t('terminal.wsFailedDesc')}
        />
      )}
      <div className="ok-terminal" ref={containerRef} />
    </div>
  );
}
