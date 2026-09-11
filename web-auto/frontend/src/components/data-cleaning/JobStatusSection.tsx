import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, LinearProgress, Tab, Tabs, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useSmartFilterStore } from '../../stores/workspace/smartFilterStore';
import type { FilterOperationMode, FilterPreviewSample, FilterResultItem, SmartFilterJobResult } from '../../api/filters';
import { num, previewArtworkIssue } from './shared';
import { PreviewSampleCard } from './PreviewSampleCard';

function PreviewSamplesSection({
  samples,
  items,
  operationMode,
}: {
  samples: FilterPreviewSample[];
  items: FilterResultItem[];
  operationMode: FilterOperationMode;
}) {
  const { t } = useTranslation();
  const preferredIndex = Math.max(0, samples.findIndex((sample) => num(sample.candidate_count) + num(sample.relabel_count) > 0));
  const signature = useMemo(
    () => samples.map((sample) => `${sample.geometry_type || sample.kind}:${sample.before_url}:${sample.after_url}`).join('|'),
    [samples],
  );
  const [selectedIndex, setSelectedIndex] = useState(preferredIndex);
  useEffect(() => setSelectedIndex(preferredIndex), [preferredIndex, signature]);
  if (samples.length === 0) return null;
  const safeIndex = Math.min(selectedIndex, samples.length - 1);
  const sample = samples[safeIndex];
  const item = items.find((row) => String(row.image_id || '') === sample.image_id);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {samples.length > 1 && (
        <Tabs
          value={safeIndex}
          onChange={(_event, value) => setSelectedIndex(Number(value))}
          variant="fullWidth"
          aria-label={t('sf_samples')}
          sx={{ minHeight: 36, '& .MuiTab-root': { minHeight: 36, py: 0.5 } }}
        >
          {samples.map((row) => {
            const changes = num(row.candidate_count) + num(row.relabel_count);
            const geometry = row.geometry_type ? t(`sf_preview_geometry_${row.geometry_type}`) : t('sf_preview_geometry_image');
            return (
              <Tab
                key={`${row.geometry_type || row.kind}-${row.before_url}`}
                label={`${row.rel_path} · ${geometry} · ${operationMode === 'component_noise' ? t('sf_pixel_changes', { removed: num(row.removed_pixels), added: num(row.added_pixels) }) : t('sf_preview_tab_changes', { count: changes })}`}
              />
            );
          })}
        </Tabs>
      )}
      <PreviewSampleCard key={sample.before_url} sample={sample} item={item} operationMode={operationMode} />
    </Box>
  );
}

/** Legacy renderFilterSummary — stats header + up to 30 per-image items. */
function FilterSummary({ result, kind, op }: { result: SmartFilterJobResult; kind: 'preview' | 'apply'; op: string }) {
  const { t } = useTranslation();
  const items = Array.isArray(result.items) ? result.items : [];
  const previewSamples = kind === 'preview' && Array.isArray(result.preview_samples)
    ? result.preview_samples
    : [];
  const previewCards = previewSamples.length > 0 ? (
    <PreviewSamplesSection
      samples={previewSamples}
      items={items}
      operationMode={op as FilterOperationMode}
    />
  ) : null;

  if (op === 'component_noise') {
    const cards = [
      { value: kind === 'preview' ? num(result.image_count) : num(result.changed_images), label: kind === 'preview' ? t('sf_hit_images') : t('sf_changed_images') },
      { value: num(result.modified_annotations), label: t('sf_modified_instances') },
      { value: num(result.removed_components), label: t('sf_removed_components') },
      { value: num(result.removed_pixels), label: t('sf_removed_pixels') },
    ];
    const topologyCards = [
      { value: num(result.opening_removed_pixels), label: t('sf_opening_removed_pixels') },
      { value: num(result.bridges_added), label: t('sf_bridges_added') },
      { value: num(result.bridge_pixels), label: t('sf_bridge_pixels') },
      { value: num(result.filled_holes), label: t('sf_filled_holes') },
      { value: num(result.filled_pixels), label: t('sf_filled_pixels') },
      { value: num(result.collision_rejected_bridges), label: t('sf_collision_rejected') },
    ];
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 1 }}>
          {cards.map((card) => <Box key={card.label} sx={{ p: 1, borderRadius: 1.5, bgcolor: 'action.hover', textAlign: 'center' }}><Typography sx={{ fontWeight: 800 }}>{card.value}</Typography><Typography sx={{ fontSize: 10, color: 'text.secondary' }}>{card.label}</Typography></Box>)}
        </Box>
        {topologyCards.some((card) => card.value > 0) && (
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 1 }}>
            {topologyCards.map((card) => <Box key={card.label} sx={{ p: 1, borderRadius: 1.5, bgcolor: 'action.hover', textAlign: 'center' }}><Typography sx={{ fontWeight: 800 }}>{card.value}</Typography><Typography sx={{ fontSize: 10, color: 'text.secondary' }}>{card.label}</Typography></Box>)}
          </Box>
        )}
        {previewCards}
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, fontSize: 10, color: 'text.secondary' }}>
          <span>{t('sf_diff_legend')}</span>
        </Box>
        {num(result.incomplete_collision_checks) > 0 && (
          <Typography sx={{ fontSize: 11, color: 'warning.main' }}>{t('sf_collision_incomplete', { count: num(result.incomplete_collision_checks) })}</Typography>
        )}
        <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{t('sf_skipped_instances', { count: num(result.skipped_annotations) })}</Typography>
      </Box>
    );
  }

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
        {previewCards}
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
      {previewCards}
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
 * Data-cleaning task status area — job progress bar, live job message and
 * the preview/apply result summaries. Reads all state from smartFilterStore.
 */
export function JobStatusSection() {
  const { t } = useTranslation();
  const jobRunning = useSmartFilterStore((s) => s.jobRunning);
  const progressPct = useSmartFilterStore((s) => s.progressPct);
  const jobMessage = useSmartFilterStore((s) => s.jobMessage);
  const jobFailed = useSmartFilterStore((s) => s.jobFailed);
  const previewResult = useSmartFilterStore((s) => s.previewResult);
  const applyResult = useSmartFilterStore((s) => s.applyResult);
  const operationMode = useSmartFilterStore((s) => s.config.operationMode);
  const hasPreviewArtwork = Boolean(previewResult?.preview_samples?.length);
  const artworkIssue = previewArtworkIssue(previewResult);

  return (
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
      {artworkIssue && (
        <Alert severity="warning" sx={{ fontSize: 11 }}>
          {t(`sf_preview_artwork_${artworkIssue}`)} {t('sf_preview_artwork_apply_allowed')}
        </Alert>
      )}
      <Box sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        maxHeight: hasPreviewArtwork ? 'none' : 260,
        overflowY: hasPreviewArtwork ? 'visible' : 'auto',
      }}>
        {previewResult && <FilterSummary result={previewResult} kind="preview" op={String(previewResult.operation_mode || operationMode)} />}
        {applyResult && <FilterSummary result={applyResult} kind="apply" op={String(applyResult.operation_mode || operationMode)} />}
      </Box>
    </Box>
  );
}
