import { diffLines } from 'diff';

export type DiffRowType = 'equal' | 'add' | 'del' | 'mod';

export interface DiffRow {
  /** 1-based line number on the original (left) side, if present. */
  leftNo?: number;
  /** 1-based line number on the current (right) side, if present. */
  rightNo?: number;
  left?: string;
  right?: string;
  type: DiffRowType;
}

function splitLines(value: string): string[] {
  const lines = value.split('\n');
  // diffLines values usually end with a trailing newline; drop the empty tail.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Build a side-by-side, line-level diff between two YAML strings. Adjacent
 * removed+added blocks are paired into "modified" rows so changes line up.
 */
export function buildSideBySide(original: string, current: string): DiffRow[] {
  const parts = diffLines(original, current);
  const rows: DiffRow[] = [];
  let leftNo = 1;
  let rightNo = 1;

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      for (const line of splitLines(part.value)) {
        rows.push({ type: 'equal', left: line, right: line, leftNo: leftNo++, rightNo: rightNo++ });
      }
      continue;
    }

    if (part.removed) {
      const next = parts[i + 1];
      if (next && next.added) {
        // Modified block: zip removed (left) and added (right) lines.
        const rem = splitLines(part.value);
        const add = splitLines(next.value);
        const n = Math.max(rem.length, add.length);
        for (let k = 0; k < n; k += 1) {
          const l = rem[k];
          const r = add[k];
          if (l !== undefined && r !== undefined) {
            rows.push({ type: 'mod', left: l, right: r, leftNo: leftNo++, rightNo: rightNo++ });
          } else if (l !== undefined) {
            rows.push({ type: 'del', left: l, leftNo: leftNo++ });
          } else {
            rows.push({ type: 'add', right: r, rightNo: rightNo++ });
          }
        }
        i += 1; // consume the paired added part
        continue;
      }
      for (const line of splitLines(part.value)) {
        rows.push({ type: 'del', left: line, leftNo: leftNo++ });
      }
      continue;
    }

    // added only
    for (const line of splitLines(part.value)) {
      rows.push({ type: 'add', right: line, rightNo: rightNo++ });
    }
  }

  return rows;
}

/** True when the two strings have no line-level differences. */
export function hasNoChange(original: string, current: string): boolean {
  return !buildSideBySide(original, current).some((r) => r.type !== 'equal');
}
