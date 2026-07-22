export function makeImageBundleKey(projectId, imageId) {
  return `${projectId || ''}:${String(imageId || '')}`;
}

export function makeImageBundle(id, relPath, imageInfo, annotations, previewInfo = null, flags = {}) {
  if (!id) return null;
  return {
    id: String(id),
    relPath: relPath || '',
    imageInfo,
    previewInfo,
    annotations: Array.isArray(annotations) ? annotations : [],
    annotationsLoaded: Boolean(flags.annotationsLoaded),
    previewLoaded: Boolean(flags.previewLoaded),
    tileInfoLoaded: Boolean(flags.tileInfoLoaded),
    cachedAt: Date.now(),
  };
}

export function bundleSatisfies(bundle, requirements = {}) {
  if (!bundle) return false;
  if (requirements.annotations && !bundle.annotationsLoaded) return false;
  if (requirements.preview && !bundle.previewLoaded) return false;
  if (requirements.tileInfo && !bundle.tileInfoLoaded) return false;
  return true;
}

export function mergeImageBundle(existing, incoming) {
  if (!incoming) return existing || null;
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
    relPath: incoming.relPath || existing.relPath || '',
    imageInfo: incoming.imageInfo || existing.imageInfo || null,
    previewInfo: incoming.previewInfo || existing.previewInfo || null,
    annotations: incoming.annotationsLoaded ? incoming.annotations : (existing.annotations || []),
    annotationsLoaded: Boolean(existing.annotationsLoaded || incoming.annotationsLoaded),
    previewLoaded: Boolean(existing.previewLoaded || incoming.previewLoaded),
    tileInfoLoaded: Boolean(existing.tileInfoLoaded || incoming.tileInfoLoaded),
    cachedAt: Date.now(),
  };
}

export function touchBundleCache(cache, key, bundle, limit = 8) {
  if (!key || !bundle) return cache || null;
  const nextCache = cache || new Map();
  nextCache.delete(key);
  nextCache.set(key, bundle);
  while (nextCache.size > limit) {
    const oldestKey = nextCache.keys().next().value;
    nextCache.delete(oldestKey);
  }
  return nextCache;
}

export function getBundleFromCache(cache, key) {
  return cache?.get(key) || null;
}

export function storeBundleInCache(cache, key, id, relPath, imageInfo, annotations, previewInfo = null, flags = {}, limit = 8) {
  const incoming = makeImageBundle(id, relPath, imageInfo, annotations, previewInfo, flags);
  const bundle = mergeImageBundle(cache?.get(key), incoming);
  return touchBundleCache(cache, key, bundle, limit);
}

export function invalidateBundleState(cache, promises, key) {
  cache?.delete(key);
  promises?.delete(key);
}

export function clearBundleState(cache, promises) {
  cache?.clear();
  promises?.clear();
}
