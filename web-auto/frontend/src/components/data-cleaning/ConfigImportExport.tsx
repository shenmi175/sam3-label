import { useRef, useState } from 'react';
import { Alert, Box, Button } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useSmartFilterStore } from '../../stores/workspace/smartFilterStore';
import type { FilterTaskType } from '../../api/filters';
import { parseDataCleaningConfig, serializeDataCleaningConfig } from './configFile';

const MAX_CONFIG_BYTES = 64 * 1024;

export function ConfigImportExport({ onImported }: { onImported?: (taskType: FilterTaskType) => void }) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const jobRunning = useSmartFilterStore((state) => state.jobRunning);
  const [message, setMessage] = useState<{ severity: 'success' | 'warning' | 'error'; text: string } | null>(null);

  const exportConfig = () => {
    const payload = serializeDataCleaningConfig(useSmartFilterStore.getState().config);
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'data-cleaning-config-v2.json';
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage({ severity: 'success', text: t('sf_config_exported') });
  };

  const importConfig = async (file: File | undefined) => {
    if (!file) return;
    try {
      if (file.size > MAX_CONFIG_BYTES) throw new Error('too_large');
      const parsed = parseDataCleaningConfig(await file.text());
      useSmartFilterStore.getState().updateConfig(parsed.config);
      onImported?.(parsed.config.taskType);
      setMessage({
        severity: parsed.warnings.length > 0 ? 'warning' : 'success',
        text: parsed.warnings.length > 0 ? t('sf_config_import_unknown') : t('sf_config_imported'),
      });
    } catch (error) {
      setMessage({ severity: 'error', text: t('sf_config_import_failed', { error: error instanceof Error ? error.message : String(error) }) });
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Box sx={{ display: 'flex', gap: 1 }}>
        <Button size="small" variant="outlined" disabled={jobRunning} onClick={() => inputRef.current?.click()}>{t('sf_config_import')}</Button>
        <Button size="small" variant="outlined" onClick={exportConfig}>{t('sf_config_export')}</Button>
        <input ref={inputRef} hidden type="file" accept="application/json,.json" onChange={(event) => void importConfig(event.target.files?.[0])} />
      </Box>
      {message && <Alert severity={message.severity} onClose={() => setMessage(null)}>{message.text}</Alert>}
    </Box>
  );
}
