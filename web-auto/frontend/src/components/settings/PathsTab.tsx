import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Box, Button, TextField, Typography } from '@mui/material';
import { setGlobalConfig, type GlobalConfig } from '../../api/config';
import { useToast } from '../common/ToastProvider';

interface PathsTabProps {
  config: GlobalConfig;
  onSaved: (config: GlobalConfig) => void;
}

function stripTrailingSlashes(value: string): string {
  return String(value || '').replace(/\/+$/, '');
}

function pathInsideRoots(path: string, roots: string[]): boolean {
  const cleanPath = stripTrailingSlashes(path);
  return roots.some((root) => {
    const cleanRoot = stripTrailingSlashes(String(root || ''));
    return cleanPath === cleanRoot || cleanPath.startsWith(`${cleanRoot}/`);
  });
}

function pathInsideRoot(path: string, root: string): boolean {
  const cleanPath = stripTrailingSlashes(path);
  const cleanRoot = stripTrailingSlashes(root);
  return Boolean(cleanPath && cleanRoot && (cleanPath === cleanRoot || cleanPath.startsWith(`${cleanRoot}/`)));
}

function normalizeHostPathInput(path: string): string {
  const clean = String(path || '').trim().replace(/\/+$/, '');
  if (clean.startsWith('media/')) return `/${clean}`;
  return clean;
}

function suggestDataRootForUploadTarget(path: string): string {
  const clean = stripTrailingSlashes(path);
  const parts = clean.split('/').filter(Boolean);
  const uploadsIndex = parts.lastIndexOf('uploads');
  if (uploadsIndex > 0) {
    return `/${parts.slice(0, uploadsIndex).join('/')}`;
  }
  return clean;
}

function shellQuote(value: string): string {
  return `'${String(value || '').replaceAll("'", "'\\''")}'`;
}

