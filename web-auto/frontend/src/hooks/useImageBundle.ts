import { getImageBundle } from '../api/images';
import * as bundleCache from '../api/bundleCache';
import type { Annotation, ImageBundle, ImageInfo, PreviewInfo, TileInfo } from '../api/types';
import { useProjectStore } from '../stores/workspace/projectStore';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Legacy imagePrefetchRadius. */
export const PREFETCH_RADIUS = 10;

export interface LoadBundleOptions {
  signal?: AbortSignal;
  includeAnnotations?: boolean;
  includePreview?: boolean;
  includeTileInfo?: boolean;
  /** Low priority, non-enqueued background prefetch. */
  background?: boolean;
}

// ─── Core (plain functions — used by stores and the hook) ────────────────────

function makePromiseKey(
  projectId: string,
  imageId: string,
  includeAnnotations: boolean,
  includePreview: boolean,
): string {
  const key = bundleCache.makeImageBundleKey(projectId, imageId);
  return `${key}:${includeAnnotations ? 'ann' : 'noann'}:${includePreview ? 'preview' : 'nopreview'}`;
}

function findImageInfo(imageId: string): ImageInfo | null {
  const { images } = useProjectStore.getState();
  return images.find((img) => String(img.id) === String(imageId)) || null;
}

/**
 * Cache → in-flight dedup → fetch → store. 1:1 port of the legacy
 * `loadImageBundle` flow on the God Object. Returns the merged cached bundle
 * after the load, or null when the request fails.
 */
export async function loadImageBundle(
  projectId: string,
  imageId: string,
  options: LoadBundleOptions = {},
): Promise<ImageBundle | null> {
  const includeAnnotations = options.includeAnnotations !== false;
  const includePreview = options.includePreview !== false;
  const includeTileInfo = Boolean(options.includeTileInfo);

  const requirements = { annotations: includeAnnotations, preview: includePreview };
  const cached = bundleCache.getCachedBundle(projectId, imageId);
  if (bundleCache.bundleSatisfies(cached, requirements)) return cached;

  const promiseKey = makePromiseKey(projectId, imageId, includeAnnotations, includePreview);
  const inflight = bundleCache.getInflightPromise(promiseKey);
  if (inflight) return inflight;

  const promise = (async () => {
    const resp = await getImageBundle(
      projectId,
      imageId,
      { signal: options.signal },
      {
        includeAnnotations,
        includePreview,
        includeTileInfo,
        priority: options.background ? 'low' : 'high',
        enqueue: !options.background,
      },
    );
    const imageInfo = findImageInfo(imageId);
    bundleCache.storeBundle(
      projectId,
      imageId,
      String(imageInfo?.rel_path || ''),
      imageInfo,
      (resp?.annotations || []) as Annotation[],
      (resp?.preview_info || null) as PreviewInfo | null,
      {
        annotationsLoaded: includeAnnotations,
        previewLoaded: includePreview && Boolean(resp?.preview_info),
        tileInfoLoaded: includeTileInfo && Boolean(resp?.tile_info),
      },
    );
    // Store tile info on the merged bundle when requested.
    if (includeTileInfo && resp?.tile_info) {
      const merged = bundleCache.getCachedBundle(projectId, imageId);
      if (merged) {
        merged.tileInfo = resp.tile_info as TileInfo;
      }
    }
    return bundleCache.getCachedBundle(projectId, imageId);
  })();

  bundleCache.setInflightPromise(promiseKey, promise);
  try {
    return await promise;
  } catch (err) {
    if (!options.background) throw err;
    return null;
  }
}

/**
 * Warm bundles for neighbors of the selected image within PREFETCH_RADIUS.
 * Legacy behavior: annotations are only prefetched for distance ≤ 1; preview
 * info is prefetched for the whole radius. Fire-and-forget.
 */
export async function prefetchNeighbors(projectId: string, selectedImageId?: string): Promise<void> {
  const { images } = useProjectStore.getState();
  const currentId = selectedImageId ?? '';
  if (!projectId || !images.length || !currentId) return;
  const index = images.findIndex((img) => String(img.id) === String(currentId));
  if (index < 0) return;
  const tasks: Promise<unknown>[] = [];
  for (let delta = -PREFETCH_RADIUS; delta <= PREFETCH_RADIUS; delta += 1) {
    if (delta === 0) continue;
    const target = images[index + delta];
    if (!target) continue;
    const includeAnnotations = Math.abs(delta) <= 1;
    tasks.push(
      loadImageBundle(projectId, String(target.id), {
        includeAnnotations,
        includePreview: true,
        background: true,
      }),
    );
  }
  await Promise.allSettled(tasks);
}

// ─── Hook facade ─────────────────────────────────────────────────────────────

/**
 * React facade over the bundle loader. Components rarely need it directly —
 * imageStore.selectImage drives the main load — but panels that refresh a
 * single image (e.g. after inference) can call reload().
 */
export function useImageBundle() {
  return {
    loadImageBundle,
    prefetchNeighbors,
    getCachedBundle: bundleCache.getCachedBundle,
    invalidateBundle: bundleCache.invalidateBundle,
    clearBundleCache: bundleCache.clearBundleCache,
  };
}
