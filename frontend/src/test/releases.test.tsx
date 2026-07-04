import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './render';
import { parseImageList, splitImageTag, type ReleaseRecord } from '../api/release';

// ---- mocks --------------------------------------------------------------

vi.mock('../store/ctx', () => ({
  useCtxStore: () => ({ currentCluster: 'c1', currentNamespace: null }),
  getCurrentCluster: () => 'c1',
}));

vi.mock('../api/release', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/release')>();
  return { ...actual, releaseApi: { list: vi.fn(), listPaged: vi.fn() } };
});

// EditResourceDrawer dependencies.
vi.mock('../store/caps', () => ({
  useCapabilities: () => ({ can: () => true, loading: false }),
}));

import { releaseApi } from '../api/release';
import Releases from '../pages/releases/Releases';
import EditResourceDrawer from '../components/EditResourceDrawer';
import { resourceApi } from '../api/resource';

const ROW: ReleaseRecord = {
  id: 1,
  user_id: 5,
  username: 'alice',
  cluster_id: 'c1',
  namespace: 'dev',
  kind: 'Deployment',
  name: 'web',
  image_before: 'app=nginx:1.27',
  image_after: 'app=nginx:1.28',
  comment: 'bump nginx for CVE fix',
  created_at: new Date().toISOString(),
};

describe('parseImageList', () => {
  it('parses name=image pairs and tolerates plain images', () => {
    expect(parseImageList('app=nginx:1.27;side=busybox:1')).toEqual([
      { name: 'app', image: 'nginx:1.27' },
      { name: 'side', image: 'busybox:1' },
    ]);
    expect(parseImageList('')).toEqual([]);
    expect(parseImageList('nginx:1')).toEqual([{ name: '', image: 'nginx:1' }]);
  });
});

describe('splitImageTag', () => {
  it('splits repo:tag, ignoring registry ports', () => {
    expect(splitImageTag('nginx:1.28')).toEqual({ repo: 'nginx', tag: '1.28' });
    expect(splitImageTag('registry.cn-chengdu.aliyuncs.com/zhihuige/voc-backend:v0.0.1')).toEqual({
      repo: 'registry.cn-chengdu.aliyuncs.com/zhihuige/voc-backend',
      tag: 'v0.0.1',
    });
    // a colon that precedes a '/' is a registry port, not a tag → no tag
    expect(splitImageTag('registry:5000/app')).toEqual({ repo: 'registry:5000/app', tag: '' });
    expect(splitImageTag('nginx')).toEqual({ repo: 'nginx', tag: '' });
  });
});

describe('Releases page', () => {
  beforeEach(() => {
    (releaseApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([ROW]);
    (releaseApi.listPaged as ReturnType<typeof vi.fn>).mockResolvedValue({ releases: [ROW], total: 1 });
  });

  it('renders a release record row with releaser, images and comment', async () => {
    renderWithProviders(<Releases />);

    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(screen.getByText('web')).toBeInTheDocument();
    // Same repo (nginx) → shown once, with tag-only diff 1.27 → 1.28.
    expect(screen.getByText('nginx')).toBeInTheDocument();
    expect(screen.getByText('1.27')).toBeInTheDocument();
    expect(screen.getByText('1.28')).toBeInTheDocument();
    expect(screen.getByText('bump nginx for CVE fix')).toBeInTheDocument();
  });
});

describe('EditResourceDrawer — workload image change requires a release comment', () => {
  beforeEach(() => {
    vi.spyOn(resourceApi, 'get').mockResolvedValue({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'web', namespace: 'default' },
      spec: { replicas: 2, template: { spec: { containers: [{ name: 'app', image: 'nginx:1.27' }] } } },
    });
    vi.spyOn(resourceApi, 'update').mockResolvedValue({});
  });

  it('opens a required release-note modal and threads the comment to update()', async () => {
    // delay:null removes userEvent's per-keystroke delay (keeps typing fast on
    // slower CI runners, where the default made this test flake past 5s).
    const user = userEvent.setup({ delay: null });
    renderWithProviders(
      <EditResourceDrawer
        open
        resource="deployments"
        kind="Deployment"
        namespace="default"
        name="web"
        onClose={() => undefined}
      />,
    );

    // Wait for the object to load (image input visible).
    const imageInput = await screen.findByDisplayValue('nginx:1.27');
    await user.clear(imageInput);
    await user.type(imageInput, 'nginx:1.28');

    // Save → release-note modal appears (image changed).
    await user.click(screen.getByRole('button', { name: /save/i }));
    const commentBox = await screen.findByLabelText('release-comment');
    expect(commentBox).toBeInTheDocument();
    // update must NOT have been called yet (comment still empty).
    expect(resourceApi.update).not.toHaveBeenCalled();

    await user.type(commentBox, 'security patch');
    await user.click(screen.getByRole('button', { name: /save & release/i }));

    await waitFor(() => expect(resourceApi.update).toHaveBeenCalledTimes(1));
    const args = (resourceApi.update as ReturnType<typeof vi.fn>).mock.calls[0];
    // signature: (ns, resource, name, payload, opts)
    expect(args[4]).toEqual({ releaseComment: 'security patch' });
  });
});
