export function makeImageBundleKey(projectId, imageId) {
  return `${projectId || ''}:${String(imageId || '')}`;
}

export function makeImageBundle(id, relPath, imageInfo, annotations) {
  if (!id || !imageInfo) return null;
  return {
    id: String(id),
    relPath: relPath || '',
    imageInfo,
    annotations: Array.isArray(annotations) ? annotations : [],
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

export function storeBundleInCache(cache, key, id, relPath, imageInfo, annotations, limit = 8) {
  const bundle = makeImageBundle(id, relPath, imageInfo, annotations);
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
