import { useMemo, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  InputAdornment,
  Slider,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../stores/workspace/projectStore';
import { useSmartFilterStore, type SmartFilterConfig } from '../../stores/workspace/smartFilterStore';
import { num, toggleListValue } from './shared';

type RulePreset = 'small' | 'low_confidence' | 'edge' | 'dense';

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const pct = (value: number) => Math.round(value * 1000) / 10;

export function RuleFilterConfig() {
  const { t } = useTranslation();
  const classes = useProjectStore((state) => state.classes);
  const config = useSmartFilterStore((state) => state.config);
  const [classSearch, setClassSearch] = useState('');
  const update = (partial: Partial<SmartFilterConfig>) => useSmartFilterStore.getState().updateConfig(partial);

  const filteredClasses = useMemo(() => {
    const query = classSearch.trim().toLocaleLowerCase();
    return query ? classes.filter((name) => name.toLocaleLowerCase().includes(query)) : classes;
  }, [classSearch, classes]);

  const instanceConditionCount = [config.smallTargetEnabled, config.positionEnabled, config.confidenceEnabled].filter(Boolean).length;
  const advancedCount = [
    config.instanceCountEnabled,
    config.ruleMatchMode !== 'all',
    config.smallTargetEnabled && config.areaMode !== 'instance',
    config.confidenceEnabled && config.includeMissingConfidence,
    config.positionEnabled && config.positionMatchMode !== 'outside',
    config.positionEnabled && (config.centerXHalfWidth !== 0.4 || config.centerYHalfHeight !== 0.4),
  ].filter(Boolean).length;

  const applyRulePreset = (preset: RulePreset) => {
    const reset: Partial<SmartFilterConfig> = {
      smallTargetEnabled: false,
      instanceCountEnabled: false,
      positionEnabled: false,
      confidenceEnabled: false,
      maxAreaRatio: 0.02,
      minInstances: 1,
      maxInstances: 0,
      positionMatchMode: 'outside',
      centerXHalfWidth: 0.4,
      centerYHalfHeight: 0.4,
      minConfidence: 0,
      maxConfidence: 1,
      includeMissingConfidence: false,
      ruleMatchMode: 'all',
      areaMode: 'instance',
    };
    if (preset === 'small') update({ ...reset, smallTargetEnabled: true, maxAreaRatio: 0.02 });
    if (preset === 'low_confidence') update({ ...reset, confidenceEnabled: true, minConfidence: 0, maxConfidence: 0.35 });
    if (preset === 'edge') update({ ...reset, positionEnabled: true, positionMatchMode: 'outside' });
    if (preset === 'dense') update({ ...reset, instanceCountEnabled: true, minInstances: 10, maxInstances: 0 });
  };

  const positionWidth = clamp(config.centerXHalfWidth * 200, 0, 100);
  const positionHeight = clamp(config.centerYHalfHeight * 200, 0, 100);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      <Alert severity="warning">{t('sf_rule_warning')}</Alert>

      <Box>
        <Typography sx={{ fontSize: 12, fontWeight: 800, mb: 0.75 }}>{t('sf_rule_presets')}</Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 1 }}>
          {(['small', 'low_confidence', 'edge', 'dense'] as RulePreset[]).map((preset) => (
            <Button
              key={preset}
              variant="outlined"
              onClick={() => applyRulePreset(preset)}
              sx={{ minHeight: 54, display: 'block', textAlign: 'left', px: 1.25, py: 0.75 }}
            >
              <Typography sx={{ fontSize: 12, fontWeight: 800 }}>{t(`sf_rule_preset_${preset}`)}</Typography>
              <Typography sx={{ fontSize: 10, color: 'text.secondary', textTransform: 'none' }}>
                {t(`sf_rule_preset_${preset}_hint`)}
              </Typography>
            </Button>
          ))}
        </Box>
        <Typography sx={{ mt: 0.5, fontSize: 10, color: 'text.secondary' }}>{t('sf_rule_preset_replace_hint')}</Typography>
      </Box>

      <Accordion defaultExpanded>
        <AccordionSummary expandIcon="⌄">
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography sx={{ fontWeight: 800 }}>{t('sf_class_scope')}</Typography>
            <Chip size="small" label={t('sf_selected_count', { count: config.ruleClasses.length })} />
          </Box>
        </AccordionSummary>
        <AccordionDetails>
          <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
            <TextField
              size="small"
              fullWidth
              value={classSearch}
              placeholder={t('sf_search_classes')}
              onChange={(event) => setClassSearch(event.target.value)}
            />
            <Button size="small" onClick={() => update({ ruleClasses: [...classes] })}>{t('select_all')}</Button>
            <Button size="small" onClick={() => update({ ruleClasses: [] })}>{t('clear')}</Button>
          </Box>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', maxHeight: 180, overflowY: 'auto' }}>
            {filteredClasses.map((cls) => (
              <FormControlLabel
                key={cls}
                control={(
                  <Checkbox
                    checked={config.ruleClasses.includes(cls)}
                    onChange={(event) => update({ ruleClasses: toggleListValue(config.ruleClasses, cls, event.target.checked) })}
                  />
                )}
                label={cls}
              />
            ))}
          </Box>
        </AccordionDetails>
      </Accordion>

      <Accordion>
        <AccordionSummary expandIcon="⌄">
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography sx={{ fontWeight: 800 }}>{t('sf_advanced_exact')}</Typography>
            {advancedCount > 0 && <Chip color="primary" size="small" label={t('sf_advanced_active', { count: advancedCount })} />}
          </Box>
        </AccordionSummary>
        <AccordionDetails sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Box>
            <FormControlLabel
              control={<Checkbox checked={config.instanceCountEnabled} onChange={() => update({ instanceCountEnabled: !config.instanceCountEnabled })} />}
              label={<Typography sx={{ fontWeight: 700 }}>{t('sf_rule_image_gate')}</Typography>}
            />
            <Typography sx={{ mb: 0.75, fontSize: 10, color: 'text.secondary' }}>{t('sf_rule_count_scope')}</Typography>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <TextField
                label={t('sf_min_instances')}
                size="small"
                type="number"
                fullWidth
                disabled={!config.instanceCountEnabled}
                value={config.minInstances}
                inputProps={{ min: 0, step: 1 }}
                onChange={(event) => update({ minInstances: Math.max(0, Math.trunc(num(event.target.value))) })}
              />
              <TextField
                label={t('sf_max_instances')}
                size="small"
                type="number"
                fullWidth
                disabled={!config.instanceCountEnabled}
                value={config.maxInstances}
                helperText={t('sf_zero_unlimited')}
                inputProps={{ min: 0, step: 1 }}
                onChange={(event) => update({ maxInstances: Math.max(0, Math.trunc(num(event.target.value))) })}
              />
            </Box>
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
            <Box>
              <Typography sx={{ fontSize: 12, fontWeight: 700 }}>{t('sf_instance_condition_combine')}</Typography>
              <Typography sx={{ fontSize: 10, color: 'text.secondary' }}>{t('sf_instance_condition_combine_hint')}</Typography>
            </Box>
            <ToggleButtonGroup exclusive size="small" value={config.ruleMatchMode} onChange={(_event, value) => value && update({ ruleMatchMode: value })}>
              <ToggleButton value="all">{t('sf_match_all')}</ToggleButton>
              <ToggleButton value="any">{t('sf_match_any')}</ToggleButton>
            </ToggleButtonGroup>
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
            <Typography sx={{ fontSize: 12, fontWeight: 700 }}>{t('sf_area_metric')}</Typography>
            <ToggleButtonGroup exclusive size="small" value={config.areaMode} onChange={(_event, value) => value && update({ areaMode: value })}>
              <ToggleButton value="instance">{t('sf_area_instance')}</ToggleButton>
              <ToggleButton value="bbox">{t('sf_area_bbox')}</ToggleButton>
            </ToggleButtonGroup>
          </Box>

          <TextField
            label={t('sf_small_exact')}
            size="small"
            type="number"
            fullWidth
            disabled={!config.smallTargetEnabled}
            value={pct(config.maxAreaRatio)}
            inputProps={{ min: 0, max: 100, step: 0.1 }}
            InputProps={{ endAdornment: <InputAdornment position="end">%</InputAdornment> }}
            onChange={(event) => update({ maxAreaRatio: clamp(num(event.target.value) / 100, 0, 1) })}
          />

          <Box>
            <Typography sx={{ fontSize: 12, fontWeight: 700, mb: 0.75 }}>{t('sf_position_exact')}</Typography>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <TextField
                label={t('sf_safe_width')}
                size="small"
                type="number"
                fullWidth
                value={pct(config.centerXHalfWidth * 2)}
                inputProps={{ min: 0, max: 100, step: 1 }}
                InputProps={{ endAdornment: <InputAdornment position="end">%</InputAdornment> }}
                onChange={(event) => update({ centerXHalfWidth: clamp(num(event.target.value) / 200, 0, 0.5) })}
              />
              <TextField
                label={t('sf_safe_height')}
                size="small"
                type="number"
                fullWidth
                value={pct(config.centerYHalfHeight * 2)}
                inputProps={{ min: 0, max: 100, step: 1 }}
                InputProps={{ endAdornment: <InputAdornment position="end">%</InputAdornment> }}
                onChange={(event) => update({ centerYHalfHeight: clamp(num(event.target.value) / 200, 0, 0.5) })}
              />
            </Box>
          </Box>

          <Box>
            <Typography sx={{ fontSize: 12, fontWeight: 700, mb: 0.75 }}>{t('sf_confidence_exact')}</Typography>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <TextField
                label={t('sf_conf_min_placeholder')}
                size="small"
                type="number"
                fullWidth
                disabled={!config.confidenceEnabled}
                value={pct(config.minConfidence)}
                inputProps={{ min: 0, max: 100, step: 0.1 }}
                InputProps={{ endAdornment: <InputAdornment position="end">%</InputAdornment> }}
                onChange={(event) => update({ minConfidence: clamp(num(event.target.value) / 100, 0, 1) })}
              />
              <TextField
                label={t('sf_conf_max_placeholder')}
                size="small"
                type="number"
                fullWidth
                disabled={!config.confidenceEnabled}
                value={pct(config.maxConfidence)}
                inputProps={{ min: 0, max: 100, step: 0.1 }}
                InputProps={{ endAdornment: <InputAdornment position="end">%</InputAdornment> }}
                onChange={(event) => update({ maxConfidence: clamp(num(event.target.value) / 100, 0, 1) })}
              />
            </Box>
          </Box>

          <FormControlLabel
            control={<Checkbox checked={config.includeMissingConfidence} onChange={(event) => update({ includeMissingConfidence: event.target.checked })} />}
            label={t('sf_include_missing_confidence')}
          />
        </AccordionDetails>
      </Accordion>

      {config.instanceCountEnabled && (
        <Alert severity={instanceConditionCount === 0 ? 'warning' : 'info'}>
          {instanceConditionCount === 0
            ? t('sf_rule_count_only_warning', { min: config.minInstances, max: config.maxInstances || t('sf_unlimited') })
            : t('sf_rule_two_stage_hint', { min: config.minInstances, max: config.maxInstances || t('sf_unlimited') })}
        </Alert>
      )}

      <Box>
        <Typography sx={{ fontSize: 12, fontWeight: 800, mb: 0.75 }}>{t('sf_instance_conditions')}</Typography>
        <Typography sx={{ mb: 1, fontSize: 10, color: 'text.secondary' }}>{t('sf_instance_conditions_hint')}</Typography>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Box sx={{ p: 1.25, border: '1px solid', borderColor: config.smallTargetEnabled ? 'primary.main' : 'divider', borderRadius: 1.5 }}>
            <FormControlLabel
              control={<Checkbox checked={config.smallTargetEnabled} onChange={() => update({ smallTargetEnabled: !config.smallTargetEnabled })} />}
              label={<Typography sx={{ fontWeight: 700 }}>{t('sf_rule_small')}</Typography>}
            />
            {config.smallTargetEnabled && (
              <Box sx={{ px: 1 }}>
                <Typography sx={{ fontSize: 11 }}>{t('sf_rule_small_value', { value: pct(config.maxAreaRatio) })}</Typography>
                <Slider
                  value={pct(config.maxAreaRatio)}
                  min={0}
                  max={20}
                  step={0.1}
                  valueLabelDisplay="auto"
                  valueLabelFormat={(value) => `${value}%`}
                  onChange={(_event, value) => update({ maxAreaRatio: clamp(Number(value) / 100, 0, 1) })}
                />
              </Box>
            )}
          </Box>

          <Box sx={{ p: 1.25, border: '1px solid', borderColor: config.positionEnabled ? 'primary.main' : 'divider', borderRadius: 1.5 }}>
            <FormControlLabel
              control={<Checkbox checked={config.positionEnabled} onChange={() => update({ positionEnabled: !config.positionEnabled })} />}
              label={<Typography sx={{ fontWeight: 700 }}>{t('sf_rule_pos')}</Typography>}
            />
            {config.positionEnabled && (
              <Box sx={{ display: 'grid', gridTemplateColumns: '160px minmax(0,1fr)', gap: 1.5, alignItems: 'center', px: 1 }}>
                <Box sx={{ position: 'relative', aspectRatio: '4 / 3', bgcolor: 'action.hover', border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                  <Box sx={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: `${positionWidth}%`, height: `${positionHeight}%`, border: '2px solid', borderColor: 'primary.main', bgcolor: 'rgba(59,130,246,.12)' }} />
                </Box>
                <Box>
                  <ToggleButtonGroup exclusive size="small" value={config.positionMatchMode} onChange={(_event, value) => value && update({ positionMatchMode: value })}>
                    <ToggleButton value="inside">{t('sf_inside')}</ToggleButton>
                    <ToggleButton value="outside">{t('sf_outside')}</ToggleButton>
                  </ToggleButtonGroup>
                  <Typography sx={{ mt: 0.75, fontSize: 10, color: 'text.secondary' }}>
                    {t('sf_safe_region_summary', { width: pct(config.centerXHalfWidth * 2), height: pct(config.centerYHalfHeight * 2) })}
                  </Typography>
                </Box>
              </Box>
            )}
          </Box>

          <Box sx={{ p: 1.25, border: '1px solid', borderColor: config.confidenceEnabled ? 'primary.main' : 'divider', borderRadius: 1.5 }}>
            <FormControlLabel
              control={<Checkbox checked={config.confidenceEnabled} onChange={() => update({ confidenceEnabled: !config.confidenceEnabled })} />}
              label={<Typography sx={{ fontWeight: 700 }}>{t('sf_rule_conf')}</Typography>}
            />
            {config.confidenceEnabled && (
              <Box sx={{ px: 1 }}>
                <Typography sx={{ fontSize: 11 }}>{t('sf_rule_conf_value', { min: pct(config.minConfidence), max: pct(config.maxConfidence) })}</Typography>
                <Slider
                  value={[pct(config.minConfidence), pct(config.maxConfidence)]}
                  min={0}
                  max={100}
                  step={1}
                  valueLabelDisplay="auto"
                  valueLabelFormat={(value) => `${value}%`}
                  onChange={(_event, value) => {
                    const range = value as number[];
                    update({ minConfidence: range[0] / 100, maxConfidence: range[1] / 100 });
                  }}
                />
              </Box>
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
