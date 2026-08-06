import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, TextField, Typography } from '@mui/material';
import { changePassword } from '../../api/system';
import { useToast } from '../common/ToastProvider';

export function AccountTab() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (newPassword !== confirmPassword) {
      showToast(t('password_confirm_mismatch'), 'error');
      return;
    }
    setSubmitting(true);
    try {
      await changePassword(currentPassword, newPassword);
      showToast(t('password_changed_login_again'), 'success');
      setTimeout(() => {
        window.location.href = '/login';
      }, 800);
    } catch (e) {
      showToast((e as Error).message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const labelSx = { fontWeight: 600, fontSize: 13, mb: 1 };

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 3 }}>
        {t('account')}
      </Typography>
      <Box sx={{ display: 'grid', gap: '18px' }}>
        <Box>
          <Typography component="label" sx={labelSx}>
            {t('current_password')}
          </Typography>
          <TextField
            fullWidth
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            slotProps={{ htmlInput: { autoComplete: 'current-password' } }}
          />
        </Box>
        <Box>
          <Typography component="label" sx={labelSx}>
            {t('new_password')}
          </Typography>
          <TextField
            fullWidth
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            slotProps={{ htmlInput: { autoComplete: 'new-password' } }}
          />
        </Box>
        <Box>
          <Typography component="label" sx={labelSx}>
            {t('confirm_password')}
          </Typography>
          <TextField
            fullWidth
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            slotProps={{ htmlInput: { autoComplete: 'new-password' } }}
          />
        </Box>
      </Box>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 3 }}>
        <Button variant="contained" disabled={submitting} onClick={submit}>
          {t('change_password')}
        </Button>
      </Box>
    </Box>
  );
}
