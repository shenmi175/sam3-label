import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  TextField,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../stores/workspace/projectStore';
import { useAnnotationStore } from '../../stores/workspace/annotationStore';
import { useViewerStore } from '../../stores/workspace/viewerStore';
import { getClassColor } from '../../utils/geometry';
import { toast } from '../../utils/notify';

/**
 * Class management panel — 1:1 port of the legacy class-panel.js + class
 * controller: color dot (hash → hsl), per-image annotation count, inference
 * checkbox (cls-chk-infer), delete with confirm, add-class dialog accepting
 * multiline batch input.
 */
export function ClassPanel({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const classes = useProjectStore((s) => s.classes);
  const selectedClass = useProjectStore((s) => s.selectedClass);
  const inferenceChecked = useProjectStore((s) => s.inferenceCheckedClasses);
  const annotations = useAnnotationStore((s) => s.annotations);
  const focusedAnnotationId = useViewerStore((s) => s.focusedAnnotationId);
  const highlightedAnnotationIds = useViewerStore((s) => s.highlightedAnnotationIds);
  const [addOpen, setAddOpen] = useState(false);
  const [addText, setAddText] = useState('');
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const ann of annotations) {
      const name = String(ann?.class_name || '');
      map.set(name, (map.get(name) || 0) + 1);
    }
    return map;
  }, [annotations]);

  const focusedClass = useMemo(() => {
    if (!focusedAnnotationId) return '';
    const annotation = annotations.find((ann) => String(ann?.id || '') === String(focusedAnnotationId));
    return String(annotation?.class_name || '').trim();
  }, [annotations, focusedAnnotationId]);

  useEffect(() => {
    if (!focusedClass || !classes.includes(focusedClass)) return;
    if (useProjectStore.getState().selectedClass !== focusedClass) {
      useProjectStore.getState().setSelectedClass(focusedClass);
    }
    if (collapsed) return;
    const row = rowRefs.current.get(focusedClass);
    row?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [classes, collapsed, focusedClass]);

  const handleAdd = async () => {
    const text = addText.trim();
    if (!text) {
      toast(t('class_name_required'), 'error');
      return;
    }
    const ok = await useProjectStore.getState().addClass(text);
    if (ok) {
      toast(t('class_added'), 'success');
      setAddOpen(false);
      setAddText('');
    }
  };

  const handleDelete = async (className: string) => {
    if (!window.confirm(t('confirm_delete_class', { name: className }))) return;
    const ok = await useProjectStore.getState().deleteClass(className);
    if (ok) toast(t('class_deleted', { name: className }), 'success');
  };

  if (collapsed) return null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, overflowY: 'auto', pr: 0.5, flex: 1, minHeight: 0 }}>
        {classes.map((className) => {
          const selected = className === selectedClass;
          const classAnnotationIds = annotations
            .filter((annotation) => String(annotation?.class_name || '') === className)
            .map((annotation) => String(annotation?.id || ''))
            .filter(Boolean);
          const highlighted = classAnnotationIds.length > 0
            && classAnnotationIds.every((id) => highlightedAnnotationIds.includes(id));
          return (
            <Box
              key={className}
              ref={(node: HTMLDivElement | null) => {
                if (node) rowRefs.current.set(className, node);
                else rowRefs.current.delete(className);
              }}
              data-class-name={className}
              onClick={() => {
                useProjectStore.getState().setSelectedClass(className);
                useViewerStore.getState().setHighlightedAnnotations(
                  highlighted ? [] : classAnnotationIds,
                );
              }}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                p: 1,
                borderRadius: 2,
                cursor: 'pointer',
                bgcolor: selected ? 'action.selected' : 'transparent',
                outline: highlighted ? '2px solid' : 'none',
                outlineColor: highlighted ? getClassColor(className) : 'transparent',
                '&:hover': { bgcolor: 'action.hover' },
              }}
            >
              <Box component="span" sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: getClassColor(className), flexShrink: 0 }} />
              <Typography sx={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: selected ? 700 : 500 }} noWrap>
                {className}
              </Typography>
              <Typography sx={{ fontSize: 11, color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>
                {counts.get(className) || 0}
              </Typography>
              <Checkbox
                size="small"
                checked={inferenceChecked.has(className)}
                title={t('include_in_text_infer')}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => useProjectStore.getState().toggleInferenceClass(className, e.target.checked)}
                sx={{ p: 0.25 }}
              />
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleDelete(className);
                }}
                sx={{ width: 22, height: 22, color: '#ef4444', fontSize: 14, fontWeight: 800 }}
                aria-label={`${t('close')} ${className}`}
              >
                ×
              </IconButton>
            </Box>
          );
        })}
        {classes.length === 0 ? (
          <Box sx={{ textAlign: 'center', py: 2 }}>
            <Typography sx={{ color: 'text.secondary', fontSize: 12 }}>{t('no_classes')}</Typography>
            <Button
              size="small"
              variant="text"
              onClick={() => setAddOpen(true)}
              sx={{ mt: 0.5, fontSize: 12, fontWeight: 700 }}
            >
              {t('create_class')}
            </Button>
          </Box>
        ) : null}
      </Box>
      <Button
        variant="outlined"
        size="small"
        fullWidth
        sx={{ mt: 1.5, flexShrink: 0, fontWeight: 600 }}
        onClick={() => setAddOpen(true)}
      >
        {t('create_class')}
      </Button>

      <Dialog open={addOpen} onClose={() => setAddOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontSize: 16 }}>{t('add_class_title')}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            multiline
            minRows={4}
            fullWidth
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            placeholder={t('add_class_placeholder')}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddOpen(false)}>{t('close')}</Button>
          <Button variant="contained" onClick={() => void handleAdd()}>
            {t('confirm')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
