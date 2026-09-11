import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useNavigationGuardStore } from '../../stores/workspace/navigationGuardStore';

export function UnsavedChangesDialog() {
  const { t } = useTranslation();
  const open = useNavigationGuardStore((state) => state.open);
  const decide = useNavigationGuardStore((state) => state.decide);
  return (
    <Dialog open={open} onClose={() => decide('cancel')} maxWidth="xs" fullWidth>
      <DialogTitle>{t('unsaved_changes_title')}</DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: 13 }}>{t('unsaved_changes_message')}</Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => decide('cancel')}>{t('cancel')}</Button>
        <Button color="error" onClick={() => decide('discard')}>{t('discard_and_continue')}</Button>
        <Button variant="contained" onClick={() => decide('save')}>{t('save_and_continue')}</Button>
      </DialogActions>
    </Dialog>
  );
}
