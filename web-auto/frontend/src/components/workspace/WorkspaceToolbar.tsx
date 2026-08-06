import { Box, Button, Tooltip, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLayoutStore, type WorkspaceMode } from '../../stores/workspace/layoutStore';
import { useViewerStore } from '../../stores/workspace/viewerStore';
import { useAnnotationStore } from '../../stores/workspace/annotationStore';
import { toast } from '../../utils/notify';
import { AutoAnnotatePanel } from './AutoAnnotatePanel';

interface WorkspaceToolbarProps {
  projectId: string;
}

/**
 * Workspace toolbar — 1:1 port of the legacy workspace-toolbar.js:
 *   - auto/review mode switch (guarded route navigation, legacy
 *     navigateWorkspaceRoute: commit pending polygon → flush dirty → hash nav)
 *   - auto mode: AutoAnnotatePanel
 *   - review mode: reserved slot for the phase-9 review toolbar
 *   - right side: data dashboard / smart filter / export buttons, kept as
 *     reserved phase-9 slots (panels are wired by later phases).
 */
export function WorkspaceToolbar({ projectId }: WorkspaceToolbarProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const workspaceMode = useLayoutStore((s) => s.workspaceMode);
  const routeWorkspaceMode = useLayoutStore((s) => s.routeWorkspaceMode);

  const switchMode = async (mode: WorkspaceMode) => {
    if (mode === workspaceMode) return;
    if (projectId && routeWorkspaceMode !== mode) {
      // Guarded route switch (legacy navigateWorkspaceRoute).
      if (!useViewerStore.getState().commitPendingManualPolygon()) return;
      const annotation = useAnnotationStore.getState();
      if (annotation.dirty) {
        await annotation.flushSave('workspace-mode-route-switch');
        if (useAnnotationStore.getState().dirty) {
          toast(t('anns_not_saved_mode'), 'error');
          return;
        }
      }
      navigate(`/project/image/${encodeURIComponent(projectId)}/${mode}`);
      return;
    }
    useLayoutStore.getState().setWorkspaceMode(mode);
  };

  const reservedSlot = (label: string) => {
    toast(`${label}: ${t('phase9_slot_desc')}`, 'info');
  };

  return (
    <Box
      sx={{
        height: 64,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        px: 3,
        gap: 2,
        zIndex: 90,
        borderBottom: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
        overflowX: 'auto',
      }}
    >
      {/* Mode switch */}
      <Box
        sx={{
          height: 34,
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          p: 0.4,
          borderRadius: '12px',
          flexShrink: 0,
          boxShadow: 'inset 2px 2px 5px rgba(0,0,0,0.06), inset -2px -2px 5px rgba(255,255,255,0.6)',
        }}
      >
        <Button
          size="small"
          variant={workspaceMode === 'auto' ? 'contained' : 'text'}
          onClick={() => void switchMode('auto')}
          sx={{ height: 28, px: 1.5, fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap' }}
        >
          {t('workspace_mode_auto')}
        </Button>
        <Button
          size="small"
          variant={workspaceMode === 'review' ? 'contained' : 'text'}
          onClick={() => void switchMode('review')}
          sx={{ height: 28, px: 1.5, fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap' }}
        >
          {t('workspace_mode_review')}
        </Button>
      </Box>

      {/* Mode-specific panels */}
      {workspaceMode === 'auto' ? (
        <AutoAnnotatePanel />
      ) : (
        <Tooltip title={t('phase9_slot_desc')}>
          <Box
            sx={{
              height: 32,
              px: 1.5,
              display: 'flex',
              alignItems: 'center',
              borderRadius: '10px',
              border: '1px dashed',
              borderColor: 'divider',
            }}
          >
            <Typography sx={{ fontSize: 11, fontWeight: 700, color: 'text.secondary', whiteSpace: 'nowrap' }}>
              {t('review_toolbar_slot')}
            </Typography>
          </Box>
        </Tooltip>
      )}

      <Box sx={{ flex: 1 }} />

      {/* Phase-9 reserved slots: data dashboard / smart filter / export */}
      <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
        <Button size="small" variant="outlined" sx={{ height: 32, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }} onClick={() => reservedSlot(t('data_dashboard'))}>
          {t('data_dashboard')}
        </Button>
        <Button size="small" variant="outlined" sx={{ height: 32, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }} onClick={() => reservedSlot(t('smart_filter'))}>
          {t('smart_filter')}
        </Button>
        <Button size="small" variant="outlined" sx={{ height: 32, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }} onClick={() => reservedSlot(t('export'))}>
          {t('export')}
        </Button>
      </Box>
    </Box>
  );
}
