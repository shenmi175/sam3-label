/**
 * Bundle LRU cache — 1:1 port of the seven pure functions from the legacy
 * `js/modules/image-workspace/workspace-state.js`, kept as a module singleton
 * on purpose: the cache holds large payloads (annotations/preview metadata)
 * that components never render directly, so they stay out of the reactive
 * stores. limit = 20 matches the legacy `imageBundleCacheLimit`.
 */
import type { Annotation, ImageBundle, ImageInfo, PreviewInfo } from './types';

export const BUNDLE_CACHE_LIMIT = 20;

export interface BundleRequirements {
  annotations?: boolean;
  preview?: boolean;
  tileInfo?: boolean;
}

export interface BundleFlags {
  annotationsLoaded?: boolean;
  previewLoaded?: boolean;
  tileInfoLoaded?: boolean;
}

// --- module singleton state (not reactive) ---
const bundleCache = new Map<string, ImageBundle>();
const bundlePromises = new Map<string, Promise<ImageBundle | null>>();
let bundleCacheGeneration = 0;
const bundleKeyGenerations = new Map<string, number>();

export function makeImageBundleKey(projectId: string | null, imageId: string | number | null): string {
  return `${projectId || ''}:${String(imageId || '')}`;
}

export function makeImageBundle(
  id: string | number | null,
  relPath: string,
  imageInfo: ImageInfo | null,
  annotations: Annotation[],
  previewInfo: PreviewInfo | null = null,
  flags: BundleFlags = {},
): ImageBundle | null {
  if (!id) return null;
  return {
    id: String(id),
    relPath: relPath || '',
    imageInfo: imageInfo ?? undefined,
    previewInfo: previewInfo ?? undefined,
    annotations: Array.isArray(annotations) ? annotations : [],
    annotationsLoaded: Boolean(flags.annotationsLoaded),
    previewLoaded: Boolean(flags.previewLoaded),
    tileInfoLoaded: Boolean(flags.tileInfoLoaded),
    cachedAt: Date.now(),
  };
}

export function bundleSatisfies(bundle: ImageBundle | null | undefined, requirements: BundleRequirements = {}): boolean {
  if (!bundle) return false;
  if (requirements.annotations && !bundle.annotationsLoaded) return false;
  if (requirements.preview && !bundle.previewLoaded) return false;
  if (requirements.tileInfo && !bundle.tileInfoLoaded) return false;
  return true;
}

export function mergeImageBundle(existing: ImageBundle | null | undefined, incoming: ImageBundle | null): ImageBundle | null {
  if (!incoming) return existing || null;
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
    relPath: incoming.relPath || existing.relPath || '',
    imageInfo: incoming.imageInfo || existing.imageInfo || undefined,
    previewInfo: incoming.previewInfo || existing.previewInfo || undefined,
    annotations: incoming.annotationsLoaded ? incoming.annotations : existing.annotations || [],
    annotationsLoaded: Boolean(existing.annotationsLoaded || incoming.annotationsLoaded),
    previewLoaded: Boolean(existing.previewLoaded || incoming.previewLoaded),
    tileInfoLoaded: Boolean(existing.tileInfoLoaded || incoming.tileInfoLoaded),
    cachedAt: Date.now(),
  };
}

export function touchBundleCache(
  cache: Map<string, ImageBundle>,
  key: string,
  bundle: ImageBundle,
  limit = BUNDLE_CACHE_LIMIT,
): Map<string, ImageBundle> {
  if (!key || !bundle) return cache;
  cache.delete(key);
  cache.set(key, bundle);
  while (cache.size > limit) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  return cache;
}

export function getBundleFromCache(cache: Map<string, ImageBundle>, key: string): ImageBundle | null {
  return cache.get(key) || null;
}

