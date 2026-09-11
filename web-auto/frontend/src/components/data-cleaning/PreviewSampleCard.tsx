import { Box, Card, CardContent, Chip, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import type { FilterOperationMode, FilterPreviewSample, FilterResultItem } from '../../api/filters';
import { BeforeAfterCompare } from './BeforeAfterCompare';
import { num } from './shared';

interface PreviewSampleCardProps {
  sample: FilterPreviewSample;
  item?: FilterResultItem;
  operationMode: FilterOperationMode;
}

export function PreviewSampleCard({ sample, item = {}, operationMode }: PreviewSampleCardProps) {
  const { t } = useTranslation();
  const sampleName = sample.rel_path || sample.image_id || '--';
  const geometryLabel = sample.geometry_type ? t(`sf_preview_geometry_${sample.geometry_type}`) : '';
  const annotationCount = num(sample.annotation_count);
  const candidateCount = sample.candidate_count ?? num(item.candidate_count);
  const relabelCount = sample.relabel_count ?? num(item.relabel_count);
  const groups = Array.isArray(item.component_decisions) ? item.component_decisions : [];
  const decisions = groups.flatMap((group) => {
    if (!group || typeof group !== 'object') return [];
    const values = (group as Record<string, unknown>).decisions;
    return Array.isArray(values) ? values : [];
  }).filter((decision) => decision && typeof decision === 'object').slice(0, 3) as Record<string, unknown>[];

  let subtitle = t(sample.annotation_count == null ? 'sf_preview_sample_rule' : 'sf_preview_sample_rule_total', {
    total: annotationCount,
    count: candidateCount,
  });
  if (operationMode === 'component_noise') {
    subtitle = t('sf_pixel_changes', {
      removed: num(sample.removed_pixels ?? item.removed_pixels),
      added: num(sample.added_pixels ?? (num(item.bridge_pixels) + num(item.filled_pixels))),
    });
  } else if (operationMode === 'merge') {
    subtitle = t(sample.annotation_count == null ? 'sf_preview_sample_merge' : 'sf_preview_sample_merge_total', {
      total: annotationCount,
      deleted: candidateCount,
      relabeled: relabelCount,
    });
  } else if (operationMode === 'delete_unlabeled') {
    subtitle = t('sf_preview_sample_delete_image');
  }
  if (operationMode !== 'component_noise' && sample.geometry_type && sample.geometry_type !== 'image' && candidateCount === 0 && relabelCount === 0) {
    subtitle = t('sf_preview_sample_no_geometry_changes', { count: num(sample.annotation_count) });
  }

  return (
    <Card variant="outlined">
      <CardContent sx={{ p: 1, '&:last-child': { pb: 1 } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography noWrap sx={{ minWidth: 0, flex: 1, fontSize: 12, fontWeight: 700 }}>{sampleName}</Typography>
          {geometryLabel && <Chip size="small" label={geometryLabel} />}
        </Box>
        <Typography sx={{ fontSize: 10, color: 'text.secondary' }}>{subtitle}</Typography>
      </CardContent>
      <Box sx={{ px: 1, pb: 1 }}>
        <BeforeAfterCompare
          beforeUrl={sample.before_url}
          afterUrl={sample.after_url}
          diffUrl={sample.diff_url}
          beforeDetailUrl={sample.before_detail_url}
          afterDetailUrl={sample.after_detail_url}
          diffDetailUrl={sample.diff_detail_url}
          sampleName={geometryLabel ? `${sampleName} · ${geometryLabel}` : sampleName}
        />
      </Box>
      {operationMode === 'component_noise' && decisions.length > 0 && (
        <CardContent sx={{ p: 1, pt: 0, '&:last-child': { pb: 1 } }}>
          {decisions.map((decision, decisionIndex) => (
            <Typography key={`${String(decision.stage || decision.action)}-${decisionIndex}`} noWrap sx={{ fontSize: 9, color: 'text.secondary' }}>
              {t('sf_component_decision', {
                area: num(decision.area),
                ratio: (num(decision.main_ratio) * 100).toFixed(3),
                action: t(`sf_action_${String(decision.action || 'unknown')}`),
              })}
            </Typography>
          ))}
        </CardContent>
      )}
    </Card>
  );
}
