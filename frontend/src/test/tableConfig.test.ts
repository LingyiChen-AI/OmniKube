import { describe, it, expect } from 'vitest';
import type { ColumnsType } from 'antd/es/table';
import { defaultTableProps, tableScrollX } from '../components/tableConfig';

describe('tableScrollX', () => {
  it('sums explicit numeric widths into a numeric scroll.x', () => {
    expect(tableScrollX(220, 160, 130, 200)).toEqual({ x: 710 });
  });

  it('derives scroll.x from a columns array, ignoring non-numeric widths', () => {
    const columns: ColumnsType<{ id: string }> = [
      { title: 'a', width: 220 },
      { title: 'b', width: 'auto' as unknown as number },
      { title: 'c', width: 130 },
      { title: 'd' },
    ];
    expect(tableScrollX(columns)).toEqual({ x: 350 });
  });

  it('keeps medium density and no longer hardcodes max-content', () => {
    expect(defaultTableProps).toEqual({ size: 'middle' });
    expect((defaultTableProps as Record<string, unknown>).scroll).toBeUndefined();
  });
});
