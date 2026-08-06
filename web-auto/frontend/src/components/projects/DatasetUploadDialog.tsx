import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  LinearProgress,
  TextField,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { uploadDatasetFile, refreshImages } from '../../api/projects';
import { useToast } from '../common/ToastProvider';
import { formatBytes, joinServerPath } from './utils';

interface DatasetUploadDialogProps {
  open: boolean;
  /** Absolute dataset directory prefilled from the project card ('' when opened from header). */
  initialTargetDir: string;
  /** Project id when uploading from a project card's "add data" action. */
  targetProjectId: string;
  /** Hint under the target dir input (upload_root_hint or the load error message). */
  hintText: string;
  onClose: () => void;
  onProjectsMaybeChanged: () => void;
  onCreateProjectFromUpload: (imageDir: string) => void;
}

export function DatasetUploadDialog({
  open,
  initialTargetDir,
  targetProjectId,
  hintText,
  onClose,
  onProjectsMaybeChanged,
  onCreateProjectFromUpload,
}: DatasetUploadDialogProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();

  const [targetDir, setTargetDir] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressStatus, setProgressStatus] = useState('');
  const [showCreateButton, setShowCreateButton] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const filesInputRef = useRef<HTMLInputElement | null>(null);
  const activeXhrRef = useRef<XMLHttpRequest | null>(null);
  const cancelRef = useRef(false);
  const filesRef = useRef<File[]>([]);
  filesRef.current = files;
  const targetDirRef = useRef('');
  targetDirRef.current = targetDir;

  // webkitdirectory is not in React's typed input attributes; set it whenever the node mounts
  // (MUI Dialog recreates its children each time it opens).
  const attachFolderInput = (node: HTMLInputElement | null) => {
    folderInputRef.current = node;
    if (node) {
      node.setAttribute('webkitdirectory', '');
      node.setAttribute('directory', '');
    }
  };

  // Replicates showDatasetUpload(): prefill target dir, reset progress/buttons.
  useEffect(() => {
    if (!open) return;
    cancelRef.current = false;
    activeXhrRef.current = null;
    setTargetDir((prev) => initialTargetDir || prev || '');
    setShowCreateButton(false);
    setUploading(false);
    setProgressPercent(0);
    setProgressStatus(t('upload_idle'));
  }, [open, initialTargetDir, t]);

  // Abort in-flight upload when the dialog unmounts (old unmount behavior).
  useEffect(() => {
    return () => {
      if (activeXhrRef.current) activeXhrRef.current.abort();
    };
  }, []);

  const updateProgress = (percent: number, statusText: string) => {
    const safePercent = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    setProgressPercent(safePercent);
    setProgressStatus(statusText || '');
  };

  const setDatasetFiles = (fileList: FileList | null) => {
    const list = Array.from(fileList || []);
    setFiles(list);
    if (!list.length) {
      return;
    }
    updateProgress(0, t('upload_ready'));
  };

  const clearDatasetFiles = () => {
    setFiles([]);
    if (folderInputRef.current) folderInputRef.current.value = '';
    if (filesInputRef.current) filesInputRef.current.value = '';
    updateProgress(0, t('upload_idle'));
  };

  const getUploadedImageDir = (): string => {
    const dir = targetDirRef.current.trim();
    const prefixes = new Set<string>();
    for (const file of filesRef.current) {
      const rel = String(file.webkitRelativePath || '').replace(/\\/g, '/');
      const parts = rel.split('/').filter(Boolean);
      if (parts.length > 1) prefixes.add(parts[0]);
    }
    const prefixList = Array.from(prefixes);
    if (prefixList.length === 1 && !targetProjectId) {
      return joinServerPath(dir, prefixList[0]);
    }
    return dir;
  };

  const startDatasetUpload = async () => {
    const dir = targetDir.trim();
    const currentFiles = files;
    if (!dir) {
      showToast(t('upload_target_required'), 'error');
      return;
    }
    if (!currentFiles.length) {
      showToast(t('upload_files_required'), 'error');
      return;
    }

    const totalBytes = currentFiles.reduce((sum, file) => sum + (file.size || 0), 0);
    let completedBytes = 0;
    cancelRef.current = false;
    setUploading(true);
    setShowCreateButton(false);

    try {
      for (let idx = 0; idx < currentFiles.length; idx += 1) {
        if (cancelRef.current) throw new Error(t('upload_canceled'));
        const file = currentFiles[idx];
        const relativePath = file.webkitRelativePath || file.name;
        await uploadDatasetFile({
          file,
          targetDir: dir,
          relativePath,
          overwrite,
          onXhr: (xhr) => {
            activeXhrRef.current = xhr;
          },
          onProgress: (loaded) => {
            const percent =
              totalBytes > 0
                ? ((completedBytes + loaded) / totalBytes) * 100
                : ((idx + 1) / currentFiles.length) * 100;
            updateProgress(percent, t('uploading_file', { index: idx + 1, count: currentFiles.length, name: file.name }));
          },
        });
        completedBytes += file.size || 0;
        activeXhrRef.current = null;
      }

      updateProgress(100, t('upload_done', { count: currentFiles.length }));
      setShowCreateButton(true);
      if (targetProjectId) {
        try {
          await refreshImages(targetProjectId);
          onProjectsMaybeChanged();
        } catch (e) {
          showToast((e as Error).message, 'error');
        }
      }
      showToast(t('upload_done', { count: currentFiles.length }));
    } catch (e) {
      updateProgress(0, t('upload_failed', { error: (e as Error).message }));
      showToast(t('upload_failed', { error: (e as Error).message }), 'error');
    } finally {
      activeXhrRef.current = null;
      setUploading(false);
    }
  };

  // Cancel in-flight upload, or simply close the dialog.
  const cancelOrClose = () => {
    if (activeXhrRef.current) {
      cancelRef.current = true;
      activeXhrRef.current.abort();
      return;
    }
    onClose();
  };

  const summary = files.length
    ? t('upload_selected', {
        count: files.length,
        size: formatBytes(files.reduce((sum, file) => sum + (file.size || 0), 0)),
      })
    : t('upload_no_files');

  const labelSx = { fontSize: 13, fontWeight: 600, mb: 1 };

  return (
    <Dialog open={open} onClose={cancelOrClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pr: 6 }}>
        {t('upload_dataset_title')}
        <IconButton onClick={cancelOrClose} sx={{ position: 'absolute', right: 10, top: 10, color: 'error.main' }}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, pt: '8px !important' }}>
        <Box>
          <Typography component="label" sx={labelSx}>
            {t('upload_target_dir')}
          </Typography>
          <TextField
            fullWidth
            value={targetDir}
            onChange={(e) => setTargetDir(e.target.value)}
            placeholder="/home/enabot/datasets/my-dataset"
          />
          {hintText && (
            <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 1 }}>{hintText}</Typography>
          )}
        </Box>

        <Box>
          <Typography component="label" sx={labelSx}>
            {t('upload_source')}
          </Typography>
          <Box
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              setDatasetFiles(e.dataTransfer.files);
            }}
            sx={{
              minHeight: 134,
              border: '2px dashed',
              borderColor: 'divider',
              borderRadius: 2,
              bgcolor: dragOver ? 'action.hover' : 'transparent',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 1.75,
              p: 2.5,
            }}
          >
            <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>{summary}</Typography>
            <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', justifyContent: 'center' }}>
              <Button variant="outlined" onClick={() => folderInputRef.current?.click()}>
                {t('select_folder')}
              </Button>
              <Button variant="outlined" onClick={() => filesInputRef.current?.click()}>
                {t('select_files')}
              </Button>
              <Button variant="outlined" onClick={clearDatasetFiles}>
                {t('clear')}
              </Button>
            </Box>
            <input
              ref={attachFolderInput}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => setDatasetFiles(e.target.files)}
            />
            <input
              ref={filesInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => setDatasetFiles(e.target.files)}
            />
          </Box>
        </Box>

        <FormControlLabel
          control={<Checkbox checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />}
          label={<Typography sx={{ fontSize: 13, fontWeight: 600 }}>{t('overwrite_existing')}</Typography>}
        />

        <Box>
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 1.5,
              fontSize: 12,
              color: 'text.secondary',
              mb: 1,
            }}
          >
            <Typography component="span" sx={{ fontSize: 12, color: 'text.secondary' }}>
              {progressStatus}
            </Typography>
            <Typography component="span" sx={{ fontSize: 12, color: 'text.secondary' }}>
              {progressPercent}%
            </Typography>
          </Box>
          <LinearProgress variant="determinate" value={progressPercent} sx={{ height: 10, borderRadius: 999 }} />
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
        {showCreateButton ? (
          <Button variant="outlined" onClick={() => onCreateProjectFromUpload(getUploadedImageDir())}>
            {t('create_from_uploaded')}
          </Button>
        ) : (
          <Box />
        )}
        <Box sx={{ display: 'flex', gap: 1.5 }}>
          <Button onClick={cancelOrClose}>{t('cancel')}</Button>
          <Button
            variant="contained"
            disabled={uploading}
            onClick={startDatasetUpload}
            sx={{ minWidth: 120, fontWeight: 700 }}
          >
            {uploading ? t('uploading_short') : t('start_upload')}
          </Button>
        </Box>
      </DialogActions>
    </Dialog>
  );
}
