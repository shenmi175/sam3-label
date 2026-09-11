import {
  Box, Checkbox, FormControlLabel, MenuItem, Select, TextField,
  ToggleButton, ToggleButtonGroup, Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../stores/workspace/projectStore';
import { useSmartFilterStore, type SmartFilterConfig } from '../../stores/workspace/smartFilterStore';
import { toggleListValue } from './shared';

function NumberField({ label, value, min = 0, max, step = 1, onChange }: {
  label: string; value: number; min?: number; max?: number; step?: number; onChange: (value: number) => void;
}) {
  return <TextField size="small" type="number" label={label} value={value} inputProps={{ min, max, step }} onChange={(event) => {
    const next = Number(event.target.value);
    if (Number.isFinite(next)) onChange(Math.min(max ?? next, Math.max(min, next)));
  }} />;
}

export function SingleTaskConfig() {
  const { t } = useTranslation();
  const classes = useProjectStore((state) => state.classes);
  const config = useSmartFilterStore((state) => state.config);
  const update = (partial: Partial<SmartFilterConfig>) => useSmartFilterStore.getState().updateConfig(partial);
  const task = config.taskType;

  const scope = task === 'delete_unlabeled_images' ? null : (
    <Box sx={{ p: 1.25, border: '1px solid', borderColor: 'divider', borderRadius: 1.5 }}>
      <Typography sx={{ mb: 1, fontSize: 12, fontWeight: 800 }}>{t('sf_class_scope')}</Typography>
      <ToggleButtonGroup exclusive size="small" value={config.classScopeMode} onChange={(_event, value) => value && update({ classScopeMode: value })}>
        <ToggleButton value="all">{t('sf_scope_all')}</ToggleButton>
        <ToggleButton value="selected">{t('sf_scope_selected')}</ToggleButton>
      </ToggleButtonGroup>
      {config.classScopeMode === 'selected' && (
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', mt: 1, maxHeight: 130, overflowY: 'auto' }}>
          {classes.map((name) => <FormControlLabel key={name} sx={{ m: 0 }} control={<Checkbox size="small" checked={config.ruleClasses.includes(name)} onChange={(event) => update({ ruleClasses: toggleListValue(config.ruleClasses, name, event.target.checked) })} />} label={<Typography sx={{ fontSize: 12 }}>{name}</Typography>} />)}
        </Box>
      )}
    </Box>
  );

  let params = null;
  if (task === 'remove_small_components') params = <>
    <FormControlLabel control={<Checkbox checked={config.componentAbsAreaEnabled} onChange={(event) => update({ componentAbsAreaEnabled: event.target.checked })} />} label={t('sf_component_abs')} />
    <NumberField label={t('sf_max_area_px')} value={config.componentMaxAreaPx} onChange={(value) => update({ componentMaxAreaPx: Math.trunc(value) })} />
    <FormControlLabel control={<Checkbox checked={config.componentRelativeAreaEnabled} onChange={(event) => update({ componentRelativeAreaEnabled: event.target.checked })} />} label={t('sf_component_relative')} />
    <NumberField label={t('sf_max_main_ratio')} value={config.componentMaxMainRatio} step={0.0001} onChange={(value) => update({ componentMaxMainRatio: value })} />
    <ToggleButtonGroup exclusive size="small" value={config.componentRequireAllThresholds ? 'and' : 'or'} onChange={(_event, value) => value && update({ componentRequireAllThresholds: value === 'and' })}><ToggleButton value="and">AND</ToggleButton><ToggleButton value="or">OR</ToggleButton></ToggleButtonGroup>
  </>;
  if (task === 'remove_edge_spurs') params = <><NumberField label={t('sf_radius_px')} value={config.componentOpeningRadiusPx} min={1} max={32} onChange={(value) => update({ componentOpeningRadiusPx: Math.trunc(value) })} /><NumberField label={t('sf_iterations')} value={config.componentOpeningIterations} min={1} max={8} onChange={(value) => update({ componentOpeningIterations: Math.trunc(value) })} /></>;
  if (task === 'shortest_bridge') params = <><NumberField label={t('sf_gap_max')} value={config.componentBridgeMaxGapPx} min={1} max={256} onChange={(value) => update({ componentBridgeMaxGapPx: Math.trunc(value) })} /><NumberField label={t('sf_bridge_width')} value={config.componentBridgeWidthPx} min={1} max={64} onChange={(value) => update({ componentBridgeWidthPx: Math.trunc(value) })} /><Select size="small" value={config.componentBridgeTopology} onChange={(event) => update({ componentBridgeTopology: event.target.value as SmartFilterConfig['componentBridgeTopology'] })}><MenuItem value="mst">MST</MenuItem><MenuItem value="main_only">{t('sf_bridge_main')}</MenuItem></Select><FormControlLabel control={<Checkbox checked={config.componentGapAvoidOtherInstances} onChange={(event) => update({ componentGapAvoidOtherInstances: event.target.checked })} />} label={t('sf_gap_collision')} /></>;
  if (task === 'morph_close') params = <><NumberField label={t('sf_closing_radius')} value={config.componentClosingRadiusPx} min={1} max={128} onChange={(value) => update({ componentClosingRadiusPx: Math.trunc(value) })} /><NumberField label={t('sf_iterations')} value={config.componentClosingIterations} min={1} max={8} onChange={(value) => update({ componentClosingIterations: Math.trunc(value) })} /><FormControlLabel control={<Checkbox checked={config.componentGapAvoidOtherInstances} onChange={(event) => update({ componentGapAvoidOtherInstances: event.target.checked })} />} label={t('sf_gap_collision')} /></>;
  if (task === 'fill_small_holes') params = <><FormControlLabel control={<Checkbox checked={config.componentHoleAbsAreaEnabled} onChange={(event) => update({ componentHoleAbsAreaEnabled: event.target.checked })} />} label={t('sf_component_abs')} /><NumberField label={t('sf_max_area_px')} value={config.componentMaxHoleAreaPx} onChange={(value) => update({ componentMaxHoleAreaPx: Math.trunc(value) })} /><FormControlLabel control={<Checkbox checked={config.componentHoleRelativeAreaEnabled} onChange={(event) => update({ componentHoleRelativeAreaEnabled: event.target.checked })} />} label={t('sf_component_relative')} /><NumberField label={t('sf_max_main_ratio')} value={config.componentMaxHoleMainRatio} step={0.0001} onChange={(value) => update({ componentMaxHoleMainRatio: value })} /><ToggleButtonGroup exclusive size="small" value={config.componentHoleRequireAllThresholds ? 'and' : 'or'} onChange={(_event, value) => value && update({ componentHoleRequireAllThresholds: value === 'and' })}><ToggleButton value="and">AND</ToggleButton><ToggleButton value="or">OR</ToggleButton></ToggleButtonGroup></>;
  if (task === 'deduplicate_same_class') params = <><Select size="small" value={config.spatialMode} onChange={(event) => update({ spatialMode: event.target.value as SmartFilterConfig['spatialMode'] })}><MenuItem value="instance_cover">{t('sf_spatial_instance')}</MenuItem><MenuItem value="bbox_cover">{t('sf_spatial_bbox')}</MenuItem></Select><NumberField label={t('sf_coverage')} value={config.coverageThreshold} min={0} max={1} step={0.001} onChange={(value) => update({ coverageThreshold: value })} /></>;
  if (task === 'remove_small_instances') params = <NumberField label={t('sf_max_area_ratio')} value={config.maxAreaRatio} min={0} max={1} step={0.001} onChange={(value) => update({ maxAreaRatio: value })} />;
  if (task === 'remove_confidence_range') params = <><NumberField label={t('sf_min_confidence')} value={config.minConfidence} min={0} max={1} step={0.001} onChange={(value) => update({ minConfidence: value })} /><NumberField label={t('sf_max_confidence')} value={config.maxConfidence} min={0} max={1} step={0.001} onChange={(value) => update({ maxConfidence: value })} /></>;
  if (task === 'remove_position_region') params = <><NumberField label={t('sf_center_width')} value={config.centerXHalfWidth} min={0} max={0.5} step={0.01} onChange={(value) => update({ centerXHalfWidth: value })} /><NumberField label={t('sf_center_height')} value={config.centerYHalfHeight} min={0} max={0.5} step={0.01} onChange={(value) => update({ centerYHalfHeight: value })} /><ToggleButtonGroup exclusive size="small" value={config.positionMatchMode} onChange={(_event, value) => value && update({ positionMatchMode: value })}><ToggleButton value="inside">{t('sf_inside')}</ToggleButton><ToggleButton value="outside">{t('sf_outside')}</ToggleButton></ToggleButtonGroup></>;
  if (task === 'delete_by_box_count') params = <><NumberField label={t('sf_min_instances')} value={config.minInstances} onChange={(value) => update({ minInstances: Math.trunc(value) })} /><NumberField label={t('sf_max_instances')} value={config.maxInstances} onChange={(value) => update({ maxInstances: Math.trunc(value) })} /><Typography sx={{ fontSize: 11, color: 'warning.main' }}>{t('sf_box_count_warning')}</Typography></>;
  if (task === 'normalize_classes') params = <Select size="small" value={config.canonicalClass} displayEmpty onChange={(event) => update({ canonicalClass: String(event.target.value) })}><MenuItem value="" disabled>{t('sf_target_class')}</MenuItem>{classes.map((name) => <MenuItem key={name} value={name}>{name}</MenuItem>)}</Select>;
  if (task === 'delete_unlabeled_images') params = <Typography sx={{ color: 'error.main', fontSize: 12 }}>{t('sf_unlabeled_permanent_warning')}</Typography>;

  return <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>{scope}<Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>{params}</Box></Box>;
}
