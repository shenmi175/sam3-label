import { useState } from 'react';
import { Box, Button } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLayoutStore, type WorkspaceMode } from '../../stores/workspace/layoutStore';
import { useViewerStore } from '../../stores/workspace/viewerStore';
import { useAnnotationStore } from '../../stores/workspace/annotationStore';
import { toast } from '../../utils/notify';
import { ReviewToolbar } from './ReviewToolbar';
import { ExportPanel } from './ExportPanel';
import { DataDashboardPanel } from './DataDashboardPanel';

interface WorkspaceToolbarProps {
  projectId: string;
}

/**
 * Workspace toolbar core row — 1:1 port of the legacy workspace-toolbar.js:
 *   - auto/review mode switch (guarded route navigation, legacy
 *     navigateWorkspaceRoute: commit pending polygon → flush dirty → hash nav)
 *   - review mode: ReviewToolbar (accept/reject/recategorize/save-next flow)
 *   - right side: data dashboard / smart filter / export entry points
 *     (dashboard + export open dialogs, smart filter toggles the right-column
 *     panel).
 *
 * The legacy AutoAnnotatePanel is NOT rendered here: it lives on its own
 * wrapping row below this toolbar (see ImageWorkspacePage) so its ~1500px of
 * controls can wrap on narrow windows instead of being clipped by a fixed
 * 64px row.
 */
export function WorkspaceToolbar({ projectId }: WorkspaceToolbarProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const workspaceMode = useLayoutStore((s) => s.workspaceMode);
  const routeWorkspaceMode = useLayoutStore((s) => s.routeWorkspaceMode);
  const smartFilterOpen = useLayoutStore((s) => s.smartFilterOpen);
  const [exportOpen, setExportOpen] = useState(false);
  const [dashboardOpen, setDashboardOpen] = useState(false);

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
          border: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.default',
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

      {/* Review-mode flow controls (auto-mode inference panel is a separate row) */}
      {workspaceMode === 'review' && <ReviewToolbar />}

      <Box sx={{ flex: 1 }} />

      {/* Data dashboard / smart filter / export entry points */}
      <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
        <Button size="small" variant="outlined" sx={{ height: 32, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }} onClick={() => setDashboardOpen(true)}>
          {t('data_dashboard')}
        </Button>
        <Button size="small" variant={smartFilterOpen ? 'contained' : 'outlined'} sx={{ height: 32, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }} onClick={() => useLayoutStore.getState().toggleSmartFilter()}>
          {t('smart_filter')}
        </Button>
        <Button size="small" variant="outlined" sx={{ height: 32, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }} onClick={() => setExportOpen(true)}>
          {t('export')}
        </Button>
      </Box>

      {/* Phase-9 dialogs */}
      <ExportPanel projectId={projectId} open={exportOpen} onClose={() => setExportOpen(false)} />
      <DataDashboardPanel projectId={projectId} open={dashboardOpen} onClose={() => setDashboardOpen(false)} />
    </Box>
  );
}
