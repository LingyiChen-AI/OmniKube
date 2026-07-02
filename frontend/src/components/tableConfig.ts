/**
 * Shared table styling system — produced with the ui-ux-pro-max skill.
 *
 * Goal: every table in the app looks consistent and NEVER crushes columns
 * (the CJK "one character per line" vertical-stacking bug), while letting the
 * first (name) column pin `fixed: 'left'` and the actions column pin
 * `fixed: 'right'` without the overlap bug.
 *
 * The rules:
 *  - One density everywhere: `size: 'middle'`.
 *  - Horizontal scroll via a NUMERIC `scroll.x` equal to the sum of the
 *    table's column widths — NOT `'max-content'`. With a concrete number AntD
 *    lays the columns out deterministically and fixed columns pin correctly;
 *    `'max-content'` combined with `fixed: 'right'` made the actions column
 *    overlap its neighbour when the total width was below the container.
 *  - Every column carries an explicit width (and/or `ellipsis`) so headers and
 *    cells stay single-line; fixed columns REQUIRE an explicit numeric width.
 *
 * Spread `defaultTableProps` for density, then pass `scroll={tableScrollX(columns)}`
 * (or `tableScrollX(w1, w2, …)`) so the numeric width tracks the real columns.
 */

import type { ColumnsType } from 'antd/es/table';
import type { TablePaginationConfig } from 'antd';

/** Uniform chrome for every <Table>: medium density. */
export const defaultTableProps = {
  size: 'middle',
} as const;

/**
 * Canonical pager for every table: 20 rows per page, always shown (even for a
 * single page), and left-aligned (`bottomLeft`). Spread it and override per
 * table when server-side paging or a size changer is needed:
 *   pagination={{ ...defaultPagination, total, current: page, onChange }}
 */
export const defaultPagination: TablePaginationConfig = {
  pageSize: 20,
  hideOnSinglePage: false,
  showSizeChanger: false,
  position: ['bottomLeft'],
};

/**
 * Build a numeric horizontal scroll config from a table's columns (or a raw
 * list of widths). The result `{ x: sum }` makes fixed columns pin without the
 * `'max-content'` overlap bug and shows a horizontal scrollbar only when the
 * container is narrower than the summed width. Non-numeric widths count as 0.
 */
export function tableScrollX(
  input: ColumnsType<any> | number,
  ...rest: number[]
): { x: number } {
  if (typeof input === 'number') {
    return { x: [input, ...rest].reduce((sum, w) => sum + (w || 0), 0) };
  }
  const x = input.reduce<number>(
    (sum, col: any) => sum + (typeof col.width === 'number' ? col.width : 0),
    0,
  );
  return { x };
}

/** Canonical column widths (px) shared across all tables. */
export const colW = {
  /** Primary / name column — wide enough for real names, truncates beyond. */
  name: 220,
  /** Namespace and similar secondary identifiers. */
  namespace: 160,
  /** Free-text columns (host, node, storage class, service, IP). */
  text: 200,
  /** Relative age / timestamp. */
  age: 130,
  /** Status / phase tag column. */
  status: 140,
  /** Short numeric or single-tag metric (Ready, Up-to-date, counts). */
  metric: 110,
  /** Slightly wider metric (Ready a/b, Completions). */
  metricWide: 130,
  /** Tag-list / chips column (roles, pages, ports). */
  tags: 240,
  /** Right-pinned actions column (icon button row). */
  actions: 200,
  /** Compact actions column (1–2 icon buttons). */
  actionsSm: 120,
} as const;
