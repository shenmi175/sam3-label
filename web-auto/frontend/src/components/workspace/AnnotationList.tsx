import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, Chip, IconButton, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import type { Annotation } from '../../api/types';
import { useAnnotationStore } from '../../stores/workspace/annotationStore';
import { useViewerStore, filterAnnotationsBySource, type SourceFilter } from '../../stores/workspace/viewerStore';
import { getClassColor } from '../../utils/geometry';
import { annotationSource, hasSegmentationGeometry } from '../../utils/annotations';
import { AnnotationClassModal } from './AnnotationClassModal';

const SOURCE_OPTIONS: SourceFilter[] = ['sam3', 'locate-anything'];

function sourceFilterLabel(source: SourceFilter): string {
  if (source === 'locate-anything') return 'LA';
  return 'sam3';
}

function sourceTag(ann: Annotation): string {
  const source = annotationSource(ann);
  if (source === 'locate-anything') return 'LA';
  return '';
}

/**
 * Annotation list panel — 1:1 port of the legacy annotation-list.js +
 * source-filter-bar: source chips (SAM3/LA single-select), rows with
 * class dot/name, source tag, confidence, shape tag, double-click class editing,
 * delete controls and focus highlight. Saving is controlled by the single workspace
 * save-mode control; this panel only keeps the destructive clear-all action.
 */
export interface AnnotationListProps {
  collapsed: boolean;
  editable: boolean;
}

export function AnnotationList({ collapsed, editable }: AnnotationListProps) {
  const { t } = useTranslation();
  const annotations = useAnnotationStore((s) => s.annotations);
  const sourceFilter = useAnnotationStore((s) => s.sourceFilter);
  const focusedAnnotationId = useViewerStore((s) => s.focusedAnnotationId);
  const imageId = useAnnotationStore((s) => s.imageId);
  const [editTarget, setEditTarget] = useState<Annotation | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const visible = useMemo(
    () => filterAnnotationsBySource(annotations, sourceFilter),
    [annotations, sourceFilter],
  );

  useEffect(() => {
    if (collapsed || !focusedAnnotationId) return;
    const row = rowRefs.current.get(String(focusedAnnotationId));
    row?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [collapsed, focusedAnnotationId, visible]);

  if (collapsed) return null;

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
      {/* Source filter chips */}
      <Box sx={{ px: 2.5, py: 0.75, display: 'flex', gap: 0.75, borderBottom: '1px solid', borderColor: 'divider' }}>
        {SOURCE_OPTIONS.map((value) => {
          const active = sourceFilter === value;
          return (
            <Chip
              key={value}
              size="small"
              label={sourceFilterLabel(value)}
              onClick={() => useAnnotationStore.getState().setSourceFilter(value)}
              color={active ? 'primary' : 'default'}
              variant={active ? 'filled' : 'outlined'}
              sx={{ height: 22, fontSize: 10 }}
            />
          );
        })}
      </Box>

      <Box sx={{ flex: 1, overflowY: 'auto', p: 1.5, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
        {visible.length === 0 ? (
          <Typography sx={{ textAlign: 'center', py: 5, color: 'text.secondary', fontSize: 12 }}>
            {annotations.length > 0 ? t('no_annotations_visible') : t('no_annotations_empty')}
          </Typography>
        ) : (
          visible.map((ann) => {
            const focused = String(ann?.id || '') === String(focusedAnnotationId || '');
            const className = String(ann?.class_name || '');
            const tag = sourceTag(ann);
            const score = ann?.score;
            const shapeText = hasSegmentationGeometry(ann) ? 'Polygon' : 'BBox';
            return (
              <Box
                key={String(ann.id)}
                ref={(node: HTMLDivElement | null) => {
                  const annotationId = String(ann.id);
                  if (node) rowRefs.current.set(annotationId, node);
                  else rowRefs.current.delete(annotationId);
                }}
                data-annotation-id={String(ann.id)}
                onClick={() => useViewerStore.getState().setFocusedAnnotation(String(ann.id))}
                onDoubleClick={() => {
                  useViewerStore.getState().setFocusedAnnotation(String(ann.id));
                  if (editable) setEditTarget(ann);
                }}
                title={editable ? t('double_click_edit_ann') : undefined}
                sx={{
                  p: 1.25,
                  borderRadius: 2,
                  cursor: 'pointer',
                  border: '1px solid',
                  borderColor: focused ? 'primary.main' : 'divider',
                  bgcolor: focused ? 'action.selected' : 'background.paper',
                  boxShadow: focused ? '0 0 0 1px rgba(25,118,210,0.35)' : 'none',
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Box component="span" sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: getClassColor(className), flexShrink: 0 }} />
                  <Typography sx={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700 }} noWrap>
                    {className || '--'}
                  </Typography>
                  {tag ? (
                    <Typography component="span" sx={{ fontSize: 9, fontWeight: 800, px: 0.75, borderRadius: 1, bgcolor: 'action.hover', color: 'text.secondary' }}>
                      {tag}
                    </Typography>
                  ) : null}
                  {editable ? (
                    <IconButton
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation();
                        useAnnotationStore.getState().deleteAnnotation(String(ann.id));
                      }}
                      onDoubleClick={(e) => e.stopPropagation()}
                      sx={{ width: 22, height: 22, color: '#ef4444', fontSize: 14, fontWeight: 800 }}
                      aria-label={t('tool_delete_ann_title')}
                    >
                      ×
                    </IconButton>
                  ) : null}
                </Box>
                <Box sx={{ display: 'flex', gap: 1, mt: 0.5, fontSize: 10, color: 'text.secondary' }}>
                  <span>Conf: {Number(score ?? 0).toFixed(3)}</span>
                  <span>{shapeText}</span>
                </Box>
              </Box>
            );
          })
        )}
      </Box>

      {editable ? (
        <Box sx={{ p: 2, borderTop: '1px solid', borderColor: 'divider', display: 'flex', flexDirection: 'column', gap: 1.25 }}>
          <Button
            variant="outlined"
            color="error"
            fullWidth
            disabled={!imageId || annotations.length === 0}
            sx={{ height: 44, fontWeight: 600 }}
            onClick={() => useAnnotationStore.getState().clearAnnotations()}
          >
            {t('clear_anns')}
          </Button>
        </Box>
      ) : null}

      {editable ? (
        <AnnotationClassModal
          open={editTarget !== null}
          annotation={editTarget}
          onClose={() => setEditTarget(null)}
        />
      ) : null}
    </Box>
  );
}
