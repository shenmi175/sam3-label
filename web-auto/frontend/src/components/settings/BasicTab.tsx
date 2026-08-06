import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, MenuItem, TextField, Typography } from '@mui/material';
import { setGlobalConfig, type GlobalConfig } from '../../api/config';
import { useSettingsStore, type ThemeMode } from '../../stores/settingsStore';
import { useToast } from '../common/ToastProvider';

interface BasicTabProps {
  config: GlobalConfig;
  onSaved: (config: GlobalConfig) => void;
  onReload: () => void;
}

export function BasicTab({ config, onSaved, onReload }: BasicTabProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const settings = useSettingsStore();

  const [samUrl, setSamUrl] = useState('');
  const [locateUrl, setLocateUrl] = useState('');
  const [backend, setBackend] = useState('sam3');
  const [score, setScore] = useState('0.5');
  const [lang, setLang] = useState('zh');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [threshold, setThreshold] = useState('0.5');
  const [batch, setBatch] = useState('10');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const s = useSettingsStore.getState();
    setSamUrl(s.sam3ApiUrl || config.sam3_api_base_url || '');
    setLocateUrl(s.locateApiUrl || config.locate_api_base_url || '');
    setBackend(s.defaultBackend || 'sam3');
    setScore(String(s.scoreDefault ?? 0.5));
    setLang(s.language || 'zh');
    setTheme(s.themeMode || 'light');
    setThreshold(String(s.threshold ?? 0.5));
    setBatch(String(s.batchSize ?? 10));
  }, [config]);

  const samAllowed = config.allowed_sam3_api_base_urls || [];
  const locateAllowed = config.allowed_locate_api_base_urls || [];

  const saveBasicSettings = async () => {
    const langChanged = lang !== settings.language;
    const samUrlValue = samUrl.trim();
    const locateUrlValue = locateUrl.trim();
    setSaving(true);
    try {
      const res = await setGlobalConfig({
        sam3_api_base_url: samUrlValue,
        locate_api_base_url: locateUrlValue,
      });
      const cfg = res.config || config || {};
      settings.set('sam3ApiUrl', cfg.sam3_api_base_url || samUrlValue);
      settings.set('locateApiUrl', cfg.locate_api_base_url || locateUrlValue);
      setSamUrl(useSettingsStore.getState().sam3ApiUrl || '');
      setLocateUrl(useSettingsStore.getState().locateApiUrl || '');
      settings.set('defaultBackend', backend);
      settings.set('language', lang);
      settings.set('themeMode', theme as ThemeMode);
      settings.set('threshold', Number(threshold));
      settings.set('batchSize', Number(batch));
      settings.set('scoreDefault', Number(score));
      showToast(t('settings_saved'), 'success');
      onSaved(cfg);
      if (langChanged) onReload();
    } catch (e) {
      showToast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const labelSx = { fontWeight: 600, fontSize: 13, mb: 1 };

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 3 }}>
        {t('settings_basic')}
      </Typography>
      <Box sx={{ display: 'grid', gap: '18px' }}>
        <Box>
          <Typography component="label" sx={labelSx}>
            {t('sam_api_url')}
          </Typography>
          <TextField
            fullWidth
            value={samUrl}
            onChange={(e) => setSamUrl(e.target.value)}
          />
          {samAllowed.length > 0 && (
            <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 1 }}>
              {t('allowed_sam_urls', { urls: samAllowed.join(', ') })}
            </Typography>
          )}
        </Box>
        <Box>
          <Typography component="label" sx={labelSx}>
            {t('locate_api_url')}
          </Typography>
          <TextField
            fullWidth
            value={locateUrl}
            onChange={(e) => setLocateUrl(e.target.value)}
          />
          {locateAllowed.length > 0 && (
            <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 1 }}>
              {t('allowed_locate_urls', { urls: locateAllowed.join(', ') })}
            </Typography>
          )}
        </Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 2 }}>
          <Box>
            <Typography component="label" sx={labelSx}>
              {t('default_backend')}
            </Typography>
            <TextField select fullWidth value={backend} onChange={(e) => setBackend(e.target.value)}>
              <MenuItem value="sam3">{t('sam3_backend')}</MenuItem>
              <MenuItem value="locate-anything">{t('locate_backend')}</MenuItem>
            </TextField>
          </Box>
          <Box>
            <Typography component="label" sx={labelSx}>
              {t('score_default')}
            </Typography>
            <TextField
              fullWidth
              type="number"
              value={score}
              onChange={(e) => setScore(e.target.value)}
              slotProps={{ htmlInput: { min: 0, max: 1, step: 0.01 } }}
            />
          </Box>
        </Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 2 }}>
          <Box>
            <Typography component="label" sx={labelSx}>
              {t('language')}
            </Typography>
            <TextField select fullWidth value={lang} onChange={(e) => setLang(e.target.value)}>
              <MenuItem value="zh">简体中文</MenuItem>
              <MenuItem value="en">English</MenuItem>
            </TextField>
          </Box>
          <Box>
            <Typography component="label" sx={labelSx}>
              {t('theme')}
            </Typography>
            <TextField
              select
              fullWidth
              value={theme}
              onChange={(e) => setTheme(e.target.value as 'light' | 'dark')}
            >
              <MenuItem value="light">{t('theme_light')}</MenuItem>
              <MenuItem value="dark">{t('theme_dark')}</MenuItem>
            </TextField>
          </Box>
        </Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 2 }}>
          <Box>
            <Typography component="label" sx={labelSx}>
              {t('threshold')}
            </Typography>
            <TextField
              fullWidth
              type="number"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              slotProps={{ htmlInput: { min: 0, max: 1, step: 0.01 } }}
            />
          </Box>
          <Box>
            <Typography component="label" sx={labelSx}>
              {t('batch_size')}
            </Typography>
            <TextField
              fullWidth
              type="number"
              value={batch}
              onChange={(e) => setBatch(e.target.value)}
              slotProps={{ htmlInput: { min: 1, max: 32, step: 1 } }}
            />
          </Box>
        </Box>
      </Box>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 3 }}>
        <Button variant="contained" disabled={saving} onClick={saveBasicSettings}>
          {t('save')}
        </Button>
      </Box>
    </Box>
  );
}
