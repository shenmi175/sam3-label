import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/settingsStore';
import { useProjectStore } from '../../stores/workspace/projectStore';
import { useInferenceStore, type BatchConfigResult } from '../../stores/workspace/inferenceStore';
import { toast } from '../../utils/notify';

type ScopeMode = BatchConfigResult['scope_mode'];

const SCOPE_OPTIONS: ScopeMode[] = ['all', 'unlabeled', 'class_related', 'class_related_unlabeled'];

function scopeLabel(mode: ScopeMode, t: (key: string) => string): string {
  switch (mode) {
    case 'all':
      return t('batch_scope_all');
    case 'unlabeled':
      return t('batch_scope_unlabeled');
    case 'class_related':
      return t('batch_scope_class_related');
    default:
      return t('batch_scope_class_related_unlabeled');
  }
}

/**
 * Batch task config modal — 1:1 port of the legacy
 * InferenceController.openBatchConfigModal: shows the classes that will be
 * inferred, a scope-mode select, a related-classes checklist (only for the
 * class_related scopes), and threshold/batch hints. Confirm resolves the
 * store's batchConfigRequest promise; cancel resolves null.
 */
export function BatchConfigModal() {
  const { t } = useTranslation();
  const request = useInferenceStore((s) => s.batchConfigRequest);
  const projectClasses = useProjectStore((s) => s.classes);
  const threshold = useSettingsStore((s) => s.threshold);
  const batchSize = useSettingsStore((s) => s.batchSize);

  const [scopeMode, setScopeMode] = useState<ScopeMode>('all');
  const [related, setRelated] = useState<Set<string>>(new Set());

  // Reset local state whenever a new request opens (legacy re-rendered the
  // modal content on every open with the default classes checked).
  useEffect(() => {
    if (request) {
      setScopeMode('all');
      setRelated(new Set(request.classes));
    }
  }, [request]);

  const needRelated = scopeMode === 'class_related' || scopeMode === 'class_related_unlabeled';

  const classesToShow = useMemo(() => request?.classes || [], [request]);

  const confirm = () => {
    if (!request) return;
    if (needRelated && related.size === 0) {
      toast(t('batch_related_required'), 'error');
      return;
    }
    useInferenceStore.getState().resolveBatchConfig({
      scope_mode: scopeMode,
      related_classes: Array.from(related),
      image_ids: [],
      retry_image_ids: [],
    });
  };

  const cancel = () => {
    useInferenceStore.getState().resolveBatchConfig(null);
  };

  return (
    <Dialog open={request !== null} onClose={cancel} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontSize: 18, fontWeight: 700, pr: 6 }}>
        {request?.title || t('batch_title')}
        <IconButton onClick={cancel} size="small" sx={{ position: 'absolute', right: 10, top: 10, color: '#ef4444' }} aria-label="close">
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
        {/* Classes that will be inferred */}
        <Box sx={{ p: 1.75, borderRadius: 3, bgcolor: 'action.hover' }}>
          <Typography sx={{ fontSize: 12, fontWeight: 700, mb: 1.25 }}>{t('batch_classes_to_infer')}</Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {classesToShow.length ? (
              classesToShow.map((cls) => <Chip key={cls} label={cls} size="small" sx={{ fontSize: 12 }} />)
            ) : (
              <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{t('batch_no_classes')}</Typography>
            )}
          </Box>
        </Box>

        {/* Scope mode */}
        <TextField
          select
          label={t('batch_scope_title')}
          size="small"
          value={scopeMode}
          onChange={(e) => setScopeMode(e.target.value as ScopeMode)}
          fullWidth
        >
          {SCOPE_OPTIONS.map((mode) => (
            <MenuItem key={mode} value={mode} sx={{ fontSize: 13 }}>
              {scopeLabel(mode, t)}
            </MenuItem>
          ))}
        </TextField>

        {/* Related classes (only for class_related scopes) */}
        {needRelated ? (
          <Box>
            <Typography sx={{ fontSize: 12, fontWeight: 700, mb: 1 }}>{t('batch_related_classes')}</Typography>
            <Box
              sx={{
                p: 1.5,
                borderRadius: 3,
                border: '1px solid',
                borderColor: 'divider',
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                gap: 1,
                maxHeight: 180,
                overflowY: 'auto',
              }}
            >
              {projectClasses.map((cls) => (
                <FormControlLabel
                  key={cls}
                  sx={{ m: 0 }}
                  control={
                    <Checkbox
                      size="small"
                      checked={related.has(cls)}
                      onChange={(e) => {
                        setRelated((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(cls);
                          else next.delete(cls);
                          return next;
                        });
                      }}
                    />
                  }
                  label={<Typography sx={{ fontSize: 12 }}>{cls}</Typography>}
                />
              ))}
            </Box>
            <Typography sx={{ mt: 1, fontSize: 11, color: 'text.secondary' }}>{t('batch_related_hint')}</Typography>
          </Box>
        ) : null}

        {/* Params + result hint */}
        <Box sx={{ p: 1.75, borderRadius: 3, bgcolor: 'action.hover' }}>
          <Typography sx={{ fontSize: 12, color: 'text.secondary', lineHeight: 1.6 }}>
            {t('batch_params_hint', { threshold, batchSize })}
            <br />
            {t('batch_result_hint')}
          </Typography>
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={cancel}>{t('cancel')}</Button>
        <Button variant="contained" onClick={confirm} sx={{ fontWeight: 700 }}>
          {t('batch_start')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