export function PathsTab({ config, onSaved }: PathsTabProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();

  const [cacheDir, setCacheDir] = useState('');
  const [uploadTarget, setUploadTarget] = useState('');
  const [newDataRoot, setNewDataRoot] = useState('');
  const [saving, setSaving] = useState(false);
  const mountTextRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setCacheDir(config.cache_dir || '');
    setUploadTarget(config.upload_target_dir || config.upload_root || '');
  }, [config]);

  const allowedRoots = config.allowed_data_roots || [];

  const mountPanel = useMemo(() => {
    const uploadTargetClean = normalizeHostPathInput(uploadTarget);
    const explicitRoot = normalizeHostPathInput(newDataRoot);
    const uploadTargetNeedsMount = Boolean(uploadTargetClean && !pathInsideRoots(uploadTargetClean, allowedRoots));
    const dataRoot = explicitRoot || (uploadTargetNeedsMount ? suggestDataRootForUploadTarget(uploadTargetClean) : '');
    if (!dataRoot) return null;
    const uploadTargetInsideDataRoot = Boolean(uploadTargetClean && pathInsideRoot(uploadTargetClean, dataRoot));
    const addArgs = uploadTargetInsideDataRoot
      ? `--upload-target ${shellQuote(uploadTargetClean)}`
      : '--default';
    const doctorTarget = uploadTargetInsideDataRoot ? uploadTargetClean : dataRoot;
    const command = [
      'cd ~/zmb_work/sam3',
      `./deploy.sh data-root add ${shellQuote(dataRoot)} ${addArgs}`,
      `./deploy.sh data-root doctor ${shellQuote(doctorTarget)}`,
    ].join('\n');
    const title =
      uploadTargetNeedsMount && !explicitRoot
        ? t('mount_command_title')
        : t('mount_command_generated_title');
    return { title, command };
  }, [uploadTarget, newDataRoot, allowedRoots, t]);

  const savePathSettings = async () => {
    const cacheDirValue = cacheDir.trim();
    const uploadTargetValue = uploadTarget.trim();
    if (uploadTargetValue && !pathInsideRoots(uploadTargetValue, allowedRoots)) {
      showToast(t('upload_target_not_mounted', { path: uploadTargetValue }), 'error');
      return;
    }
    setSaving(true);
    try {
      const res = await setGlobalConfig({
        cache_dir: cacheDirValue,
        upload_target_dir: uploadTargetValue,
      });
      const cfg = res.config || config || {};
      onSaved(cfg);
      showToast(t('settings_saved_restart_optional'), 'success');
    } catch (e) {
      showToast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const copyMountCommand = async () => {
    const command = mountPanel?.command || '';
    if (!command) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(command);
      } else {
        const el = mountTextRef.current;
        if (el) {
          el.focus();
          el.select();
          document.execCommand('copy');
        }
      }
      showToast(t('command_copied'), 'success');
    } catch {
      showToast(t('copy_failed'), 'error');
    }
  };

  const labelSx = { fontWeight: 600, fontSize: 13, mb: 1 };
  const hintSx = { fontSize: 12, color: 'text.secondary', mt: 1 };

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 3 }}>
        {t('settings_paths')}
      </Typography>
      <Box sx={{ display: 'grid', gap: '18px' }}>
        <Box>
          <Typography component="label" sx={labelSx}>
            {t('cache_dir')}
          </Typography>
          <TextField
            fullWidth
            value={cacheDir}
            onChange={(e) => setCacheDir(e.target.value)}
            placeholder="/absolute/path/to/data"
          />
        </Box>
        <Box>
          <Typography component="label" sx={labelSx}>
            {t('upload_root')}
          </Typography>
          <TextField fullWidth value={config.upload_root || ''} slotProps={{ input: { readOnly: true } }} />
          <Typography sx={hintSx}>{t('upload_root_readonly_hint')}</Typography>
        </Box>
        <Box>
          <Typography component="label" sx={labelSx}>
            {t('allowed_data_roots')}
          </Typography>
          <TextField
            fullWidth
            multiline
            minRows={4}
            value={(config.allowed_data_roots || []).join('\n')}
            slotProps={{
              input: { readOnly: true, sx: { resize: 'vertical', fontFamily: 'inherit' } },
            }}
          />
          <Typography sx={hintSx}>{t('allowed_data_roots_hint')}</Typography>
        </Box>
        <Box>
          <Typography component="label" sx={labelSx}>
            {t('upload_target_dir')}
          </Typography>
          <TextField
            fullWidth
            value={uploadTarget}
            onChange={(e) => setUploadTarget(e.target.value)}
            placeholder="/home/enabot/datasets"
          />
          <Typography sx={hintSx}>{t('upload_target_hint')}</Typography>
        </Box>
        <Box>
          <Typography component="label" sx={labelSx}>
            {t('new_data_root')}
          </Typography>
          <TextField
            fullWidth
            value={newDataRoot}
            onChange={(e) => setNewDataRoot(e.target.value)}
            placeholder="/media/enabot/disk/zmb_datas"
          />
          <Typography sx={hintSx}>{t('new_data_root_hint')}</Typography>
        </Box>
        {mountPanel && (
          <Alert
            severity="warning"
            variant="outlined"
            icon={false}
            sx={{ display: 'block', p: 2 }}
          >
            <Typography sx={{ fontSize: 13, fontWeight: 800, color: '#d97706', mb: 1 }}>
              {mountPanel.title}
            </Typography>
            <Typography sx={{ fontSize: 12, color: 'text.secondary', lineHeight: 1.5, mb: 1.25 }}>
              {t('mount_command_hint')}
            </Typography>
            <TextField
              fullWidth
              multiline
              minRows={5}
              value={mountPanel.command}
              slotProps={{
                input: {
                  readOnly: true,
                  sx: {
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    fontSize: 12,
                    resize: 'vertical',
                  },
                },
              }}
              inputRef={mountTextRef}
            />
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1.5 }}>
              <Button variant="outlined" onClick={copyMountCommand}>
                {t('copy_command')}
              </Button>
            </Box>
          </Alert>
        )}
      </Box>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 3 }}>
        <Button variant="contained" disabled={saving} onClick={savePathSettings}>
          {t('save')}
        </Button>
      </Box>
    </Box>
  );
}
