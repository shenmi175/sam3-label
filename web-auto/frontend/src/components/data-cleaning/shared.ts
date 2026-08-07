import type { SmartFilterConfig } from '../../stores/workspace/smartFilterStore';

/** Coerce an unknown API/store value to a finite number. */
export const num = (value: unknown, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** Toggle a value inside a string list (class checkbox lists). */
export const toggleListValue = (list: string[], value: string, checked: boolean) =>
  checked ? [...list, value] : list.filter((v) => v !== value);

/** Compact form-field styling shared by the data-cleaning sub-panels. */
export const selectSx = { fontSize: 12, height: 32, width: '100%' };
export const labelSx = {
  fontSize: 11,
  fontWeight: 700,
  color: 'text.secondary',
  mb: 0.5,
  display: 'block',
} as const;

/** Legacy updateRuleText — human-readable execution summary. */
export function buildRuleText(
  config: SmartFilterConfig,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
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
