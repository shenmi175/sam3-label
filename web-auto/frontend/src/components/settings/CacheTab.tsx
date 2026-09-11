import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  Typography,
} from '@mui/material';
import {
  cleanupCache,
  getCacheStatus,
  type CacheScope,
  type CacheStatus,
  type CacheUsage,
} from '../../api/cache';
import { clearBundleCache } from '../../api/bundleCache';
import { useToast } from '../common/ToastProvider';

const SCOPES: CacheScope[] = ['previews', 'tiles', 'composites'];

function formatBytes(value: number): string {
  const bytes = Math.max(0, Number(value || 0));
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let amount = bytes;
  let unit = -1;
  do {
    amount /= 1024;
    unit += 1;
  } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}

function emptyUsage(): CacheUsage {
  return { file_count: 0, directory_count: 0, logical_bytes: 0, disk_bytes: 0 };
}

export function CacheTab() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [status, setStatus] = useState<CacheStatus | null>(null);
  const [selected, setSelected] = useState<Record<CacheScope, boolean>>({
    previews: true,
    tiles: true,
    composites: true,
  });
  const [loading, setLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await getCacheStatus());
    } catch (e) {
      showToast((e as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selectedScopes = useMemo(() => SCOPES.filter((scope) => selected[scope]), [selected]);
  const selectedUsage = useMemo(
    () => selectedScopes.reduce(
      (total, scope) => {
        const usage = status?.scopes[scope] || emptyUsage();
        total.file_count += usage.file_count;
        total.logical_bytes += usage.logical_bytes;
        total.disk_bytes += usage.disk_bytes;
        return total;
      },
      emptyUsage(),
    ),
    [selectedScopes, status],
  );

  const runCleanup = async () => {
    if (!selectedScopes.length) return;
    setCleaning(true);
    try {
      const result = await cleanupCache(selectedScopes);
      clearBundleCache();
      setStatus(result.status);
      setConfirmOpen(false);
      showToast(
        t('cache_cleanup_done', {
          size: formatBytes(result.released.disk_bytes),
          count: result.released.file_count,
        }),
        'success',
      );
    } catch (e) {
      showToast((e as Error).message, 'error');
    } finally {
      setCleaning(false);
    }
  };

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 1 }}>
        {t('settings_cache')}
      </Typography>
      <Typography sx={{ color: 'text.secondary', fontSize: 13, mb: 2.5 }}>
        {t('cache_cleanup_intro')}
      </Typography>

      <Alert severity="info" variant="outlined" sx={{ mb: 2.5 }}>
        {t('cache_cleanup_safe_hint')}
      </Alert>

      <Box sx={{ display: 'grid', gap: 1.5 }}>
        {SCOPES.map((scope) => {
          const usage = status?.scopes[scope] || emptyUsage();
          return (
            <Box
              key={scope}
              sx={{
                border: '1px solid',
                borderColor: selected[scope] ? 'primary.main' : 'divider',
                borderRadius: 1.5,
                px: 2,
                py: 1.5,
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) auto',
                gap: 2,
                alignItems: 'center',
              }}
            >
              <Box>
                <FormControlLabel
                  control={(
                    <Checkbox
                      checked={selected[scope]}
                      onChange={(event) => setSelected((current) => ({
                        ...current,
                        [scope]: event.target.checked,
                      }))}
                    />
                  )}
                  label={t(`cache_scope_${scope}`)}
                  sx={{ '& .MuiFormControlLabel-label': { fontWeight: 700 } }}
                />
                <Typography sx={{ ml: 4.5, fontSize: 12, color: 'text.secondary' }}>
                  {t(`cache_scope_${scope}_hint`)}
                </Typography>
              </Box>
              <Box sx={{ textAlign: 'right', minWidth: 130 }}>
                <Typography sx={{ fontWeight: 800, fontSize: 14 }}>
                  {formatBytes(usage.disk_bytes)}
                </Typography>
                <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
                  {t('cache_usage_detail', {
                    logical: formatBytes(usage.logical_bytes),
                    count: usage.file_count,
                  })}
                </Typography>
              </Box>
            </Box>
          );
        })}
      </Box>

      <Typography sx={{ mt: 2, fontSize: 12, color: 'text.secondary', overflowWrap: 'anywhere' }}>
        {t('cache_data_dir')}: {status?.data_dir || '--'}
      </Typography>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: 3, gap: 2 }}>
        <Typography sx={{ fontSize: 13, fontWeight: 700 }}>
          {t('cache_selected_total', {
            size: formatBytes(selectedUsage.disk_bytes),
            count: selectedUsage.file_count,
          })}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1.5 }}>
          <Button variant="outlined" disabled={loading || cleaning} onClick={refresh}>
            {loading ? t('cache_loading') : t('cache_refresh')}
          </Button>
          <Button
            variant="contained"
            color="warning"
            disabled={!selectedScopes.length || loading || cleaning}
            onClick={() => setConfirmOpen(true)}
          >
            {cleaning ? t('cache_cleaning') : t('cache_cleanup_button')}
          </Button>
        </Box>
      </Box>

      <Dialog open={confirmOpen} onClose={() => !cleaning && setConfirmOpen(false)}>
        <DialogTitle>{t('cache_cleanup_confirm_title')}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t('cache_cleanup_confirm', {
              size: formatBytes(selectedUsage.disk_bytes),
              count: selectedUsage.file_count,
            })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button disabled={cleaning} onClick={() => setConfirmOpen(false)}>{t('cancel')}</Button>
          <Button color="warning" variant="contained" disabled={cleaning} onClick={runCleanup}>
            {cleaning ? t('cache_cleaning') : t('cache_cleanup_button')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
