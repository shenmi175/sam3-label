import { useEffect, useMemo, useState } from 'react';
import {
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
import { useTranslation } from 'react-i18next';
import type { Annotation } from '../../api/types';
import { useAnnotationStore } from '../../stores/workspace/annotationStore';
import { useProjectStore } from '../../stores/workspace/projectStore';
import { toast } from '../../utils/notify';

export interface AnnotationClassModalProps {
  open: boolean;
  annotation: Annotation | null;
  onClose: () => void;
}

/**
 * Edit-annotation-class modal — 1:1 port of the legacy
 * annotation-class-modal.js: shows the current class, a select of existing
 * classes, an input for a new class (input wins over select). Enter confirms,
 * Escape closes. Confirmation delegates to annotationStore.updateClass which
 * ensures the class exists in the project, marks the annotation manual/dirty
 * and schedules autosave.
 */
export function AnnotationClassModal({ open, annotation, onClose }: AnnotationClassModalProps) {
  const { t } = useTranslation();
  const classes = useProjectStore((s) => s.classes);
  const [selectedClass, setSelectedClass] = useState('');
  const [newClass, setNewClass] = useState('');
  const [saving, setSaving] = useState(false);

  const currentClass = String(annotation?.class_name || '').trim();

  const options = useMemo(() => {
    const all = [currentClass, ...classes.map((c) => String(c || '').trim())].filter(Boolean);
    return Array.from(new Set(all));
  }, [currentClass, classes]);

  useEffect(() => {
    if (open) {
      setSelectedClass(currentClass);
      setNewClass('');
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const confirm = async () => {
    if (!annotation || saving) return;
    const nextClass = newClass.trim() || selectedClass.trim();
    if (!nextClass) {
      toast(t('class_select_or_input_required'), 'error');
      return;
    }
    setSaving(true);
    try {
      const updated = await useAnnotationStore
        .getState()
        .updateClass(String(annotation.id), nextClass);
      if (updated) onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const onEnterConfirm = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void confirm();
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 16, fontWeight: 700, pr: 6 }}>
        {t('edit_ann_class_title')}
        <IconButton
          onClick={onClose}
          size="small"
          sx={{ position: 'absolute', right: 10, top: 10, color: '#ef4444' }}
          aria-label="close"
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.75, pt: 1.5 }}>
        <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
          {t('current_class_label')}：
          <Typography component="b" sx={{ fontWeight: 700, color: 'text.primary' }}>
            {currentClass || '--'}
          </Typography>
        </Typography>
        <TextField
          select
          label={t('select_existing_class')}
          size="small"
          value={selectedClass}
          onChange={(e) => setSelectedClass(e.target.value)}
          onKeyDown={onEnterConfirm}
          fullWidth
        >
          {options.map((cls) => (
            <MenuItem key={cls} value={cls} sx={{ fontSize: 13 }}>
              {cls}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          label={t('or_input_new_class')}
          size="small"
          value={newClass}
          onChange={(e) => setNewClass(e.target.value)}
          onKeyDown={onEnterConfirm}
          placeholder={t('input_new_class_placeholder')}
          autoFocus
          fullWidth
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={saving}>
          {t('cancel')}
        </Button>
        <Button variant="contained" onClick={() => void confirm()} disabled={saving} sx={{ fontWeight: 700 }}>
          {saving ? t('save_status_saving') : t('save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
