import { useEffect } from 'react';
import { Box, Button, CircularProgress, FormControlLabel, Switch, Tooltip, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useAiAssistant } from '../../hooks/useAiAssistant';
import { useAiAssistantStore } from '../../stores/workspace/aiAssistantStore';
import { useAnnotationStore } from '../../stores/workspace/annotationStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { getSam3Status } from '../../api/system';

export function ReviewToolbar() {
  const { t } = useTranslation();
  const aiEnabled = useAiAssistantStore((state) => state.enabled);
  const aiPreparing = useAiAssistantStore((state) => state.preparing);
  const aiAvailable = useAiAssistantStore((state) => state.available);
  const aiUnavailableReason = useAiAssistantStore((state) => state.unavailableReason);
  const autosaveEnabled = useAnnotationStore((state) => state.autosaveEnabled);
  const saveStatus = useAnnotationStore((state) => state.saveStatus);
  const sam3ApiUrl = useSettingsStore((state) => state.sam3ApiUrl);
  const ai = useAiAssistant();

  useEffect(() => {
    let cancelled = false;
    void getSam3Status(sam3ApiUrl).then((response) => {
      if (cancelled) return;
      const result = (response.result || {}) as Record<string, unknown>;
      const available = Boolean(result.model_loaded && result.instance_interactivity_enabled);
      useAiAssistantStore.getState().set({
        available,
        unavailableReason: available ? '' : (!result.model_loaded ? t('ai_sam3_not_loaded') : t('ai_interactivity_unavailable')),
      });
    }).catch((error) => {
      if (!cancelled) useAiAssistantStore.getState().set({ available: false, unavailableReason: String(error) });
    });
    return () => { cancelled = true; };
  }, [sam3ApiUrl, t]);

  const btnSx = { height: 32, px: 1.25, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 };
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
      <Tooltip title={aiAvailable ? t('ai_toggle_title') : aiUnavailableReason}>
        <span>
          <Button size="small" variant={aiEnabled ? 'contained' : 'outlined'} color="secondary" disabled={!aiAvailable || aiPreparing} onClick={() => void ai.toggle()} sx={btnSx}>
            {aiPreparing ? <CircularProgress size={14} /> : (aiEnabled ? t('ai_on') : t('ai_off'))}
          </Button>
        </span>
      </Tooltip>

      <FormControlLabel
        sx={{ m: 0 }}
        control={<Switch size="small" checked={autosaveEnabled} onChange={(event) => {
          useAnnotationStore.getState().setAutosaveEnabled(event.target.checked);
          if (event.target.checked) useAnnotationStore.getState().triggerAutosave();
        }} />}
        label={<Typography sx={{ fontSize: 11 }}>{autosaveEnabled ? t('autosave_label') : t('manual_save_mode')}</Typography>}
      />
      <Typography sx={{ fontSize: 11, fontWeight: 700, color: saveStatus === 'failed' ? 'error.main' : 'text.secondary' }}>
        {t(`save_status_${saveStatus}`)}
      </Typography>
      {!autosaveEnabled && <Button size="small" variant="outlined" onClick={() => void useAnnotationStore.getState().saveCurrent()} sx={btnSx}>{t('save')}</Button>}
    </Box>
  );
}
