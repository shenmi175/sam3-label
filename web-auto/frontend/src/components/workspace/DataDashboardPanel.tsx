import { Box, Button, Dialog, IconButton, LinearProgress, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useDataDashboard, type DashboardClassRow, type DashboardDensityRow } from '../../hooks/useDataDashboard';

interface DataDashboardPanelProps {
  projectId: string;
  open: boolean;
  onClose: () => void;
}

const fmt = (value: unknown) => Number(value || 0).toLocaleString();

const pct = (part: unknown, total: unknown) => {
  const totalNum = Number(total || 0);
  return totalNum > 0 ? `${((Number(part || 0) / totalNum) * 100).toFixed(1)}%` : '0.0%';
};

function Bar({ label, value, maxValue, sub = '' }: { label: string; value: number; maxValue: number; sub?: string }) {
  const width = maxValue > 0 ? Math.max(2, Math.min(100, (Number(value || 0) / maxValue) * 100)) : 0;
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 180px) 1fr auto', gap: 1.25, alignItems: 'center' }}>
      <Typography title={label} sx={{ fontWeight: 700, fontSize: 12 }} noWrap>
        {label}
      </Typography>
      <Box sx={{ height: 10, borderRadius: 999, bgcolor: 'action.hover', overflow: 'hidden' }}>
        <Box sx={{ width: `${width}%`, height: '100%', borderRadius: 999, bgcolor: 'primary.main' }} />
      </Box>
      <Typography sx={{ fontSize: 12, color: 'text.secondary', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {fmt(value)}
        {sub}
      </Typography>
    </Box>
  );
}

/**
 * Data dashboard dialog — 1:1 port of the legacy data-dashboard-panel.js +
 * DataDashboardController render: summary cards, class instance distribution
 * (top 30), per-image density buckets and the rebuild-index action.
 */
export function DataDashboardPanel({ projectId, open, onClose }: DataDashboardPanelProps) {
  const { t } = useTranslation();
  const { stats, loading, error, rebuilding, rebuild } = useDataDashboard(projectId, open);

  const classes: DashboardClassRow[] = Array.isArray(stats?.classes) ? (stats?.classes as DashboardClassRow[]) : [];
  const density: DashboardDensityRow[] = Array.isArray(stats?.annotation_density)
    ? (stats?.annotation_density as DashboardDensityRow[])
    : [];
  const maxClassInstances = Math.max(1, ...classes.map((row) => Number(row.instance_count || 0)));
  const maxDensity = Math.max(1, ...density.map((row) => Number(row.image_count || 0)));
  const topClasses = classes.slice(0, 30);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <Box sx={{ p: 3.5, position: 'relative', maxHeight: '90vh', overflowY: 'auto' }}>
        <IconButton
          size="small"
          onClick={onClose}
          aria-label={t('close')}
          sx={{ position: 'absolute', top: 14, right: 14, color: '#ef4444' }}
        >
          {'\u00D7'}
        </IconButton>
        <Typography sx={{ fontSize: 18, fontWeight: 800, mb: 2 }}>{t('data_dashboard')}</Typography>

        {loading && <LinearProgress sx={{ mb: 2 }} />}
        {error && <Typography sx={{ color: '#ef4444', fontSize: 12 }}>{error}</Typography>}
        {!loading && !error && !stats && (
          <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{t('loading_images')}</Typography>
        )}

        {stats && !error && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>
            {stats.needs_rebuild && (
              <Box sx={{ p: 1.5, borderRadius: 1.5, bgcolor: 'rgba(245,158,11,0.12)', lineHeight: 1.7, fontSize: 12 }}>
                {t('dashboard_rebuild_hint')}
              </Box>
            )}

            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 1.5 }}>
              <Box sx={{ p: 1.75, borderRadius: 2, border: '1px solid', borderColor: 'divider' }}>
                <Typography sx={{ color: 'text.secondary', fontSize: 12 }}>{t('dashboard_total_images')}</Typography>
                <Typography sx={{ fontSize: 22, fontWeight: 800 }}>{fmt(stats.total_images)}</Typography>
              </Box>
              <Box sx={{ p: 1.75, borderRadius: 2, border: '1px solid', borderColor: 'divider' }}>
                <Typography sx={{ color: 'text.secondary', fontSize: 12 }}>{t('dashboard_labeled_images')}</Typography>
                <Typography sx={{ fontSize: 22, fontWeight: 800, color: '#10b981' }}>{fmt(stats.labeled_images)}</Typography>
                <Typography sx={{ fontSize: 11 }}>{pct(stats.labeled_images, stats.total_images)}</Typography>
              </Box>
              <Box sx={{ p: 1.75, borderRadius: 2, border: '1px solid', borderColor: 'divider' }}>
                <Typography sx={{ color: 'text.secondary', fontSize: 12 }}>{t('dashboard_instance_count')}</Typography>
                <Typography sx={{ fontSize: 22, fontWeight: 800 }}>{fmt(stats.annotation_count)}</Typography>
              </Box>
              <Box sx={{ p: 1.75, borderRadius: 2, border: '1px solid', borderColor: 'divider' }}>
                <Typography sx={{ color: 'text.secondary', fontSize: 12 }}>{t('dashboard_sqlite_annotations')}</Typography>
                <Typography sx={{ fontSize: 22, fontWeight: 800 }}>{fmt(stats.annotation_store_images)}</Typography>
                <Typography sx={{ fontSize: 11 }}>{pct(stats.annotation_store_images, stats.total_images)}</Typography>
              </Box>
            </Box>

            <Box sx={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 2 }}>
              <Box sx={{ p: 2, borderRadius: 2, border: '1px solid', borderColor: 'divider', display: 'flex', flexDirection: 'column', gap: 1.25 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Typography sx={{ fontSize: 14, fontWeight: 700 }}>{t('dashboard_class_dist')}</Typography>
                  <Typography sx={{ color: 'text.secondary', fontSize: 12 }}>
                    {topClasses.length}/{classes.length}
                  </Typography>
                </Box>
                {topClasses.length ? (
                  topClasses.map((row, idx) => (
                    <Bar
                      key={`${row.class_name || idx}`}
                      label={String(row.class_name || '--')}
                      value={Number(row.instance_count || 0)}
                      maxValue={maxClassInstances}
                      sub={` / ${fmt(row.image_count)}${t('dashboard_images_unit')}`}
                    />
                  ))
                ) : (
                  <Typography sx={{ color: 'text.secondary', py: 2.5 }}>{t('dashboard_no_class_data')}</Typography>
                )}
              </Box>
              <Box sx={{ p: 2, borderRadius: 2, border: '1px solid', borderColor: 'divider', display: 'flex', flexDirection: 'column', gap: 1.25 }}>
                <Typography sx={{ fontSize: 14, fontWeight: 700 }}>{t('dashboard_density')}</Typography>
                {density.map((row, idx) => (
                  <Bar
                    key={`${row.bucket || idx}`}
                    label={String(row.bucket || '--')}
                    value={Number(row.image_count || 0)}
                    maxValue={maxDensity}
                  />
                ))}
              </Box>
            </Box>

            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1.25 }}>
              <Button
                size="small"
                variant="outlined"
                disabled={rebuilding}
                onClick={() => void rebuild()}
                sx={{ fontWeight: 700, fontSize: 12, color: 'primary.main' }}
              >
                {rebuilding ? t('rebuilding_index') : t('rebuild_annotation_index')}
              </Button>
            </Box>
          </Box>
        )}
      </Box>
    </Dialog>
  );
}
