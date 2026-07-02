import { AutoComplete } from 'antd';
import type { CSSProperties } from 'react';
import { useClusterList } from './useClusterList';

interface Props {
  /** k8s plural to list for suggestions, e.g. "services". */
  resource: string;
  /** Namespace to scope the list (omit for cluster-scoped resources). */
  namespace?: string;
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  style?: CSSProperties;
}

/**
 * A name field backed by a live cluster lookup: it suggests existing resources
 * of `resource` as a dropdown, but still accepts free text (the referenced
 * object may not exist yet, or live in another namespace, or the user may lack
 * list permission — in which case it behaves as a plain input).
 */
export default function ResourceSelect({
  resource,
  namespace,
  value,
  onChange,
  placeholder,
  style,
}: Props) {
  const { names } = useClusterList(resource, namespace);
  const options = names.map((n) => ({ value: n }));

  return (
    <AutoComplete
      value={value}
      onChange={onChange}
      options={options}
      placeholder={placeholder}
      style={style}
      allowClear
      filterOption={(input, opt) =>
        String(opt?.value ?? '').toLowerCase().includes(input.toLowerCase())
      }
    />
  );
}
