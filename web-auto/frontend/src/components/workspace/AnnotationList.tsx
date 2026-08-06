import { useMemo, useState } from 'react';
import { Box, Button, Chip, IconButton, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import type { Annotation } from '../../api/types';
import { useAnnotationStore } from '../../stores/workspace/annotationStore';
import { useViewerStore, filterAnnotationsBySource, type SourceFilter } from '../../stores/workspace/viewerStore';
import { getClassColor } from '../../utils/geometry';
import { AnnotationClassModal } from './AnnotationClassModal';

const SOURCE_OPTIONS: SourceFilter[] = ['sam3', 'locate-anything', 'manual'];

function sourceFilterLabel(source: SourceFilter, t: (key: string) => string): string {
  if (source === 'locate-anything') return 'LA';
  if (source === 'manual') return t('source_manual');
  return 'sam3';
}

function sourceTag(ann: Annotation): string {
  const source = String(ann.source_model || '');
  if (source === 'locate-anything') return 'LA';
  if (source === 'manual') return 'Manual';
  return '';
}

/**
 * Annotation list panel — 1:1 port of the legacy annotation-list.js +
 * source-filter-bar: source chips (sam3/LA/manual single-select), rows with
 * class dot/name, source tag, confidence, shape tag, edit-class and delete
 * buttons, focus highlight; plus save / clear buttons at the bottom.
 */
export function AnnotationList({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const annotations = useAnnotationStore((s) => s.annotations);
  const sourceFilter = useAnnotationStore((s) => s.sourceFilter);
  const focusedAnnotationId = useViewerStore((s) => s.focusedAnnotationId);
  const imageId = useAnnotationStore((s) => s.imageId);
  const [editTarget, setEditTarget] = useState<Annotation | null>(null);

  const visible = useMemo(
    () => filterAnnotationsBySource(annotations, sourceFilter),
    [annotations, sourceFilter],
  );

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
              label={sourceFilterLabel(value, t)}
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
            const shapeText = ann?.polygon || ann?.polygons ? 'Polygon' : 'BBox';
            return (
              <Box
                key={String(ann.id)}
                onClick={() => useViewerStore.getState().setFocusedAnnotation(String(ann.id))}
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
                  <IconButton
                    size="small"
                    title={t('edit_ann_class_title')}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditTarget(ann);
                    }}
                    sx={{ width: 22, height: 22, fontSize: 11, fontWeight: 700 }}
                  >
                    {t('tool_edit')}
                  </IconButton>
                  <IconButton
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      useAnnotationStore.getState().deleteAnnotation(String(ann.id));
                    }}
                    sx={{ width: 22, height: 22, color: '#ef4444', fontSize: 14, fontWeight: 800 }}
                    aria-label={t('tool_delete_ann_title')}
                  >
                    ×
                  </IconButton>
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

      <Box sx={{ p: 2, borderTop: '1px solid', borderColor: 'divider', display: 'flex', flexDirection: 'column', gap: 1.25 }}>
        <Button
          variant="contained"
          fullWidth
          disabled={!imageId}
          sx={{ height: 44, fontWeight: 700 }}
          onClick={() => void useAnnotationStore.getState().saveCurrent()}
        >
          {t('save_anns')}
        </Button>
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

      <AnnotationClassModal
        open={editTarget !== null}
        annotation={editTarget}
        onClose={() => setEditTarget(null)}
      />
    </Box>
  );
}
