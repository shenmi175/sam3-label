import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  TextField,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import {
  discoverProjects,
  importExistingProject,
  type DiscoveryCandidate,
  type ImportExistingPayload,
} from '../../api/projects';
import { useToast } from '../common/ToastProvider';

interface RestoreProjectDialogProps {
  open: boolean;
  defaultScanRoot: string;
  onClose: () => void;
  onImported: () => void;
}

export function RestoreProjectDialog({ open, defaultScanRoot, onClose, onImported }: RestoreProjectDialogProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();

  const [scanRoot, setScanRoot] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanInfo, setScanInfo] = useState('');
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([]);

  const [outputDir, setOutputDir] = useState('');
  const [imageDir, setImageDir] = useState('');
  const [name, setName] = useState('');
  const [classes, setClasses] = useState('');
  const [manifestPath, setManifestPath] = useState('');
  const [projectType, setProjectType] = useState('');
  const [importing, setImporting] = useState(false);

  const imageDirRef = useRef<HTMLInputElement | null>(null);

  // Replicates openRestoreModal: reset all fields, prefill scan root from upload config
  useEffect(() => {
    if (!open) return;
    setOutputDir('');
    setImageDir('');
    setName('');
    setClasses('');
    setManifestPath('');
    setProjectType('');
    setScanRoot(defaultScanRoot);
    setScanInfo('');
    setCandidates([]);
  }, [open, defaultScanRoot]);

  const scanExistingProjects = async () => {
    setScanning(true);
    try {
      const data = await discoverProjects(scanRoot.trim(), 8);
      setCandidates(data.candidates || []);
      const roots = (data.scan_roots || [])
        .map((item) => {
          const suffix = item.exists && item.is_dir ? '' : ' (not found)';
          return `${item.path}${suffix}`;
        })
        .join(', ');
      setScanInfo(roots ? t('scanned_roots', { roots }) : '');
    } catch (e) {
      showToast((e as Error).message, 'error');
    } finally {
      setScanning(false);
    }
  };

  const runImport = async (payload: ImportExistingPayload) => {
    if (!payload.output_dir && !payload.manifest_path) {
      showToast(t('existing_project_output_dir'), 'error');
      return;
    }
    setImporting(true);
    try {
      await importExistingProject(payload);
      onImported();
      onClose();
      showToast(t('restore_success'));
    } catch (e) {
      showToast((e as Error).message, 'error');
    } finally {
      setImporting(false);
    }
  };

  const selectDiscoveredProject = (item: DiscoveryCandidate) => {
    if (!item || item.imported) return;
    setOutputDir(item.output_dir || '');
    setImageDir(item.image_dir || '');
    setName(item.name || '');
    setManifestPath(item.manifest_path || '');
    setProjectType(item.project_type || '');
    setTimeout(() => imageDirRef.current?.focus(), 0);
    // manifest branch: auto-import right away; legacy branch: wait for image dir input
    if (!item.requires_image_dir && item.manifest_path) {
      runImport({
        output_dir: item.output_dir || '',
        manifest_path: item.manifest_path || '',
        image_dir: item.image_dir || '',
        name: item.name || '',
        classes_text: classes.replace(/\r\n?/g, '\n'),
        project_type: item.project_type || '',
      });
    }
  };

  const submitRestore = () => {
    runImport({
      output_dir: outputDir.trim(),
      manifest_path: manifestPath.trim(),
      image_dir: imageDir.trim(),
      name: name.trim(),
      classes_text: classes.replace(/\r\n?/g, '\n'),
      project_type: projectType.trim(),
    });
  };

  const labelSx = { fontSize: 13, fontWeight: 600, mb: 1 };
  const hintSx = { fontSize: 12, color: 'text.secondary', mt: 1 };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ pr: 6, pb: 0.5 }}>
        {t('restore_project_title')}
        <IconButton onClick={onClose} sx={{ position: 'absolute', right: 10, top: 10, color: 'error.main' }}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ pt: 1 }}>
        <Typography sx={{ fontSize: 13, color: 'text.secondary', mb: 2.5, lineHeight: 1.5 }}>
          {t('restore_project_desc')}
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'minmax(0,1fr) minmax(0,1fr)' }, gap: 2.25 }}>
          {/* Left: scan & discovered candidates */}
          <Box sx={{ display: 'grid', gap: 1.75, alignContent: 'start', minWidth: 0 }}>
            <Box>
              <Typography component="label" sx={labelSx}>
                {t('scan_root')}
              </Typography>
              <TextField
                fullWidth
                value={scanRoot}
                onChange={(e) => setScanRoot(e.target.value)}
                placeholder="/mnt/datasets/openimg"
              />
              <Typography sx={hintSx}>{t('scan_root_hint')}</Typography>
            </Box>
            <Box sx={{ justifySelf: 'start' }}>
              <Button variant="contained" disabled={scanning} onClick={scanExistingProjects} sx={{ fontWeight: 700 }}>
                {scanning ? t('scanning_existing_projects') : t('scan_existing_projects')}
              </Button>
            </Box>
            {scanInfo && (
              <Typography sx={{ fontSize: 12, color: 'text.secondary', overflowWrap: 'anywhere' }}>
                {scanInfo}
              </Typography>
            )}
            <Box sx={{ display: 'grid', gap: 1.5, maxHeight: 360, overflowY: 'auto', pr: 0.5 }}>
              {candidates.length === 0 ? (
                <Typography sx={{ p: 2.25, color: 'text.secondary' }}>{t('no_existing_projects')}</Typography>
              ) : (
                candidates.map((item, index) => {
                  const kind =
                    item.kind === 'manifest'
                      ? t('existing_project_kind_manifest')
                      : t('existing_project_kind_legacy');
                  const status = item.imported
                    ? t('existing_project_imported')
                    : item.requires_image_dir
                      ? t('existing_project_requires_image_dir')
                      : '';
                  return (
                    <Box
                      key={`${item.output_dir}-${index}`}
                      sx={{
                        p: 1.75,
                        display: 'grid',
                        gap: 1.25,
                        borderRadius: 2,
                        bgcolor: 'action.hover',
                        border: '1px solid',
                        borderColor: 'divider',
                      }}
                    >
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1.5, alignItems: 'start' }}>
                        <Box sx={{ minWidth: 0 }}>
                          <Typography sx={{ fontWeight: 800, overflowWrap: 'anywhere' }}>
                            {item.name || item.project_id || ''}
                          </Typography>
                          <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5 }}>
                            {kind} · {Number(item.annotation_count || 0)} JSON
                          </Typography>
                        </Box>
                        <Button
                          disabled={item.imported}
                          onClick={() => selectDiscoveredProject(item)}
                          sx={{ flexShrink: 0 }}
                        >
                          {t('import_existing_project')}
                        </Button>
                      </Box>
                      <Typography sx={{ fontSize: 12, color: 'text.secondary', overflowWrap: 'anywhere' }}>
                        {item.output_dir || ''}
                      </Typography>
                      {status && (
                        <Typography
                          sx={{ fontSize: 12, color: item.imported ? '#48bb78' : 'primary.main' }}
                        >
                          {status}
                        </Typography>
                      )}
                    </Box>
                  );
                })
              )}
            </Box>
          </Box>

          {/* Right: manual import form (manifest / legacy branches) */}
          <Box sx={{ display: 'grid', gap: 1.75, alignContent: 'start', minWidth: 0 }}>
            <Box>
              <Typography component="label" sx={labelSx}>
                {t('existing_project_output_dir')}
              </Typography>
              <TextField
                fullWidth
                value={outputDir}
                onChange={(e) => setOutputDir(e.target.value)}
                placeholder="/path/to/prj_xxxxx"
              />
            </Box>
            <Box>
              <Typography component="label" sx={labelSx}>
                {t('image_dir')}
              </Typography>
              <TextField
                fullWidth
                value={imageDir}
                onChange={(e) => setImageDir(e.target.value)}
                placeholder="/path/to/images"
                inputRef={imageDirRef}
              />
              <Typography sx={hintSx}>{t('existing_project_image_dir_hint')}</Typography>
            </Box>
            <Box>
              <Typography component="label" sx={labelSx}>
                {t('project_name')}
              </Typography>
              <TextField
                fullWidth
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('project_name')}
              />
            </Box>
            <Box>
              <Typography component="label" sx={labelSx}>
                {t('initial_classes')}
              </Typography>
              <TextField
                fullWidth
                multiline
                minRows={4}
                value={classes}
                onChange={(e) => setClasses(e.target.value)}
                placeholder={'cat\ndog\nperson face'}
                slotProps={{ input: { sx: { resize: 'vertical' } } }}
              />
            </Box>
          </Box>
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={importing}
          onClick={submitRestore}
          sx={{ minWidth: 120, fontWeight: 700 }}
        >
          {importing ? t('importing_existing_project') : t('import_existing_project')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
