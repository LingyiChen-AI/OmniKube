import { Button, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import ContainerCard from '../ContainerCard';

const { Text } = Typography;

interface Props {
  containers: any[];
  /** Reports updated containers and pod volumes together (mounts manage their
   *  backing volume). */
  onChange: (containers: any[], volumes: any[]) => void;
  /** Show the per-container editable name field (multi-container specs). */
  editableNames?: boolean;
  /** Pod-level fields rendered on the first container's header row. */
  headerExtra?: ReactNode;
  /** Pod volumes (managed inline by container mounts). */
  volumes?: any[];
  /** Namespace, for the mount source dropdowns. */
  namespace?: string;
}

/** A fresh, blank container — the user fills name + image. */
function newContainer(): any {
  return { name: '', image: '' };
}

/**
 * Containers editor shared by every pod-bearing form (Workload / Pod / Job /
 * CronJob): a titled header with a live count and an "add" button, then one
 * ContainerCard per container with inline remove.
 */
export default function ContainersSection({ containers, onChange, editableNames = true, headerExtra, volumes = [], namespace }: Props) {
  const { t } = useTranslation();

  const setAt = (idx: number, next: any, nextVolumes?: any[]) => {
    const list = containers.slice();
    list[idx] = next;
    onChange(list, nextVolumes ?? volumes);
  };
  const removeAt = (idx: number) => onChange(containers.filter((_, i) => i !== idx), volumes);
  const add = () => onChange([...containers, newContainer()], volumes);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Text strong style={{ fontSize: 15 }}>
          {t('editor.containers')}
        </Text>
        {containers.length > 0 && (
          <Tag bordered={false} color="blue" style={{ marginInlineEnd: 0 }}>
            {containers.length}
          </Tag>
        )}
        <span style={{ flex: 1 }} />
        <Button size="small" icon={<PlusOutlined />} onClick={add}>
          {t('editor.addContainer')}
        </Button>
      </div>
      {containers.length === 0 && <Text type="secondary">{t('editor.noContainers')}</Text>}
      {containers.map((c, i) => (
        <ContainerCard
          key={i}
          container={c}
          editableName={editableNames}
          headerExtra={i === 0 ? headerExtra : undefined}
          volumes={volumes}
          namespace={namespace}
          onChange={(next, nextVolumes) => setAt(i, next, nextVolumes)}
          onRemove={containers.length > 1 ? () => removeAt(i) : undefined}
        />
      ))}
    </div>
  );
}