export function storeBundleInCache(
  cache: Map<string, ImageBundle>,
  key: string,
  id: string | number | null,
  relPath: string,
  imageInfo: ImageInfo | null,
  annotations: Annotation[],
  previewInfo: PreviewInfo | null = null,
  flags: BundleFlags = {},
  limit = BUNDLE_CACHE_LIMIT,
): Map<string, ImageBundle> {
  const incoming = makeImageBundle(id, relPath, imageInfo, annotations, previewInfo, flags);
  const bundle = mergeImageBundle(cache.get(key), incoming);
  if (!bundle) return cache;
  return touchBundleCache(cache, key, bundle, limit);
}

export function invalidateBundleState(
  cache: Map<string, ImageBundle>,
  promises: Map<string, Promise<ImageBundle | null>>,
  key: string,
): void {
  cache.delete(key);
  promises.delete(key);
}

export function clearBundleState(
  cache: Map<string, ImageBundle>,
  promises: Map<string, Promise<ImageBundle | null>>,
): void {
  cache.clear();
  promises.clear();
}

// --- singleton accessors used by hooks/stores ---

export function getCachedBundle(projectId: string | null, imageId: string | number | null): ImageBundle | null {
  const key = makeImageBundleKey(projectId, imageId);
  const cached = getBundleFromCache(bundleCache, key);
  if (!cached) return null;
  touchBundleCache(bundleCache, key, cached, BUNDLE_CACHE_LIMIT);
  return cached;
}

export function storeBundle(
  projectId: string | null,
  imageId: string | number | null,
  relPath: string,
  imageInfo: ImageInfo | null,
  annotations: Annotation[],
  previewInfo: PreviewInfo | null = null,
  flags: BundleFlags = {},
): void {
  storeBundleInCache(
    bundleCache,
    makeImageBundleKey(projectId, imageId),
    imageId,
    relPath,
    imageInfo,
    annotations,
    previewInfo,
    flags,
    BUNDLE_CACHE_LIMIT,
  );
}

/** Write updated annotations into the cached bundle (keeps preview/tile flags). */
export function updateBundleAnnotations(
  projectId: string | null,
  imageId: string | number | null,
  relPath: string,
  annotations: Annotation[],
): void {
  const cached = getCachedBundle(projectId, imageId);
  if (!cached) return;
  storeBundle(projectId, imageId, relPath || cached.relPath || '', cached.imageInfo || null, annotations, cached.previewInfo || null, {
    annotationsLoaded: true,
    previewLoaded: Boolean(cached.previewLoaded),
    tileInfoLoaded: Boolean(cached.tileInfoLoaded),
  });
}

export function invalidateBundle(projectId: string | null, imageId: string | number | null): void {
  const key = makeImageBundleKey(projectId, imageId);
  bundleKeyGenerations.set(key, (bundleKeyGenerations.get(key) || 0) + 1);
  invalidateBundleState(bundleCache, bundlePromises, key);
}

export function clearBundleCache(): void {
  bundleCacheGeneration += 1;
  bundleKeyGenerations.clear();
  clearBundleState(bundleCache, bundlePromises);
}

/**
 * Token captured by a bundle request before it starts. A changed token means
 * the request predates an explicit invalidation and must not repopulate the
 * cache with stale annotations when it eventually finishes.
 */
export function getBundleGeneration(
  projectId: string | null,
  imageId: string | number | null,
): string {
  const key = makeImageBundleKey(projectId, imageId);
  return `${bundleCacheGeneration}:${bundleKeyGenerations.get(key) || 0}`;
}

export function getInflightPromise(promiseKey: string): Promise<ImageBundle | null> | undefined {
  return bundlePromises.get(promiseKey);
}

export function setInflightPromise(promiseKey: string, promise: Promise<ImageBundle | null>): void {
  bundlePromises.set(promiseKey, promise);
  const cleanup = () => {
    if (bundlePromises.get(promiseKey) === promise) bundlePromises.delete(promiseKey);
  };
  promise.then(cleanup, cleanup);
}

export function deleteInflightPromise(promiseKey: string): void {
  bundlePromises.delete(promiseKey);
}
