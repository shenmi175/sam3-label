import {
  Box,
  Checkbox,
  FormControlLabel,
  MenuItem,
  Select,
  Slider,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../stores/workspace/projectStore';
import {
  useSmartFilterStore,
  type SmartFilterConfig,
} from '../../stores/workspace/smartFilterStore';
import { labelSx, selectSx, toggleListValue } from './shared';

/**
 * Data-cleaning merge-mode configuration — merge mode / spatial / area
 * selects, the canonical target+source class pickers and the coverage
 * threshold slider. Rendered only when operationMode === 'merge'.
 */
export function MergeModeConfig() {
  const { t } = useTranslation();
  const classes = useProjectStore((s) => s.classes);
  const config = useSmartFilterStore((s) => s.config);

  const update = (partial: Partial<SmartFilterConfig>) =>
    useSmartFilterStore.getState().updateConfig(partial);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      <Box>
        <Typography component="label" sx={labelSx}>{t('sf_merge_mode')}</Typography>
        <Select size="small" value={config.mergeMode} onChange={(e) => update({ mergeMode: e.target.value as SmartFilterConfig['mergeMode'] })} sx={selectSx}>
          <MenuItem value="same_class">{t('sf_merge_same')}</MenuItem>
          <MenuItem value="canonical_class">{t('sf_merge_canonical')}</MenuItem>
        </Select>
      </Box>
      <Box>
        <Typography component="label" sx={labelSx}>{t('sf_spatial')}</Typography>
        <Select size="small" value={config.spatialMode} onChange={(e) => update({ spatialMode: e.target.value as SmartFilterConfig['spatialMode'] })} sx={selectSx}>
          <MenuItem value="instance_cover">{t('sf_spatial_instance')}</MenuItem>
          <MenuItem value="bbox_cover">{t('sf_spatial_bbox')}</MenuItem>
        </Select>
      </Box>
      <Box>
        <Typography component="label" sx={labelSx}>{t('sf_area')}</Typography>
        <Select size="small" value={config.areaMode} onChange={(e) => update({ areaMode: e.target.value as SmartFilterConfig['areaMode'] })} sx={selectSx}>
          <MenuItem value="instance">{t('sf_area_instance')}</MenuItem>
          <MenuItem value="bbox">{t('sf_area_bbox')}</MenuItem>
        </Select>
      </Box>

      {config.mergeMode === 'canonical_class' && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, p: 1.25, borderRadius: 1.5, bgcolor: 'action.hover' }}>
          <Box>
            <Typography component="label" sx={labelSx}>{t('sf_target_class')}</Typography>
            <Select size="small" value={config.canonicalClass || (classes[0] ?? '')} onChange={(e) => update({ canonicalClass: String(e.target.value) })} sx={selectSx}>
              {classes.map((cls) => (
                <MenuItem key={cls} value={cls}>{cls}</MenuItem>
              ))}
            </Select>
          </Box>
          <Box>
            <Typography component="label" sx={labelSx}>{t('sf_source_classes')}</Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', maxHeight: 140, overflowY: 'auto' }}>
              {classes.map((cls) => (
                <FormControlLabel
                  key={cls}
                  sx={{ m: 0 }}
                  control={
                    <Checkbox
                      size="small"
                      checked={config.sourceClasses.includes(cls)}
                      onChange={(e) => update({ sourceClasses: toggleListValue(config.sourceClasses, cls, e.target.checked) })}
                    />
                  }
                  label={<Typography sx={{ fontSize: 12 }}>{cls}</Typography>}
                />
              ))}
            </Box>
          </Box>
        </Box>
      )}

      <Box>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography component="label" sx={labelSx}>{t('sf_coverage')}</Typography>
          <Typography sx={{ fontSize: 12, fontWeight: 700, color: 'primary.main' }}>
            {config.coverageThreshold.toFixed(2)}
          </Typography>
        </Box>
        <Slider
          size="small"
          min={0.5}
          max={1}
          step={0.01}
          value={config.coverageThreshold}
          onChange={(_, value) => update({ coverageThreshold: Number(value) })}
        />
        <Typography sx={{ fontSize: 10, color: 'text.secondary' }}>{t('sf_coverage_hint')}</Typography>
      </Box>
    </Box>
  );
}
