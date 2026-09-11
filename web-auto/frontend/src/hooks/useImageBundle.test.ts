import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Annotation } from '../api/types';

const { getImageBundleMock } = vi.hoisted(() => ({ getImageBundleMock: vi.fn() }));

vi.mock('../api/images', () => ({
  getImageBundle: getImageBundleMock,
}));

import * as bundleCache from '../api/bundleCache';
import { loadImageBundle } from './useImageBundle';
import { useProjectStore } from '../stores/workspace/projectStore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function annotation(id: string): Annotation {
  return { id, class_name: 'human face', bbox: [0, 0, 10, 10] };
}

describe('image bundle refresh', () => {
  beforeEach(() => {
    getImageBundleMock.mockReset();
    bundleCache.clearBundleCache();
    useProjectStore.getState().reset();
    useProjectStore.setState({
      projectId: 'project-1',
      images: [{ id: 'image-1', rel_path: 'image.jpg' }],
    });
  });

  it('does not let an invalidated request overwrite a fresh annotation bundle', async () => {
    const stale = deferred<{ annotations: Annotation[]; preview_info: { status: string } }>();
    const fresh = deferred<{ annotations: Annotation[]; preview_info: { status: string } }>();
    getImageBundleMock
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);

    const staleLoad = loadImageBundle('project-1', 'image-1');
    bundleCache.invalidateBundle('project-1', 'image-1');
    const freshLoad = loadImageBundle('project-1', 'image-1', { forceRefresh: true });

    fresh.resolve({ annotations: [annotation('kept')], preview_info: { status: 'ready' } });
    await freshLoad;
    stale.resolve({
      annotations: [annotation('kept'), annotation('already-deleted')],
      preview_info: { status: 'ready' },
    });
    await staleLoad;

    expect(bundleCache.getCachedBundle('project-1', 'image-1')?.annotations?.map((ann) => ann.id))
      .toEqual(['kept']);
    expect(getImageBundleMock).toHaveBeenCalledTimes(2);
    expect(getImageBundleMock.mock.calls[1]?.[2]).toMatchObject({ cache: 'no-store' });
  });
});
