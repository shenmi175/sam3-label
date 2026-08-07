import { Box, Button, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../stores/workspace/projectStore';
import {
  useSmartFilterStore,
  type SmartFilterConfig,
} from '../../stores/workspace/smartFilterStore';

/**
 * Data-cleaning mode selection cards — recipe presets (legacy
 * filter-recipe-card) + the merge/rule/delete-unlabeled operation mode
 * switch with its mode hint text.
 */
export function ModeSelectCards() {
  const { t } = useTranslation();
  const classes = useProjectStore((s) => s.classes);
  const activePreset = useSmartFilterStore((s) => s.activePreset);
  const operationMode = useSmartFilterStore((s) => s.config.operationMode);

  const update = (partial: Partial<SmartFilterConfig>) =>
    useSmartFilterStore.getState().updateConfig(partial);

  const isMerge = operationMode === 'merge';
  const isRule = operationMode === 'rule';

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      {/* Recipe presets (legacy filter-recipe-card) */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 1 }}>
        {([
          ['dedupe', 'sf_preset_dedupe', 'sf_preset_dedupe_desc'],
          ['canonical', 'sf_preset_canonical', 'sf_preset_canonical_desc'],
          ['cleanup', 'sf_preset_cleanup', 'sf_preset_cleanup_desc'],
          ['delete_unlabeled', 'sf_preset_delete', 'sf_preset_delete_desc'],
        ] as const).map(([preset, titleKey, descKey]) => (
          <Button
            key={preset}
            size="small"
            variant={activePreset === preset ? 'contained' : 'outlined'}
            onClick={() => useSmartFilterStore.getState().applyPreset(preset, classes)}
            sx={{ flexDirection: 'column', alignItems: 'flex-start', gap: 0.5, p: 1, textTransform: 'none' }}
          >
            <Typography sx={{ fontSize: 12, fontWeight: 800 }}>{t(titleKey)}</Typography>
            <Typography sx={{ fontSize: 10, color: activePreset === preset ? 'inherit' : 'text.secondary', textAlign: 'left', lineHeight: 1.4 }}>
              {t(descKey)}
            </Typography>
          </Button>
        ))}
      </Box>

      {/* Operation mode switch (legacy merge/rule/delete buttons) */}
      <Box sx={{ display: 'flex', gap: 0.75 }}>
        {([
          ['merge', 'sf_op_merge'],
          ['rule', 'sf_op_rule'],
          ['delete_unlabeled', 'sf_op_delete_unlabeled'],
        ] as const).map(([mode, labelKey]) => (
          <Button
            key={mode}
            size="small"
            fullWidth
            variant={operationMode === mode ? 'contained' : 'outlined'}
            color={mode === 'merge' ? 'primary' : 'error'}
            onClick={() => update({ operationMode: mode })}
            sx={{ fontSize: 11, fontWeight: 700 }}
          >
            {t(labelKey)}
          </Button>
        ))}
      </Box>
      <Typography sx={{ fontSize: 11, color: 'text.secondary', lineHeight: 1.6, p: 1.25, borderRadius: 1.5, bgcolor: 'action.hover' }}>
        {isMerge ? t('sf_hint_merge') : isRule ? t('sf_hint_rule') : t('sf_hint_delete')}
      </Typography>
    </Box>
  );
}
