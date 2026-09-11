import type { FilterTaskType, SmartFilterPayload } from '../../api/filters';
import { DEFAULT_CONFIG, buildPayload, taskOperation, type SmartFilterConfig } from '../../stores/workspace/smartFilterStore';

export const DATA_CLEANING_CONFIG_SCHEMA = 'web-auto.data-cleaning-config.v2';
const V1_SCHEMA = 'web-auto.data-cleaning-config.v1';

export interface ParsedCleaningConfig { config: SmartFilterConfig; warnings: string[] }

function fromTask(taskType: FilterTaskType, scope: SmartFilterPayload['class_scope'], params: Record<string, unknown>): SmartFilterConfig {
  const config: SmartFilterConfig = {
    ...DEFAULT_CONFIG,
    taskType,
    operationMode: taskOperation(taskType),
    classScopeMode: scope.mode,
    ruleClasses: [...scope.classes],
  };
  const number = (key: string, fallback: number) => typeof params[key] === 'number' && Number.isFinite(params[key]) ? Number(params[key]) : fallback;
  if (taskType === 'remove_small_components') Object.assign(config, { componentAbsAreaEnabled: Boolean(params.absolute_area_enabled), componentMaxAreaPx: number('max_area_px', 128), componentRelativeAreaEnabled: Boolean(params.relative_area_enabled), componentMaxMainRatio: number('max_main_ratio', 0.001), componentRequireAllThresholds: params.threshold_mode !== 'or' });
  if (taskType === 'remove_edge_spurs') Object.assign(config, { componentOpeningRadiusPx: number('radius_px', 1), componentOpeningIterations: number('iterations', 1) });
  if (taskType === 'shortest_bridge') Object.assign(config, { componentBridgeMaxGapPx: number('max_gap_px', 16), componentBridgeWidthPx: number('bridge_width_px', 3), componentBridgeTopology: params.topology === 'main_only' ? 'main_only' : 'mst', componentGapAvoidOtherInstances: params.avoid_other_instances !== false });
  if (taskType === 'morph_close') Object.assign(config, { componentClosingRadiusPx: number('radius_px', 8), componentClosingIterations: number('iterations', 1), componentGapAvoidOtherInstances: params.avoid_other_instances !== false });
  if (taskType === 'fill_small_holes') Object.assign(config, { componentHoleAbsAreaEnabled: Boolean(params.absolute_area_enabled), componentMaxHoleAreaPx: number('max_area_px', 128), componentHoleRelativeAreaEnabled: Boolean(params.relative_area_enabled), componentMaxHoleMainRatio: number('max_main_ratio', 0.001), componentHoleRequireAllThresholds: params.threshold_mode !== 'or' });
  if (taskType === 'deduplicate_same_class') Object.assign(config, { spatialMode: params.spatial_mode === 'bbox_cover' ? 'bbox_cover' : 'instance_cover', coverageThreshold: number('coverage_threshold', 0.98) });
  if (taskType === 'remove_small_instances') config.maxAreaRatio = number('max_image_ratio', 0.02);
  if (taskType === 'remove_confidence_range') Object.assign(config, { minConfidence: number('min_confidence', 0), maxConfidence: number('max_confidence', 1) });
  if (taskType === 'remove_position_region') Object.assign(config, { centerXHalfWidth: number('center_x_half_width', 0.25), centerYHalfHeight: number('center_y_half_height', 0.05), positionMatchMode: params.relation === 'inside' ? 'inside' : 'outside' });
  if (taskType === 'delete_by_box_count') Object.assign(config, { minInstances: number('min_boxes', 1), maxInstances: number('max_boxes', 0) });
  if (taskType === 'normalize_classes') config.canonicalClass = String(params.target_class || '');
  return config;
}

export function serializeDataCleaningConfig(config: SmartFilterConfig): string {
  const payload = buildPayload('__config__', config);
  return JSON.stringify({
    schema: DATA_CLEANING_CONFIG_SCHEMA,
    version: 2,
    exported_at: new Date().toISOString(),
    task_type: payload.task_type,
    class_scope: payload.class_scope,
    params: payload.params,
  }, null, 2);
}

