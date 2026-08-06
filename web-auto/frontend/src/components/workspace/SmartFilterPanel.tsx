import { useMemo } from 'react';
import {
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  IconButton,
  LinearProgress,
  MenuItem,
  Select,
  Slider,
  TextField,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../stores/workspace/projectStore';
import {
  useSmartFilterStore,
  type SmartFilterConfig,
} from '../../stores/workspace/smartFilterStore';
import type { SmartFilterJobResult } from '../../api/filters';
import { useSmartFilterJob } from '../../hooks/useSmartFilterJob';

interface SmartFilterPanelProps {
  projectId: string;
  onClose: () => void;
}

const num = (value: unknown, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** Legacy updateRuleText — human-readable execution summary. */
function buildRuleText(config: SmartFilterConfig, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const pct = `${Math.round(config.coverageThreshold * 100)}%`;
  const spatialLabel = config.spatialMode === 'bbox_cover' ? t('sf_spatial_bbox') : t('sf_spatial_instance');
  const areaLabel = config.areaMode === 'bbox' ? t('sf_area_bbox') : t('sf_area_instance');
  const chunks: string[] = [];

  if (config.operationMode === 'delete_unlabeled') {
    chunks.push(t('sf_ruletext_delete_1'));
    chunks.push(t('sf_ruletext_delete_2'));
  } else if (config.operationMode === 'merge') {
    if (config.mergeMode === 'same_class') {
      chunks.push(t('sf_ruletext_merge_same', { spatial: spatialLabel, pct }));
    } else {
      chunks.push(
        t('sf_ruletext_merge_canonical', {
          spatial: spatialLabel,
          sources: config.sourceClasses.join(', ') || t('sf_not_selected'),
          target: config.canonicalClass || '--',
          pct,
        }),
      );
    }
    if (config.spatialMode === 'instance_cover') chunks.push(t('sf_ruletext_instance_note'));
    chunks.push(t('sf_ruletext_keep', { area: areaLabel }));
  } else {
    chunks.push(
      t('sf_ruletext_rule_head', {
        classes: config.ruleClasses.length > 0 ? config.ruleClasses.join(', ') : t('sf_not_selected'),
      }),
    );
    if (config.smallTargetEnabled) chunks.push(t('sf_ruletext_small', { ratio: config.maxAreaRatio }));
    if (config.instanceCountEnabled) {
      chunks.push(
        t('sf_ruletext_count', {
          min: config.minInstances,
          max: config.maxInstances > 0 ? String(config.maxInstances) : t('sf_unlimited'),
        }),
      );
    }
    if (config.positionEnabled) {
      chunks.push(t('sf_ruletext_pos', { x: config.centerXHalfWidth, y: config.centerYHalfHeight }));
    }
    if (config.confidenceEnabled) {
      chunks.push(t('sf_ruletext_conf', { min: config.minConfidence, max: config.maxConfidence }));
    }
    if (chunks.length === 1) chunks.push(t('sf_ruletext_need_one'));
  }
  return chunks.join(' ');
}

/** Legacy renderFilterSummary — stats header + up to 30 per-image items. */
function FilterSummary({ result, kind, op }: { result: SmartFilterJobResult; kind: 'preview' | 'apply'; op: string }) {
  const { t } = useTranslation();
  const items = Array.isArray(result.items) ? result.items : [];

  if (op === 'delete_unlabeled') {
    const deletedImages = kind === 'preview' ? num(result.image_count) : num(result.deleted_images ?? result.changed_images);
    const secondCount = kind === 'preview' ? num(result.candidate_count) : num(result.deleted_image_files);
    const failedCount = Array.isArray(result.failed_deletes) ? result.failed_deletes.length : 0;
    const cards = [
      { value: deletedImages, label: kind === 'preview' ? t('sf_pending_images') : t('sf_deleted_images') },
      { value: secondCount, label: kind === 'preview' ? t('sf_hit_samples') : t('sf_image_files') },
      { value: kind === 'preview' ? 0 : num(result.deleted_annotation_files), label: t('sf_annotation_json') },
      { value: failedCount, label: t('sf_file_failed') },
    ];
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 1 }}>
          {cards.map((card) => (
            <Box key={card.label} sx={{ p: 1, borderRadius: 1.5, bgcolor: 'action.hover', textAlign: 'center' }}>
              <Typography sx={{ fontWeight: 800, fontSize: 14 }}>{card.value}</Typography>
              <Typography sx={{ fontSize: 10, color: 'text.secondary' }}>{card.label}</Typography>
            </Box>
          ))}
        </Box>
        {items.length === 0 && (
          <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{t('sf_no_unlabeled')}</Typography>
        )}
        {items.slice(0, 30).map((item, idx) => (
          <Box key={String(item.image_id || idx)} sx={{ p: 1, px: 1.5, borderRadius: 1.5, bgcolor: 'action.hover' }}>
            <Typography sx={{ fontSize: 12, fontWeight: 700 }} noWrap>
              {String(item.rel_path || item.image_id || '--')}
            </Typography>
            <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
              {kind === 'preview'
                ? t('sf_item_delete_hint')
                : `${item.deleted_image_file ? t('sf_orig_deleted') : t('sf_orig_missing')} · ${
                    item.deleted_annotation_file ? t('sf_json_deleted') : t('sf_json_missing')
                  }`}
            </Typography>
          </Box>
        ))}
      </Box>
    );
  }

  const imageCount = kind === 'preview' ? num(result.image_count) : num(result.changed_images);
  const candidateCount = kind === 'preview' ? num(result.candidate_count) : num(result.removed_annotations);
  const relabelCount = kind === 'preview' ? num(result.relabel_count) : num(result.relabeled_annotations);
  const cards = [
    { value: imageCount, label: kind === 'preview' ? t('sf_hit_images') : t('sf_changed_images') },
    { value: candidateCount, label: kind === 'preview' ? t('sf_to_delete') : t('sf_deleted_anns') },
    { value: relabelCount, label: kind === 'preview' ? t('sf_to_relabel') : t('sf_relabeled_anns') },
  ];
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 1 }}>
        {cards.map((card) => (
          <Box key={card.label} sx={{ p: 1, borderRadius: 1.5, bgcolor: 'action.hover', textAlign: 'center' }}>
            <Typography sx={{ fontWeight: 800, fontSize: 14 }}>{card.value}</Typography>
            <Typography sx={{ fontSize: 10, color: 'text.secondary' }}>{card.label}</Typography>
          </Box>
        ))}
      </Box>
      {items.length === 0 && (
        <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
          {op === 'merge' ? t('sf_no_merge_candidates') : t('sf_no_rule_hits')}
        </Typography>
      )}
      {items.slice(0, 30).map((item, idx) => (
        <Box key={String(item.image_id || idx)} sx={{ p: 1, px: 1.5, borderRadius: 1.5, bgcolor: 'action.hover' }}>
          <Typography sx={{ fontSize: 12, fontWeight: 700 }} noWrap>
            {String(item.rel_path || item.image_id || '--')}
          </Typography>
          <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
            {kind === 'preview'
              ? op === 'merge'
                ? t('sf_item_preview_deleted', { count: num(item.candidate_count) })
                : t('sf_item_hit_pending', { count: num(item.candidate_count) })
              : t('sf_item_deleted_n', { count: num(item.removed_count) })}
            {op === 'merge' ? ` · ${t('sf_item_relabel_n', { count: num(item.relabel_count) })}` : ''}
            {op === 'merge' && item.scoped_annotation_count != null
              ? ` · ${t('sf_item_scoped_n', { count: num(item.scoped_annotation_count) })}`
              : ''}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

/**
 * Smart filter workbench — 1:1 port of the legacy modal-filter-full panel
 * (smart-filter-panel.js + SmartFilterController), re-laid out as a stacked
 * right-column panel. Preview → apply job flow, runs/latest rollback panel.
 */
export function SmartFilterPanel({ projectId, onClose }: SmartFilterPanelProps) {
  const { t } = useTranslation();
  const classes = useProjectStore((s) => s.classes);

  const config = useSmartFilterStore((s) => s.config);
  const activePreset = useSmartFilterStore((s) => s.activePreset);
  const jobRunning = useSmartFilterStore((s) => s.jobRunning);
  const progressPct = useSmartFilterStore((s) => s.progressPct);
  const jobMessage = useSmartFilterStore((s) => s.jobMessage);
  const jobFailed = useSmartFilterStore((s) => s.jobFailed);
  const previewToken = useSmartFilterStore((s) => s.previewToken);
  const previewResult = useSmartFilterStore((s) => s.previewResult);
  const applyResult = useSmartFilterStore((s) => s.applyResult);
  const latestRun = useSmartFilterStore((s) => s.latestRun);
  const rollbackBusy = useSmartFilterStore((s) => s.rollbackBusy);

  // Runs/latest restore + post-apply/rollback workspace refresh.
  useSmartFilterJob(projectId);

  const update = (partial: Partial<SmartFilterConfig>) =>
    useSmartFilterStore.getState().updateConfig(partial);

  const ruleText = useMemo(() => buildRuleText(config, t), [config, t]);

  const isMerge = config.operationMode === 'merge';
  const isRule = config.operationMode === 'rule';

  const toggleListValue = (list: string[], value: string, checked: boolean) =>
    checked ? [...list, value] : list.filter((v) => v !== value);

  const handleApplyClick = () => {
    const confirmText =
      config.operationMode === 'merge'
        ? t('sf_confirm_merge')
        : config.operationMode === 'delete_unlabeled'
          ? t('sf_confirm_delete_unlabeled')
          : t('sf_confirm_rule');
    if (!window.confirm(confirmText)) return;
    void useSmartFilterStore.getState().startApply();
  };

  const handleRollbackClick = () => {
    if (!window.confirm(t('sf_rollback_confirm'))) return;
    void useSmartFilterStore.getState().rollbackLatestRun();
  };

  const selectSx = { fontSize: 12, height: 32, width: '100%' };
  const labelSx = { fontSize: 11, fontWeight: 700, color: 'text.secondary', mb: 0.5, display: 'block' };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, p: 2, overflowY: 'auto' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Box>
          <Typography sx={{ fontSize: 14, fontWeight: 800 }}>{t('sf_title')}</Typography>
          <Typography sx={{ fontSize: 10, color: 'text.secondary' }}>{t('sf_subtitle')}</Typography>
        </Box>
        <IconButton size="small" onClick={onClose} aria-label={t('close')} sx={{ color: '#ef4444' }}>
          {'\u00D7'}
        </IconButton>
      </Box>

      {/* Rollback panel (legacy filter-rollback-panel) */}
      {latestRun?.run_id && (
        <Box sx={{ p: 1.5, borderRadius: 1.5, bgcolor: 'action.hover' }}>
          <Typography sx={{ fontSize: 12, fontWeight: 800 }}>{t('sf_rollback_title')}</Typography>
          <Typography sx={{ fontSize: 11, color: 'text.secondary', lineHeight: 1.6 }}>
            {t('sf_rollback_desc', {
              changed: num(latestRun.summary?.changed_images ?? latestRun.snapshot_count),
              removed: num(latestRun.summary?.removed_annotations),
              relabeled: num(latestRun.summary?.relabeled_annotations),
            })}
          </Typography>
          <Button
            size="small"
            variant="outlined"
            color="error"
            disabled={rollbackBusy}
            onClick={handleRollbackClick}
            sx={{ mt: 1, fontSize: 11, fontWeight: 700 }}
          >
            {rollbackBusy ? t('sf_rollback_running') : t('sf_rollback_btn')}
          </Button>
        </Box>
      )}

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
            variant={config.operationMode === mode ? 'contained' : 'outlined'}
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

      {/* Merge options */}
      {isMerge && (
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
      )}

      {/* Rule options */}
      {isRule && (
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

          <Box sx={{ p: 1.25, borderRadius: 1.5, bgcolor: 'action.hover' }}>
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

          <Box sx={{ p: 1.25, borderRadius: 1.5, bgcolor: 'action.hover' }}>
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

          <Box sx={{ p: 1.25, borderRadius: 1.5, bgcolor: 'action.hover' }}>
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

          <Box sx={{ p: 1.25, borderRadius: 1.5, bgcolor: 'action.hover' }}>
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
      )}

      {/* Execution summary text (legacy filter-rule-text) */}
      <Box sx={{ p: 1.25, borderRadius: 1.5, bgcolor: 'action.hover' }}>
        <Typography sx={{ fontSize: 10, fontWeight: 700, color: 'text.secondary', mb: 0.5 }}>
          {t('sf_exec_summary')}
        </Typography>
        <Typography sx={{ fontSize: 11, lineHeight: 1.6 }}>{ruleText}</Typography>
      </Box>

      {/* Job progress + results */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, p: 1.5, borderRadius: 1.5, border: '1px solid', borderColor: 'divider' }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography sx={{ fontSize: 11, fontWeight: 800, color: 'text.secondary' }}>{t('sf_task_progress')}</Typography>
          <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
            {jobRunning ? `${Math.round(progressPct)}%` : t('sf_idle')}
          </Typography>
        </Box>
        <LinearProgress
          variant="determinate"
          value={Math.min(100, Math.max(0, progressPct))}
          color={jobFailed ? 'error' : 'primary'}
          sx={{ height: 8, borderRadius: 999 }}
        />
        <Typography sx={{ fontSize: 12, minHeight: 18, color: jobFailed ? '#ef4444' : 'text.primary' }}>
          {jobMessage}
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 260, overflowY: 'auto' }}>
          {previewResult && <FilterSummary result={previewResult} kind="preview" op={String(previewResult.operation_mode || config.operationMode)} />}
          {applyResult && <FilterSummary result={applyResult} kind="apply" op={String(applyResult.operation_mode || config.operationMode)} />}
        </Box>
      </Box>

      {/* Actions */}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
        <Button size="small" onClick={onClose} sx={{ fontSize: 12 }}>{t('cancel')}</Button>
        <Button
          size="small"
          variant="outlined"
          disabled={jobRunning}
          onClick={() => void useSmartFilterStore.getState().startPreview()}
          sx={{ fontSize: 12, fontWeight: 700, color: 'primary.main' }}
        >
          {t('sf_start_preview')}
        </Button>
        {previewToken && !applyResult && (
          <Button
            size="small"
            variant="contained"
            color={isMerge ? 'success' : 'error'}
            disabled={jobRunning}
            onClick={handleApplyClick}
            sx={{ fontSize: 12, fontWeight: 700 }}
          >
            {isMerge ? t('sf_apply_merge') : config.operationMode === 'delete_unlabeled' ? t('sf_apply_delete_images') : t('sf_apply_delete_anns')}
          </Button>
        )}
      </Box>
    </Box>
  );
}
