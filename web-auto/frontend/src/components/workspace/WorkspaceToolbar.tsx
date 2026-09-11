import { useState, type ReactNode } from 'react';
import { Box, Button, IconButton, Menu, MenuItem, Tooltip } from '@mui/material';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLayoutStore, type WorkspaceMode } from '../../stores/workspace/layoutStore';
import { useViewerStore } from '../../stores/workspace/viewerStore';
import { useAnnotationStore } from '../../stores/workspace/annotationStore';
import { toast } from '../../utils/notify';
import { ExportPanel } from './ExportPanel';

interface WorkspaceToolbarProps {
  projectId: string;
  mode: WorkspaceMode;
  modePanel: ReactNode;
}

/**
 * Shared workspace toolbar row, with its mode-specific panel supplied by the
 * automatic or manual route component:
 *   - auto/review mode switch (guarded route navigation, legacy
 *     navigateWorkspaceRoute: commit pending polygon → flush dirty → hash nav)
 *   - review mode: ReviewToolbar (accept/reject/recategorize/save-next flow)
 *   - right side: data dashboard / data cleaning / export entry points.
 *
 * Auto and review controls share this row so switching modes never changes the
 * vertical workspace layout.
 */
export function WorkspaceToolbar({ projectId, mode, modePanel }: WorkspaceToolbarProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const routeWorkspaceMode = useLayoutStore((s) => s.routeWorkspaceMode);
  const [exportOpen, setExportOpen] = useState(false);
  const [toolsAnchor, setToolsAnchor] = useState<HTMLElement | null>(null);

  const switchMode = async (mode: WorkspaceMode) => {
    if (mode === routeWorkspaceMode) return;
    if (projectId && routeWorkspaceMode !== mode) {
      // Guarded route switch (legacy navigateWorkspaceRoute).
      if (!useViewerStore.getState().commitPendingManualPolygon()) return;
      const annotation = useAnnotationStore.getState();
      if (!(await annotation.prepareForNavigation())) {
        toast(t('anns_not_saved_mode'), 'error');
        return;
      }
      navigate(`/project/image/${encodeURIComponent(projectId)}/${mode}`);
      return;
    }
    useLayoutStore.getState().setWorkspaceMode(mode);
  };

  const openAnalytics = async () => {
    if (!projectId || !useViewerStore.getState().commitPendingManualPolygon()) return;
    const annotation = useAnnotationStore.getState();
    if (!(await annotation.prepareForNavigation())) {
      toast(t('anns_not_saved_mode'), 'error');
      return;
    }
    navigate(`/project/image/${encodeURIComponent(projectId)}/analytics`, {
      state: { from: location.pathname },
    });
  };

  const openDataCleaning = async () => {
    if (!projectId || !useViewerStore.getState().commitPendingManualPolygon()) return;
    const annotation = useAnnotationStore.getState();
    if (!(await annotation.prepareForNavigation())) {
      toast(t('anns_not_saved_mode'), 'error');
      return;
    }
    navigate(`/project/image/${encodeURIComponent(projectId)}/cleaning`, {
      state: { from: location.pathname },
    });
  };

  const openManagement = async () => {
    setToolsAnchor(null);
    if (!projectId || !useViewerStore.getState().commitPendingManualPolygon()) return;
    if (!(await useAnnotationStore.getState().prepareForNavigation())) return;
    navigate(`/project/${encodeURIComponent(projectId)}/manage`);
  };

  return (
    <Box
      sx={{
        height: 48,
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
          variant={mode === 'auto' ? 'contained' : 'text'}
          onClick={() => void switchMode('auto')}
          sx={{ height: 28, px: 1.5, fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap' }}
        >
          {t('workspace_mode_auto')}
        </Button>
        <Button
          size="small"
          variant={mode === 'review' ? 'contained' : 'text'}
          onClick={() => void switchMode('review')}
          sx={{ height: 28, px: 1.5, fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap' }}
        >
          {t('workspace_mode_review')}
        </Button>
      </Box>

      {modePanel}

      <Box sx={{ flex: 1 }} />

      <Tooltip title={t('project_tools')}>
        <IconButton size="small" onClick={(event) => setToolsAnchor(event.currentTarget)} aria-label={t('project_tools')}>
          <MoreHorizIcon />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={toolsAnchor} open={Boolean(toolsAnchor)} onClose={() => setToolsAnchor(null)}>
        <MenuItem onClick={() => { setToolsAnchor(null); void openAnalytics(); }}>{t('data_dashboard')}</MenuItem>
        <MenuItem onClick={() => { setToolsAnchor(null); void openDataCleaning(); }}>{t('smart_filter')}</MenuItem>
        <MenuItem onClick={() => { setToolsAnchor(null); setExportOpen(true); }}>{t('export')}</MenuItem>
        <MenuItem onClick={() => void openManagement()}>{t('project_manage')}</MenuItem>
      </Menu>

      {/* Phase-9 dialogs */}
      <ExportPanel
        projectId={projectId}
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        onOpenDataCleaning={() => void openDataCleaning()}
      />
    </Box>
  );
}
