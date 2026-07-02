import { useEffect, useRef, useState } from 'react';
import { AutoComplete, Button, Checkbox, Input, Select, Typography, theme } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useClusterList } from './useClusterList';

const { Text } = Typography;

type VolType = 'configMap' | 'secret' | 'persistentVolumeClaim' | 'emptyDir';
const TYPES: VolType[] = ['configMap', 'secret', 'persistentVolumeClaim', 'emptyDir'];

function tpOf(v: any): VolType {
  if (v?.configMap !== undefined) return 'configMap';
  if (v?.secret !== undefined) return 'secret';
  if (v?.persistentVolumeClaim !== undefined) return 'persistentVolumeClaim';
  return 'emptyDir';
}
function srcOf(v: any, tp: VolType): string {
  if (tp === 'configMap') return v?.configMap?.name ?? '';
  if (tp === 'secret') return v?.secret?.secretName ?? '';
  if (tp === 'persistentVolumeClaim') return v?.persistentVolumeClaim?.claimName ?? '';
  return '';
}
function srcObj(tp: VolType, name: string): any {
  if (tp === 'configMap') return { configMap: { name } };
  if (tp === 'secret') return { secret: { secretName: name } };
  if (tp === 'persistentVolumeClaim') return { persistentVolumeClaim: { claimName: name } };
  return { emptyDir: {} };
}

interface Row { id: number; name: string; tp: VolType; src: string; mountPath: string; readOnly: boolean; }

let _id = 0;
const nid = () => (_id += 1);

function rowsFrom(vm: any[], vols: any[]): Row[] {
  return vm.map((m) => {
    const v = vols.find((x) => x.name === m.name) || {};
    const tp = tpOf(v);
    return { id: nid(), name: m.name || '', tp, src: srcOf(v, tp), mountPath: m.mountPath ?? '', readOnly: !!m.readOnly };
  });
}
const blank = (): Row => ({ id: nid(), name: '', tp: 'configMap', src: '', mountPath: '', readOnly: false });
/** A row is committed to the manifest only once it carries a source or a path. */
const isReal = (r: Row) => r.mountPath.trim() !== '' || r.src.trim() !== '';
const snap = (rows: Row[]) =>
  JSON.stringify(rows.filter(isReal).map((r) => ({ tp: r.tp, s: r.src, mp: r.mountPath, ro: r.readOnly })));

interface Props {
  /** This container's volumeMounts. */
  volumeMounts: any[];
  /** Full pod volumes (other containers' volumes are preserved). */
  volumes: any[];
  namespace: string;
  onChange: (volumeMounts: any[], volumes: any[]) => void;
}

/**
 * Self-contained mount editor: each row picks type + source + path + read-only,
 * and manages its backing pod volume behind the scenes. Keeps a local row buffer
 * (like KeyValueEditor.seedEmpty) so a blank row is shown by default and stays
 * focused while typing — it is only written to the manifest once meaningful.
 */
export default function VolumeMountsEditor({ volumeMounts, volumes, namespace, onChange }: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { items: configmaps } = useClusterList('configmaps', namespace);
  const { items: secrets } = useClusterList('secrets', namespace);
  const { items: pvcs } = useClusterList('persistentvolumeclaims', namespace);
  const opts = (tp: VolType) =>
    (tp === 'configMap' ? configmaps : tp === 'secret' ? secrets : tp === 'persistentVolumeClaim' ? pvcs : [])
      .map((o) => ({ value: o.metadata?.name }));

  const [rows, setRows] = useState<Row[]>(() => {
    const r = rowsFrom(volumeMounts, volumes);
    return r.length ? r : [blank()];
  });
  // Re-seed only when the manifest changes to something we didn't emit ourselves.
  const propKey = snap(rowsFrom(volumeMounts, volumes));
  const lastEmit = useRef(propKey);
  useEffect(() => {
    if (propKey !== lastEmit.current) {
      const r = rowsFrom(volumeMounts, volumes);
      setRows(r.length ? r : [blank()]);
      lastEmit.current = propKey;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propKey]);

  const emit = (next: Row[]) => {
    setRows(next);
    // Generate stable volume names for real rows missing one.
    const used = new Set(volumes.map((v) => v.name));
    let n = 1;
    const gen = () => {
      while (used.has(`volume-${n}`)) n += 1;
      const name = `volume-${n}`;
      used.add(name);
      return name;
    };
    const real = next.filter(isReal).map((r) => ({ ...r, name: r.name || gen() }));
    const myMounts = real.map((r) => ({ name: r.name, mountPath: r.mountPath, ...(r.readOnly ? { readOnly: true } : {}) }));
    const myVols = real.map((r) => ({ name: r.name, ...srcObj(r.tp, r.src) }));
    // Preserve volumes owned by OTHER containers (not referenced by this one).
    const prevOwned = new Set(volumeMounts.map((m) => m.name).filter(Boolean));
    const otherVols = volumes.filter((v) => !prevOwned.has(v.name));
    lastEmit.current = snap(real);
    onChange(myMounts, [...otherVols, ...myVols]);
  };

  const setField = (id: number, patch: Partial<Row>) => emit(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.length === 0 && <Text type="secondary">{t('editor.noMounts')}</Text>}
      {rows.map((r) => (
        <div key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Select
            style={{ width: 110, flex: '0 0 auto' }}
            value={r.tp}
            options={TYPES.map((x) => ({
              value: x,
              label:
                x === 'configMap' ? t('nav.configmaps')
                  : x === 'secret' ? t('nav.secrets')
                    : x === 'persistentVolumeClaim' ? t('nav.pvcs')
                      : t('editor.emptyDir'),
            }))}
            onChange={(tp: VolType) => setField(r.id, { tp, src: '' })}
          />
          {r.tp === 'emptyDir' ? (
            <Input disabled value="—" style={{ width: 170, flex: '0 0 auto' }} />
          ) : (
            <AutoComplete
              style={{ width: 170, flex: '0 0 auto' }}
              value={r.src}
              placeholder={t('editor.source')}
              options={opts(r.tp)}
              filterOption={(input, opt) => String(opt?.value ?? '').toLowerCase().includes(input.toLowerCase())}
              onChange={(src) => setField(r.id, { src })}
            />
          )}
          <Input
            style={{ flex: '1 1 180px', minWidth: 0, fontFamily: token.fontFamilyCode }}
            value={r.mountPath}
            placeholder="/etc/config"
            onChange={(e) => setField(r.id, { mountPath: e.target.value })}
          />
          <Checkbox checked={r.readOnly} onChange={(e) => setField(r.id, { readOnly: e.target.checked })}>
            {t('editor.readOnly')}
          </Checkbox>
          <Button
            type="text"
            icon={<DeleteOutlined />}
            aria-label={t('editor.remove')}
            style={{ color: token.colorTextTertiary }}
            onClick={() => emit(rows.filter((x) => x.id !== r.id))}
          />
        </div>
      ))}
      <Button
        type="dashed"
        size="small"
        icon={<PlusOutlined />}
        onClick={() => emit([...rows, blank()])}
        style={{ alignSelf: 'flex-start' }}
      >
        {t('editor.addMount')}
      </Button>
    </div>
  );
}
