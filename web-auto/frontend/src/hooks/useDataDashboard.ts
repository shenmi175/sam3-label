import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getAnnotationDashboard,
  migrateAnnotationLayout,
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
 * flow: fetch /annotation_dashboard on open, migrate-annotation-layout
 * (dry-run confirm → execute) and rebuild-index actions with the legacy
 * toasts, then refresh project info + image list.
 */
export function useDataDashboard(projectId: string, open: boolean) {
  const { t } = useTranslation();
  const { loadImages } = useImageNavigation();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [migrating, setMigrating] = useState(false);
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

  const migrate = useCallback(async () => {
    if (!projectId || migrating) return;
    try {
      setMigrating(true);
      const preview = await migrateAnnotationLayout(projectId, true);
      const planned = Number(preview?.moved || 0);
      const conflicts = Number(preview?.conflicts || 0);
      if (planned <= 0 && conflicts <= 0) {
        toast(t('dashboard_migrate_uptodate'), 'success');
        return;
      }
      if (!window.confirm(t('dashboard_migrate_confirm', { planned, conflicts }))) return;
      const result = await migrateAnnotationLayout(projectId, false);
      toast(
        t('dashboard_migrate_done', {
          moved: Number(result?.moved || 0),
          conflicts: Number(result?.conflicts || 0),
          failed: Number(result?.failed || 0),
        }),
        result?.failed ? 'error' : 'success',
      );
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setMigrating(false);
    }
  }, [projectId, migrating, reload, t]);

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

  return { stats, loading, error, migrating, rebuilding, reload, migrate, rebuild };
}
