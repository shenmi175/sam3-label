import {
  Box,
  Checkbox,
  FormControlLabel,
  TextField,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../stores/workspace/projectStore';
import {
  useSmartFilterStore,
  type SmartFilterConfig,
} from '../../stores/workspace/smartFilterStore';
import { labelSx, num, toggleListValue } from './shared';

/**
 * Data-cleaning rule-filter configuration — class scope plus the four
 * rule cards (small target / instance count / position / confidence).
 * Rendered only when operationMode === 'rule'.
 */
export function RuleFilterConfig() {
  const { t } = useTranslation();
  const classes = useProjectStore((s) => s.classes);
  const config = useSmartFilterStore((s) => s.config);

  const update = (partial: Partial<SmartFilterConfig>) =>
    useSmartFilterStore.getState().updateConfig(partial);

  const cardSx = { p: 1.25, borderRadius: 1.5, bgcolor: 'action.hover' } as const;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      <Typography sx={{ fontSize: 11, lineHeight: 1.6, p: 1.25, borderRadius: 1.5, bgcolor: 'rgba(239,68,68,0.08)' }}>
        {t('sf_rule_warning')}
      </Typography>
      <Box>
        <Typography sx={labelSx}>{t('sf_class_scope')}</Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', maxHeight: 140, overflowY: 'auto' }}>
          {classes.map((cls) => (
            <FormControlLabel
              key={cls}
              sx={{ m: 0 }}
              control={
                <Checkbox
                  size="small"
                  checked={config.ruleClasses.includes(cls)}
                  onChange={(e) => update({ ruleClasses: toggleListValue(config.ruleClasses, cls, e.target.checked) })}
                />
              }
              label={<Typography sx={{ fontSize: 12 }}>{cls}</Typography>}
            />
          ))}
        </Box>
      </Box>

      <Box sx={cardSx}>
        <FormControlLabel
          sx={{ m: 0 }}
          control={<Checkbox size="small" checked={config.smallTargetEnabled} onChange={(e) => update({ smallTargetEnabled: e.target.checked })} />}
          label={<Typography sx={{ fontSize: 12, fontWeight: 700 }}>{t('sf_rule_small')}</Typography>}
        />
        <Typography sx={{ fontSize: 10, color: 'text.secondary', my: 0.5 }}>{t('sf_rule_small_hint')}</Typography>
        <TextField
          size="small"
          type="number"
          fullWidth
          value={config.maxAreaRatio}
          inputProps={{ min: 0, max: 1, step: 0.001 }}
          onChange={(e) => update({ maxAreaRatio: num(e.target.value, 0.02) })}
        />
      </Box>

      <Box sx={cardSx}>
        <FormControlLabel
          sx={{ m: 0 }}
          control={<Checkbox size="small" checked={config.instanceCountEnabled} onChange={(e) => update({ instanceCountEnabled: e.target.checked })} />}
          label={<Typography sx={{ fontSize: 12, fontWeight: 700 }}>{t('sf_rule_count')}</Typography>}
        />
        <Typography sx={{ fontSize: 10, color: 'text.secondary', my: 0.5 }}>{t('sf_rule_count_hint')}</Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <TextField size="small" type="number" fullWidth value={config.minInstances} inputProps={{ min: 0 }} onChange={(e) => update({ minInstances: num(e.target.value, 1) })} placeholder={t('sf_min_placeholder')} />
          <TextField size="small" type="number" fullWidth value={config.maxInstances} inputProps={{ min: 0 }} onChange={(e) => update({ maxInstances: num(e.target.value, 0) })} placeholder={t('sf_max_placeholder')} />
        </Box>
      </Box>

      <Box sx={cardSx}>
        <FormControlLabel
          sx={{ m: 0 }}
          control={<Checkbox size="small" checked={config.positionEnabled} onChange={(e) => update({ positionEnabled: e.target.checked })} />}
          label={<Typography sx={{ fontSize: 12, fontWeight: 700 }}>{t('sf_rule_pos')}</Typography>}
        />
        <Typography sx={{ fontSize: 10, color: 'text.secondary', my: 0.5 }}>{t('sf_rule_pos_hint')}</Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <TextField size="small" type="number" fullWidth value={config.centerXHalfWidth} inputProps={{ min: 0, max: 0.5, step: 0.01 }} onChange={(e) => update({ centerXHalfWidth: num(e.target.value, 0.25) })} placeholder={t('sf_half_width')} />
          <TextField size="small" type="number" fullWidth value={config.centerYHalfHeight} inputProps={{ min: 0, max: 0.5, step: 0.01 }} onChange={(e) => update({ centerYHalfHeight: num(e.target.value, 0.05) })} placeholder={t('sf_half_height')} />
        </Box>
      </Box>

      <Box sx={cardSx}>
        <FormControlLabel
          sx={{ m: 0 }}
          control={<Checkbox size="small" checked={config.confidenceEnabled} onChange={(e) => update({ confidenceEnabled: e.target.checked })} />}
          label={<Typography sx={{ fontSize: 12, fontWeight: 700 }}>{t('sf_rule_conf')}</Typography>}
        />
        <Typography sx={{ fontSize: 10, color: 'text.secondary', my: 0.5 }}>{t('sf_rule_conf_hint')}</Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <TextField size="small" type="number" fullWidth value={config.minConfidence} inputProps={{ min: 0, max: 1, step: 0.01 }} onChange={(e) => update({ minConfidence: num(e.target.value, 0) })} placeholder={t('sf_conf_min_placeholder')} />
          <TextField size="small" type="number" fullWidth value={config.maxConfidence} inputProps={{ min: 0, max: 1, step: 0.01 }} onChange={(e) => update({ maxConfidence: num(e.target.value, 1) })} placeholder={t('sf_conf_max_placeholder')} />
        </Box>
      </Box>
    </Box>
  );
}
