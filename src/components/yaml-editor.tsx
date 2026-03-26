'use client';

import { useCallback, useMemo } from 'react';
import Editor from 'react-simple-code-editor';
import Prism from 'prismjs';
import 'prismjs/components/prism-yaml';

interface Props {
  value?: string;
  onChange?: (value: string) => void;
  height?: number | string;
  readOnly?: boolean;
  placeholder?: string;
  diffBase?: string;
}

function highlightYaml(code: string): string {
  return Prism.highlight(code, Prism.languages.yaml, 'yaml');
}

// Simple LCS-based diff to compute per-line status
function computeDiff(baseText: string, currentText: string): ('added' | 'modified' | null)[] {
  const baseLines = baseText.split('\n');
  const curLines = currentText.split('\n');
  const baseSet = new Set(baseLines);

  // Build LCS table
  const m = baseLines.length;
  const n = curLines.length;

  // For performance, use a simplified approach:
  // Find which current lines exist in base (by content)
  // Lines not in base at all = added
  // Lines in base but at different position = check if content changed

  // Track which base lines have been "consumed" by matching
  const baseUsed = new Array(m).fill(false);

  const result: ('added' | 'modified' | null)[] = [];

  // Two pointer greedy match
  let bi = 0;
  for (let ci = 0; ci < n; ci++) {
    // Try to find curLines[ci] in remaining base lines
    let found = false;
    for (let j = bi; j < m; j++) {
      if (curLines[ci] === baseLines[j]) {
        // Mark skipped base lines as consumed
        for (let k = bi; k < j; k++) baseUsed[k] = true;
        baseUsed[j] = true;
        bi = j + 1;
        found = true;
        break;
      }
    }
    if (found) {
      result.push(null); // unchanged
    } else if (!baseSet.has(curLines[ci])) {
      result.push('added');
    } else {
      result.push('modified');
    }
  }

  return result;
}

const LINE_HEIGHT = 1.6;
const FONT_SIZE = 13;
const PADDING = 14;
const LINE_PX = FONT_SIZE * LINE_HEIGHT;

export default function YamlEditor({ value = '', onChange, height = 400, readOnly = false, placeholder, diffBase }: Props) {
  const highlight = useCallback((code: string) => highlightYaml(code), []);

  // 计算每行的 diff 状态
  const diffLines = useMemo(() => {
    if (!diffBase) return null;
    return computeDiff(diffBase, value);
  }, [value, diffBase]);

  return (
    <div style={{
      position: 'relative',
      borderRadius: 8,
      overflow: 'hidden',
      backgroundColor: '#0d1117',
      height: typeof height === 'number' ? height : undefined,
      minHeight: typeof height === 'string' ? height : undefined,
    }}>
      <div style={{
        position: 'absolute',
        top: 8,
        right: 12,
        fontSize: 10,
        color: '#484f58',
        userSelect: 'none',
        zIndex: 2,
        fontWeight: 500,
        letterSpacing: 0.5,
      }}>
        YAML
      </div>
      <div style={{ height: '100%', overflow: 'auto', position: 'relative', overflowX: 'auto' }}>
        {/* Diff 整行背景层 */}
        {diffLines && (
          <div style={{
            position: 'absolute',
            top: PADDING,
            left: 0,
            right: 0,
            pointerEvents: 'none',
            zIndex: 0,
          }}>
            {diffLines.map((status, i) => (
              <div
                key={i}
                style={{
                  height: LINE_PX,
                  background: status === 'added'
                    ? 'rgba(63,185,80,0.18)'
                    : status === 'modified'
                    ? 'rgba(210,153,34,0.22)'
                    : 'transparent',
                  borderLeft: status ? `3px solid ${status === 'added' ? '#3fb950' : '#d29922'}` : '3px solid transparent',
                }}
              />
            ))}
          </div>
        )}
        <Editor
          value={value}
          onValueChange={(v) => !readOnly && onChange?.(v)}
          highlight={highlight}
          padding={PADDING}
          placeholder={placeholder}
          readOnly={readOnly}
          tabSize={2}
          insertSpaces
          textareaClassName="yaml-editor-textarea"
          style={{
            fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Monaco, Consolas, monospace",
            fontSize: FONT_SIZE,
            lineHeight: LINE_HEIGHT,
            color: '#e6edf3',
            backgroundColor: 'transparent',
            minHeight: '100%',
            caretColor: '#e6edf3',
            position: 'relative',
            zIndex: 1,
          }}
        />
      </div>
      <style>{`
        .yaml-editor-textarea { outline: none !important; white-space: pre !important; overflow-wrap: normal !important; word-wrap: normal !important; }
        .yaml-editor-textarea::placeholder { color: #484f58 !important; }
        .yaml-editor-textarea + pre { white-space: pre !important; overflow-wrap: normal !important; word-wrap: normal !important; }
        .token.key, .token.atrule { color: #7ee787 !important; }
        .token.string { color: #a5d6ff !important; }
        .token.number { color: #79c0ff !important; }
        .token.boolean { color: #ff7b72 !important; }
        .token.comment { color: #8b949e !important; font-style: italic; }
        .token.punctuation { color: #79c0ff !important; }
        .token.important { color: #ff7b72 !important; }
      `}</style>
    </div>
  );
}
