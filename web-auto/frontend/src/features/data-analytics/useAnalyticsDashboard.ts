import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getAnalyticsDimensions,
  getAnalyticsIndex,
  getAnalyticsOverview,
  rebuildAnalyticsIndex,
  type AnalyticsDimensions,
  type AnalyticsIndexStatus,
  type AnalyticsOverview,
  type AnalyticsSource,
  type AnalyticsTask,
} from '../../api/analytics';

export function useAnalyticsDashboard(projectId: string, task: AnalyticsTask, sources: AnalyticsSource[]) {
  const [index, setIndex] = useState<AnalyticsIndexStatus | null>(null);
  const [dimensions, setDimensions] = useState<AnalyticsDimensions | null>(null);
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const autoStartedRef = useRef(false);
  const requestRef = useRef<AbortController | null>(null);
  const requestSeqRef = useRef(0);
  const sourceKey = sources.join(',');

  const startRebuild = useCallback(async () => {
    if (!projectId) return;
    setError('');
    try {
      await rebuildAnalyticsIndex(projectId);
      const response = await getAnalyticsIndex(projectId);
      setIndex(response.index);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  const reload = useCallback(async () => {
    if (!projectId) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError('');
    try {
      const response = await getAnalyticsIndex(projectId, { signal: controller.signal });
      if (seq !== requestSeqRef.current) return;
      setIndex(response.index);
      if (response.index.status === 'ready' && !response.index.needs_rebuild) {
        const [dimensionData, overviewData] = await Promise.all([
          getAnalyticsDimensions(projectId, { signal: controller.signal }),
          getAnalyticsOverview(projectId, task, sources, { signal: controller.signal }),
        ]);
        if (seq === requestSeqRef.current) {
          setDimensions(dimensionData.dimensions);
          setOverview(overviewData.overview);
        }
      } else {
        setDimensions(null);
        setOverview(null);
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError' && seq === requestSeqRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [projectId, task, sourceKey]); // sourceKey intentionally stabilizes array dependencies

  useEffect(() => {
    autoStartedRef.current = false;
    void reload();
    return () => requestRef.current?.abort();
  }, [reload]);

  useEffect(() => {
    if (!index) return;
    if ((index.status === 'missing' || index.status === 'stale') && !autoStartedRef.current) {
      autoStartedRef.current = true;
      void startRebuild();
      return;
    }
    if (index.status !== 'building') return;
    const timer = window.setInterval(() => void reload(), 1000);
    return () => window.clearInterval(timer);
  }, [index, reload, startRebuild]);

  return { index, dimensions, overview, loading, error, reload, startRebuild };
}
