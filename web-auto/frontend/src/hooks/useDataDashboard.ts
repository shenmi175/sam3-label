import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getAnnotationDashboard,
  rebuildAnnotationIndex,
} from '../api/annotations';
import { useProjectStore } from '../stores/workspace/projectStore';
import { useImageNavigation } from './useImageNavigation';
import { toast } from '../utils/notify';

export interface DashboardClassRow {
  class_name?: string;
  instance_count?: number;
  image_count?: number;
}

export interface DashboardDensityRow {
  bucket?: string;
  image_count?: number;
}

export interface DashboardStats {
  total_images?: number;
  labeled_images?: number;
  annotation_count?: number;
  annotation_store_images?: number;
  needs_rebuild?: boolean;
  classes?: DashboardClassRow[];
  annotation_density?: DashboardDensityRow[];
  [key: string]: unknown;
}

/**
 * Data dashboard data hook — port of the legacy DataDashboardController data
 * flow: fetch /annotation_dashboard on open and the rebuild-index action with
 * the legacy toasts, then refresh project info + image list.
 */
export function useDataDashboard(projectId: string, open: boolean) {
  const { t } = useTranslation();
  const { loadImages } = useImageNavigation();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [rebuilding, setRebuilding] = useState(false);

  const reload = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError('');
    try {
      const res = await getAnnotationDashboard(projectId);
      setStats((res?.stats as DashboardStats) || {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  const rebuild = useCallback(async () => {
    if (!projectId || rebuilding) return;
    if (!window.confirm(t('confirm_rebuild_annotation_index'))) return;
    try {
      setRebuilding(true);
      const res = await rebuildAnnotationIndex(projectId);
      const result = (res?.result || {}) as Record<string, unknown>;
      toast(
        t('dashboard_rebuild_done', {
          count: Number(result.annotation_store_images || result.indexed_images || 0),
        }),
        'success',
      );
      await useProjectStore.getState().loadProjectInfo();
      await loadImages();
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setRebuilding(false);
    }
  }, [projectId, rebuilding, reload, loadImages, t]);

  return { stats, loading, error, rebuilding, reload, rebuild };
}
