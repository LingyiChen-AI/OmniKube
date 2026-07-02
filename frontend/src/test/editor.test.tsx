import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './render';
import {
  toYAML,
  fromYAML,
  decodeBase64,
  encodeBase64,
  forcePrimaryKeys,
} from '../components/editor/util';
import { buildSideBySide, hasNoChange } from '../components/editor/diff';
import { getResourceForm, kindFromResource } from '../components/editor/forms';
import KeyValueEditor, {
  recordToRows,
  rowsToRecord,
  type KVRow,
} from '../components/editor/KeyValueEditor';
import SecretForm from '../components/editor/forms/SecretForm';
import type { K8sObject } from '../api/resource';

// Capabilities resolve via meApi; grant config write so SecretForm is editable.
vi.mock('../api/me', () => ({
  meApi: { capabilities: vi.fn().mockResolvedValue({ config: ['write'] }) },
}));

describe('editor util — YAML round-trip and primary-key forcing', () => {
  const obj: K8sObject = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'web', namespace: 'default', labels: { app: 'web' } },
    spec: { replicas: 3, template: { spec: { containers: [{ name: 'c', image: 'nginx:1' }] } } },
  };

  it('toYAML → fromYAML preserves the object (visual↔YAML sync)', () => {
    const text = toYAML(obj);
    const back = fromYAML(text);
    expect(back).toEqual(obj);
  });

  it('fromYAML throws on invalid YAML', () => {
    expect(() => fromYAML('key: : : bad')).toThrow();
  });

  it('forcePrimaryKeys keeps apiVersion/kind/name/namespace from the original', () => {
    const tampered: K8sObject = {
      apiVersion: 'v2',
      kind: 'Hacked',
      metadata: { name: 'evil', namespace: 'kube-system', labels: { x: 'y' } },
      spec: { replicas: 9 },
    };
    const out = forcePrimaryKeys(tampered, obj);
    expect(out.apiVersion).toBe('apps/v1');
    expect(out.kind).toBe('Deployment');
    expect(out.metadata?.name).toBe('web');
    expect(out.metadata?.namespace).toBe('default');
    // Non-key edits survive.
    expect(out.spec?.replicas).toBe(9);
    expect(out.metadata?.labels).toEqual({ x: 'y' });
  });
});

describe('editor base64 helpers (Secret)', () => {
  it('decode and encode round-trip, including UTF-8', () => {
    expect(decodeBase64('aGVsbG8=')).toBe('hello');
    expect(encodeBase64('hello')).toBe('aGVsbG8=');
    const s = 'p@ss·密码';
    expect(decodeBase64(encodeBase64(s))).toBe(s);
  });

  it('decode returns the input unchanged on invalid base64', () => {
    expect(decodeBase64('@@@not base64@@@')).toBe('@@@not base64@@@');
  });
});

describe('diff side-by-side', () => {
  it('reports no change for identical YAML', () => {
    const a = toYAML({ a: 1, b: 2 });
    expect(hasNoChange(a, a)).toBe(true);
  });

  it('detects an added/changed line', () => {
    const before = toYAML({ a: 1, b: 2 });
    const after = toYAML({ a: 1, b: 3, c: 4 });
    expect(hasNoChange(before, after)).toBe(false);
    const rows = buildSideBySide(before, after);
    expect(rows.some((r) => r.type !== 'equal')).toBe(true);
  });
});

describe('forms registry', () => {
  it('maps supported kinds to a form and unsupported kinds to null', () => {
    expect(getResourceForm('Deployment')).toBeTypeOf('function');
    expect(getResourceForm('Service')).toBeTypeOf('function');
    expect(getResourceForm('Secret')).toBeTypeOf('function');
    expect(getResourceForm('Pod')).toBeTypeOf('function');
    expect(getResourceForm('Job')).toBeTypeOf('function');
    expect(getResourceForm('CronJob')).toBeTypeOf('function');
    expect(getResourceForm('PersistentVolumeClaim')).toBeTypeOf('function');
    expect(getResourceForm('PersistentVolume')).toBeTypeOf('function');
    // Nodes stay YAML-only (not user-created).
    expect(getResourceForm('Node')).toBeNull();
    expect(getResourceForm(undefined)).toBeNull();
  });

  it('derives Kind from plural resource', () => {
    expect(kindFromResource('deployments')).toBe('Deployment');
    expect(kindFromResource('secrets')).toBe('Secret');
    expect(kindFromResource('unknowns')).toBeUndefined();
  });
});

describe('KeyValueEditor add/remove', () => {
  function Harness({ initial }: { initial: KVRow[] }) {
    const [rows, setRows] = useState<KVRow[]>(initial);
    return (
      <div>
        <KeyValueEditor rows={rows} onChange={setRows} />
        <output data-testid="json">{JSON.stringify(rowsToRecord(rows))}</output>
      </div>
    );
  }

  it('adds a row and edits its key/value, then removes it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initial={recordToRows({ app: 'web' })} />);

    expect(screen.getByTestId('json').textContent).toBe('{"app":"web"}');

    // Add a blank row.
    await user.click(screen.getByRole('button', { name: /add/i }));
    const keyInputs = screen.getAllByPlaceholderText('Key');
    const valueInputs = screen.getAllByPlaceholderText('Value');
    expect(keyInputs).toHaveLength(2);

    await user.type(keyInputs[1], 'tier');
    await user.type(valueInputs[1], 'frontend');
    expect(JSON.parse(screen.getByTestId('json').textContent!)).toEqual({
      app: 'web',
      tier: 'frontend',
    });

    // Remove the first row.
    const removeButtons = screen.getAllByRole('button', { name: /remove/i });
    await user.click(removeButtons[0]);
    expect(JSON.parse(screen.getByTestId('json').textContent!)).toEqual({ tier: 'frontend' });
  });
});

describe('SecretForm base64 round-trip', () => {
  function Harness() {
    const [draft, setDraft] = useState<K8sObject>({
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      metadata: { name: 's', namespace: 'default' },
      data: { password: encodeBase64('s3cr3t') },
    });
    return (
      <div>
        <SecretForm draft={draft} onChange={setDraft} />
        <output data-testid="data">{JSON.stringify(draft.data)}</output>
      </div>
    );
  }

  it('shows decoded values and re-encodes to base64 on edit', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    // Value is shown decoded.
    const valueInput = screen.getByDisplayValue('s3cr3t');
    expect(valueInput).toBeTruthy();

    // Type a new char; the stored data must stay base64-encoded.
    await user.clear(valueInput);
    await user.type(valueInput, 'newpass');
    await waitFor(() => {
      const data = JSON.parse(screen.getByTestId('data').textContent!);
      expect(decodeBase64(data.password)).toBe('newpass');
      expect(data.password).toBe(encodeBase64('newpass'));
    });
  });
});
