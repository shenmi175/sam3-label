import type { SmartFilterJobResult } from '../../api/filters';
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

export type PreviewArtworkIssue = 'service_outdated' | 'source_unavailable' | 'render_failed' | 'selection_unavailable';

export function previewArtworkIssue(result: SmartFilterJobResult | null): PreviewArtworkIssue | null {
  if (!result || Number(result.image_count || 0) <= 0 || (result.preview_samples?.length || 0) > 0) return null;
  const artwork = result.preview_artwork;
  if (!artwork) return 'service_outdated';
  if (artwork.status === 'failed') {
    if (artwork.error_code === 'source_unavailable' || artwork.error_code === 'selection_unavailable') return artwork.error_code;
    return 'render_failed';
  }
  return 'render_failed';
}

/** Human-readable summary derived only from the selected task. */
export function buildRuleText(
  config: SmartFilterConfig,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const scope = config.classScopeMode === 'all' ? t('sf_scope_all') : config.ruleClasses.join(', ');
  const chunks = [`${t(`sf_task_${config.taskType}`)} · ${t('sf_class_scope')}: ${scope}`];
  if (config.taskType === 'remove_small_components') chunks.push(`≤ ${config.componentMaxAreaPx}px / ${config.componentMaxMainRatio} (${config.componentRequireAllThresholds ? 'AND' : 'OR'})`);
  if (config.taskType === 'remove_edge_spurs') chunks.push(`r=${config.componentOpeningRadiusPx}px × ${config.componentOpeningIterations}`);
  if (config.taskType === 'shortest_bridge') chunks.push(`gap≤${config.componentBridgeMaxGapPx}px, width=${config.componentBridgeWidthPx}px, ${config.componentBridgeTopology}`);
  if (config.taskType === 'morph_close') chunks.push(`r=${config.componentClosingRadiusPx}px × ${config.componentClosingIterations}`);
  if (config.taskType === 'fill_small_holes') chunks.push(`≤ ${config.componentMaxHoleAreaPx}px / ${config.componentMaxHoleMainRatio} (${config.componentHoleRequireAllThresholds ? 'AND' : 'OR'})`);
  if (config.taskType === 'deduplicate_same_class') chunks.push(`${config.spatialMode} ≥ ${config.coverageThreshold}`);
  if (config.taskType === 'remove_small_instances') chunks.push(`ratio ≤ ${config.maxAreaRatio}`);
  if (config.taskType === 'remove_confidence_range') chunks.push(`[${config.minConfidence}, ${config.maxConfidence}]`);
  if (config.taskType === 'remove_position_region') chunks.push(`${config.positionMatchMode}, ${config.centerXHalfWidth} × ${config.centerYHalfHeight}`);
  if (config.taskType === 'delete_by_box_count') chunks.push(`${config.minInstances}–${config.maxInstances || '∞'} bbox`);
  if (config.taskType === 'normalize_classes') chunks.push(`→ ${config.canonicalClass || '--'}`);
  if (config.taskType === 'delete_unlabeled_images') chunks.push(t('sf_unlabeled_permanent_warning'));
  return chunks.join(' ');
}
