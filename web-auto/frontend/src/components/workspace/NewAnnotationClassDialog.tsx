import { useEffect, useState } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, TextField } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../stores/workspace/projectStore';

interface NewAnnotationClassDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: (className: string) => void;
}

export function NewAnnotationClassDialog({ open, onCancel, onConfirm }: NewAnnotationClassDialogProps) {
  const { t } = useTranslation();
  const classes = useProjectStore((state) => state.classes);
  const current = useProjectStore((state) => state.selectedClass);
  const [selected, setSelected] = useState('');
  const [custom, setCustom] = useState('');

  useEffect(() => {
    if (!open) return;
    setSelected(current || classes[0] || '');
    setCustom('');
  }, [open, current, classes]);

  const confirm = () => {
    const value = custom.trim() || selected.trim();
    if (value) onConfirm(value);
  };

  return (
    <Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth>
      <DialogTitle>{t('choose_annotation_class')}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pt: 1.5 }}>
        <TextField select size="small" label={t('select_existing_class')} value={selected} onChange={(event) => setSelected(event.target.value)} autoFocus>
          {classes.map((item, index) => (
            <MenuItem key={item} value={item}>{index < 9 ? `${index + 1}. ` : ''}{item}</MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          label={t('or_input_new_class')}
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          onKeyDown={(event) => {
            if (/^[1-9]$/.test(event.key) && !custom) {
              const item = classes[Number(event.key) - 1];
              if (item) setSelected(item);
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              confirm();
            }
          }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>{t('cancel')}</Button>
        <Button variant="contained" disabled={!(custom.trim() || selected.trim())} onClick={confirm}>{t('save')}</Button>
      </DialogActions>
    </Dialog>
  );
}