function migrateV1(input: Record<string, unknown>): ParsedCleaningConfig {
  const legacy = { ...DEFAULT_CONFIG, ...input } as SmartFilterConfig;
  const conflicts: FilterTaskType[] = [];
  if (legacy.operationMode === 'component_noise') {
    if (legacy.componentAbsAreaEnabled || legacy.componentRelativeAreaEnabled) conflicts.push('remove_small_components');
    if (legacy.componentOpeningEnabled) conflicts.push('remove_edge_spurs');
    if (legacy.componentGapRepairEnabled) conflicts.push(legacy.componentGapRepairMethod === 'morph_close' ? 'morph_close' : 'shortest_bridge');
    if (legacy.componentHoleFillEnabled) conflicts.push('fill_small_holes');
  } else if (legacy.operationMode === 'rule') {
    if (legacy.smallTargetEnabled) conflicts.push('remove_small_instances');
    if (legacy.confidenceEnabled) conflicts.push('remove_confidence_range');
    if (legacy.positionEnabled) conflicts.push('remove_position_region');
    if (legacy.instanceCountEnabled) conflicts.push('delete_by_box_count');
  } else if (legacy.operationMode === 'delete_unlabeled') conflicts.push('delete_unlabeled_images');
  else if (legacy.mergeMode === 'canonical_class') conflicts.push('normalize_classes', 'deduplicate_same_class');
  else conflicts.push('deduplicate_same_class');
  if (conflicts.length !== 1) throw new Error(`ambiguous_v1:${conflicts.join(',')}`);
  legacy.taskType = conflicts[0];
  legacy.operationMode = taskOperation(conflicts[0]);
  legacy.classScopeMode = legacy.ruleClasses.length > 0 ? 'selected' : 'all';
  return { config: legacy, warnings: ['migrated:v1'] };
}

export function parseDataCleaningConfig(raw: string): ParsedCleaningConfig {
  let document: Record<string, unknown>;
  try { document = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error('invalid_json'); }
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('invalid_document');
  if (document.schema === V1_SCHEMA && document.version === 1) {
    if (!document.config || typeof document.config !== 'object' || Array.isArray(document.config)) throw new Error('invalid_config');
    return migrateV1(document.config as Record<string, unknown>);
  }
  if (document.schema !== DATA_CLEANING_CONFIG_SCHEMA || document.version !== 2) throw new Error('unsupported_schema');
  const taskType = String(document.task_type || '') as FilterTaskType;
  const validTasks: FilterTaskType[] = ['remove_small_components', 'remove_edge_spurs', 'shortest_bridge', 'morph_close', 'fill_small_holes', 'deduplicate_same_class', 'remove_small_instances', 'remove_confidence_range', 'remove_position_region', 'delete_by_box_count', 'normalize_classes', 'delete_unlabeled_images'];
  if (!validTasks.includes(taskType)) throw new Error('invalid_task_type');
  const scope = document.class_scope as SmartFilterPayload['class_scope'];
  const params = document.params as Record<string, unknown>;
  if (!scope || !['all', 'selected'].includes(scope.mode) || !Array.isArray(scope.classes) || !params || typeof params !== 'object' || Array.isArray(params)) throw new Error('invalid_config');
  const expectedKeys: Record<FilterTaskType, string[]> = {
    remove_small_components: ['absolute_area_enabled', 'max_area_px', 'relative_area_enabled', 'max_main_ratio', 'threshold_mode'],
    remove_edge_spurs: ['radius_px', 'iterations'],
    shortest_bridge: ['max_gap_px', 'bridge_width_px', 'topology', 'avoid_other_instances'],
    morph_close: ['radius_px', 'iterations', 'avoid_other_instances'],
    fill_small_holes: ['absolute_area_enabled', 'max_area_px', 'relative_area_enabled', 'max_main_ratio', 'threshold_mode'],
    deduplicate_same_class: ['spatial_mode', 'coverage_threshold'],
    remove_small_instances: ['max_image_ratio'],
    remove_confidence_range: ['min_confidence', 'max_confidence'],
    remove_position_region: ['center_x_half_width', 'center_y_half_height', 'relation'],
    delete_by_box_count: ['min_boxes', 'max_boxes'],
    normalize_classes: ['target_class'],
    delete_unlabeled_images: [],
  };
  const unknown = Object.keys(params).filter((key) => !expectedKeys[taskType].includes(key));
  if (unknown.length > 0) throw new Error(`invalid_task_params:${unknown.join(',')}`);
  const config = fromTask(taskType, scope, params);
  // Rebuild once so range and task-level constraints use the same validation
  // path as an interactive submission.
  buildPayload('__config__', config);
  return { config, warnings: [] };
}

export function unavailableConfiguredClasses(config: SmartFilterConfig, projectClasses: string[]): string[] {
  const available = new Set(projectClasses);
  const configured = new Set(config.classScopeMode === 'selected' ? config.ruleClasses : []);
  if (config.taskType === 'normalize_classes' && config.canonicalClass) configured.add(config.canonicalClass);
  return [...configured].filter((name) => !available.has(name)).sort();
}
