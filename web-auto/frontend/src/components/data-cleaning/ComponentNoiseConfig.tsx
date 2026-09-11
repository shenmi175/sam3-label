import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Checkbox,
  FormControlLabel,
  Slider,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useSmartFilterStore, type SmartFilterConfig } from '../../stores/workspace/smartFilterStore';
import { num } from './shared';

function IntegerControl({
  disabled = false,
  value,
  min,
  max,
  onChange,
}: {
  disabled?: boolean;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 2, alignItems: 'center' }}>
      <Slider disabled={disabled} min={min} max={max} step={1} value={value} onChange={(_event, next) => onChange(Number(next))} />
      <TextField
        size="small"
        type="number"
        disabled={disabled}
        value={value}
        inputProps={{ min, max }}
        onChange={(event) => onChange(Math.min(max, Math.max(min, Math.trunc(num(event.target.value, min)))))}
      />
    </Box>
  );
}

export function ComponentNoiseConfig() {
  const { t } = useTranslation();
  const config = useSmartFilterStore((state) => state.config);
  const update = (partial: Partial<SmartFilterConfig>) => useSmartFilterStore.getState().updateConfig(partial);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Accordion defaultExpanded>
        <AccordionSummary expandIcon="⌄"><Typography sx={{ fontWeight: 800 }}>{t('sf_component_thresholds')}</Typography></AccordionSummary>
        <AccordionDetails sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Box>
            <FormControlLabel
              control={<Checkbox checked={config.componentAbsAreaEnabled} onChange={(event) => update({ componentAbsAreaEnabled: event.target.checked })} />}
              label={t('sf_component_abs')}
            />
            <IntegerControl disabled={!config.componentAbsAreaEnabled} min={0} max={4096} value={config.componentMaxAreaPx} onChange={(value) => update({ componentMaxAreaPx: value })} />
          </Box>
          <Box>
            <FormControlLabel
              control={<Checkbox checked={config.componentRelativeAreaEnabled} onChange={(event) => update({ componentRelativeAreaEnabled: event.target.checked })} />}
              label={t('sf_component_relative')}
            />
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 2, alignItems: 'center' }}>
              <Slider disabled={!config.componentRelativeAreaEnabled} min={0} max={0.01} step={0.0001} value={config.componentMaxMainRatio} onChange={(_event, value) => update({ componentMaxMainRatio: Number(value) })} />
              <TextField size="small" type="number" disabled={!config.componentRelativeAreaEnabled} value={config.componentMaxMainRatio} inputProps={{ min: 0, step: 0.0001 }} onChange={(event) => update({ componentMaxMainRatio: Math.max(0, num(event.target.value)) })} />
            </Box>
          </Box>
          <Box>
            <Typography sx={{ fontSize: 12, color: 'text.secondary', mb: 0.75 }}>{t('sf_component_combine')}</Typography>
            <ToggleButtonGroup exclusive size="small" value={config.componentRequireAllThresholds ? 'all' : 'any'} onChange={(_event, value) => value && update({ componentRequireAllThresholds: value === 'all' })}>
              <ToggleButton value="all">{t('sf_match_all')}</ToggleButton>
              <ToggleButton value="any">{t('sf_match_any')}</ToggleButton>
            </ToggleButtonGroup>
          </Box>
          <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{t('sf_component_keep_main')}</Typography>
        </AccordionDetails>
      </Accordion>

      <Accordion>
        <AccordionSummary expandIcon="⌄"><Typography sx={{ fontWeight: 800 }}>{t('sf_opening_title')}</Typography></AccordionSummary>
        <AccordionDetails sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <FormControlLabel control={<Checkbox checked={config.componentOpeningEnabled} onChange={(event) => update({ componentOpeningEnabled: event.target.checked })} />} label={t('sf_opening_enable')} />
          <Alert severity="warning">{t('sf_opening_warning')}</Alert>
          <Typography sx={{ fontSize: 12 }}>{t('sf_radius_px')}</Typography>
          <IntegerControl disabled={!config.componentOpeningEnabled} min={1} max={32} value={config.componentOpeningRadiusPx} onChange={(value) => update({ componentOpeningRadiusPx: value })} />
          <Typography sx={{ fontSize: 12 }}>{t('sf_iterations')}</Typography>
          <IntegerControl disabled={!config.componentOpeningEnabled} min={1} max={8} value={config.componentOpeningIterations} onChange={(value) => update({ componentOpeningIterations: value })} />
        </AccordionDetails>
      </Accordion>

      <Accordion>
        <AccordionSummary expandIcon="⌄"><Typography sx={{ fontWeight: 800 }}>{t('sf_gap_title')}</Typography></AccordionSummary>
        <AccordionDetails sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <FormControlLabel control={<Checkbox checked={config.componentGapRepairEnabled} onChange={(event) => update({ componentGapRepairEnabled: event.target.checked })} />} label={t('sf_gap_enable')} />
          <Alert severity="info">{t('sf_gap_hint')}</Alert>
          <ToggleButtonGroup
            exclusive
            size="small"
            disabled={!config.componentGapRepairEnabled}
            value={config.componentGapRepairMethod}
            onChange={(_event, value) => value && update({ componentGapRepairMethod: value })}
          >
            <ToggleButton value="shortest_bridge">{t('sf_gap_shortest')}</ToggleButton>
            <ToggleButton value="morph_close">{t('sf_gap_closing')}</ToggleButton>
          </ToggleButtonGroup>
          {config.componentGapRepairMethod === 'shortest_bridge' ? (
            <>
              <Typography sx={{ fontSize: 12 }}>{t('sf_gap_max')}</Typography>
              <IntegerControl disabled={!config.componentGapRepairEnabled} min={1} max={256} value={config.componentBridgeMaxGapPx} onChange={(value) => update({ componentBridgeMaxGapPx: value })} />
              <Typography sx={{ fontSize: 12 }}>{t('sf_bridge_width')}</Typography>
              <IntegerControl disabled={!config.componentGapRepairEnabled} min={1} max={64} value={config.componentBridgeWidthPx} onChange={(value) => update({ componentBridgeWidthPx: value })} />
              <ToggleButtonGroup
                exclusive
                size="small"
                disabled={!config.componentGapRepairEnabled}
                value={config.componentBridgeTopology}
                onChange={(_event, value) => value && update({ componentBridgeTopology: value })}
              >
                <ToggleButton value="mst">{t('sf_bridge_mst')}</ToggleButton>
                <ToggleButton value="main_only">{t('sf_bridge_main')}</ToggleButton>
              </ToggleButtonGroup>
            </>
          ) : (
            <>
              <Typography sx={{ fontSize: 12 }}>{t('sf_closing_radius')}</Typography>
              <IntegerControl disabled={!config.componentGapRepairEnabled} min={1} max={128} value={config.componentClosingRadiusPx} onChange={(value) => update({ componentClosingRadiusPx: value })} />
              <Typography sx={{ fontSize: 12 }}>{t('sf_iterations')}</Typography>
              <IntegerControl disabled={!config.componentGapRepairEnabled} min={1} max={8} value={config.componentClosingIterations} onChange={(value) => update({ componentClosingIterations: value })} />
            </>
          )}
          <FormControlLabel
            control={<Checkbox disabled={!config.componentGapRepairEnabled} checked={config.componentGapAvoidOtherInstances} onChange={(event) => update({ componentGapAvoidOtherInstances: event.target.checked })} />}
            label={t('sf_gap_collision')}
          />
        </AccordionDetails>
      </Accordion>

      <Accordion>
        <AccordionSummary expandIcon="⌄"><Typography sx={{ fontWeight: 800 }}>{t('sf_hole_title')}</Typography></AccordionSummary>
        <AccordionDetails sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <FormControlLabel control={<Checkbox checked={config.componentHoleFillEnabled} onChange={(event) => update({ componentHoleFillEnabled: event.target.checked })} />} label={t('sf_hole_enable')} />
          <FormControlLabel control={<Checkbox disabled={!config.componentHoleFillEnabled} checked={config.componentHoleAbsAreaEnabled} onChange={(event) => update({ componentHoleAbsAreaEnabled: event.target.checked })} />} label={t('sf_hole_abs')} />
          <IntegerControl disabled={!config.componentHoleFillEnabled || !config.componentHoleAbsAreaEnabled} min={0} max={4096} value={config.componentMaxHoleAreaPx} onChange={(value) => update({ componentMaxHoleAreaPx: value })} />
          <FormControlLabel control={<Checkbox disabled={!config.componentHoleFillEnabled} checked={config.componentHoleRelativeAreaEnabled} onChange={(event) => update({ componentHoleRelativeAreaEnabled: event.target.checked })} />} label={t('sf_hole_relative')} />
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 2, alignItems: 'center' }}>
            <Slider disabled={!config.componentHoleFillEnabled || !config.componentHoleRelativeAreaEnabled} min={0} max={0.01} step={0.0001} value={config.componentMaxHoleMainRatio} onChange={(_event, value) => update({ componentMaxHoleMainRatio: Number(value) })} />
            <TextField size="small" type="number" disabled={!config.componentHoleFillEnabled || !config.componentHoleRelativeAreaEnabled} value={config.componentMaxHoleMainRatio} inputProps={{ min: 0, step: 0.0001 }} onChange={(event) => update({ componentMaxHoleMainRatio: Math.max(0, num(event.target.value)) })} />
          </Box>
          <ToggleButtonGroup exclusive size="small" disabled={!config.componentHoleFillEnabled} value={config.componentHoleRequireAllThresholds ? 'all' : 'any'} onChange={(_event, value) => value && update({ componentHoleRequireAllThresholds: value === 'all' })}>
            <ToggleButton value="all">{t('sf_match_all')}</ToggleButton>
            <ToggleButton value="any">{t('sf_match_any')}</ToggleButton>
          </ToggleButtonGroup>
        </AccordionDetails>
      </Accordion>
    </Box>
  );
}
