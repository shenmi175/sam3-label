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
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { createProject } from '../../api/projects';
import { useToast } from '../common/ToastProvider';

export interface CreateProjectPrefill {
  project_type?: string;
  name?: string;
  image_dir?: string;
}

interface CreateProjectDialogProps {
  open: boolean;
  prefill: CreateProjectPrefill;
  onClose: () => void;
  onCreated: () => void;
}

export function CreateProjectDialog({ open, prefill, onClose, onCreated }: CreateProjectDialogProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();

  const [projectType, setProjectType] = useState('image');
  const [name, setName] = useState('');
  const [imageDir, setImageDir] = useState('');
  const [classes, setClasses] = useState('');
  const [saveDir, setSaveDir] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  // Replicates openCreateModal + clearCreateForm + applyProjectTypeDefaults
  useEffect(() => {
    if (!open) return;
    const type = prefill.project_type || 'image';
    setProjectType(type);
    setName(prefill.name || '');
    setImageDir(prefill.image_dir || '');
    setSaveDir('');
    setClasses(type === 'pose' ? 'person_pose' : '');
    setTimeout(() => nameInputRef.current?.focus(), 0);
  }, [open, prefill]);

  const applyProjectTypeDefaults = (type: string, currentClasses: string): string => {
    if (type === 'pose') {
      return currentClasses.trim() ? currentClasses : 'person_pose';
    }
    return currentClasses.trim() === 'person_pose' ? '' : currentClasses;
  };

  const handleTypeChange = (type: string) => {
    setProjectType(type);
    setClasses((prev) => applyProjectTypeDefaults(type, prev));
  };

  const classesPlaceholder = projectType === 'pose' ? 'person_pose' : 'cat\ndog\nperson face';

  const submitProject = async () => {
    setSubmitting(true);
    try {
      const payload: {
        name: string;
        project_type: string;
        image_dir: string;
        classes_text: string;
        save_dir?: string;
      } = {
        name,
        project_type: projectType || 'image',
        image_dir: imageDir,
        classes_text: classes.replace(/\r\n?/g, '\n'),
      };
      const saveDirValue = saveDir.trim();
      if (saveDirValue) payload.save_dir = saveDirValue;

      await createProject(payload);
      onCreated();
      onClose();
      showToast(t('save_success'));
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const labelSx = { fontSize: 13, fontWeight: 600, mb: 1 };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pr: 6 }}>
        {t('new_project')}
        <IconButton onClick={onClose} sx={{ position: 'absolute', right: 10, top: 10, color: 'error.main' }}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, pt: '8px !important' }}>
        <Box>
          <Typography component="label" sx={labelSx}>
            {t('project_type')}
          </Typography>
          <TextField select fullWidth value={projectType} onChange={(e) => handleTypeChange(e.target.value)}>
            <MenuItem value="image">{t('image_annotation_project')}</MenuItem>
            <MenuItem value="pose">{t('pose_annotation_project')}</MenuItem>
          </TextField>
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
            inputRef={nameInputRef}
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
            placeholder="/absolute/path/to/images"
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
            placeholder={classesPlaceholder}
            slotProps={{ input: { sx: { resize: 'vertical' } } }}
          />
        </Box>
        <Box>
          <Typography component="label" sx={labelSx}>
            {t('save_dir')}
          </Typography>
          <TextField fullWidth value={saveDir} onChange={(e) => setSaveDir(e.target.value)} placeholder="..." />
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button
          variant="contained"
          disabled={submitting}
          onClick={submitProject}
          sx={{ minWidth: 120, fontWeight: 700 }}
        >
          {submitting ? t('creating') : t('create_btn')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
