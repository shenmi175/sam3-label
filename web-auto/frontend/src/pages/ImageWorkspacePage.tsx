import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  FormControlLabel,
  IconButton,
  LinearProgress,
  Paper,
  Tooltip,
  Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';
import NearMeIcon from '@mui/icons-material/NearMe';
import CropSquareIcon from '@mui/icons-material/CropSquare';
import PolylineIcon from '@mui/icons-material/Polyline';
import UndoIcon from '@mui/icons-material/Undo';
import RedoIcon from '@mui/icons-material/Redo';
import DeleteIcon from '@mui/icons-material/Delete';
import AddBoxIcon from '@mui/icons-material/AddBox';
import IndeterminateCheckBoxIcon from '@mui/icons-material/IndeterminateCheckBox';
import ClearIcon from '@mui/icons-material/Clear';
import ZoomOutMapIcon from '@mui/icons-material/ZoomOutMap';
import ImageIcon from '@mui/icons-material/Image';
import { useTranslation } from 'react-i18next';
import { ImageViewer, type ImageViewerHandle } from '../components/viewer/ImageViewer';
import type { ManualAnnotationDraft } from '../components/viewer/viewer-core';
import type { Annotation } from '../api/types';
import { migrateSources as migrateSourcesApi } from '../api/classes';
import { clearBundleCache } from '../api/bundleCache';
import { toast } from '../utils/notify';
import { useSettingsStore } from '../stores/settingsStore';
import { useProjectStore } from '../stores/workspace/projectStore';
import { useImageStore } from '../stores/workspace/imageStore';
import { useAnnotationStore, selectCanUndo, selectCanRedo } from '../stores/workspace/annotationStore';
import { useViewerStore, filterAnnotationsBySource } from '../stores/workspace/viewerStore';
import { useInferenceStore } from '../stores/workspace/inferenceStore';
import { useLayoutStore } from '../stores/workspace/layoutStore';
import { useTasksStore } from '../stores/workspace/tasksStore';
import { useSmartFilterStore } from '../stores/workspace/smartFilterStore';
import { useImageNavigation } from '../hooks/useImageNavigation';
import { useKeyboardCommands } from '../hooks/useKeyboardCommands';
import { useUiStateSync, restoreUiState } from '../hooks/useUiStateSync';
import { useJobPolling, stopJobPolling } from '../hooks/useJobPolling';
import { usePreviewInference } from '../hooks/usePreviewInference';
import { useBackendHealth } from '../hooks/useBackendHealth';
import { ImageList } from '../components/workspace/ImageList';
import { FilterBar } from '../components/workspace/FilterBar';
import { ClassPanel } from '../components/workspace/ClassPanel';
import { AnnotationList } from '../components/workspace/AnnotationList';
import { WorkspaceToolbar } from '../components/workspace/WorkspaceToolbar';
import { AutoAnnotatePanel } from '../components/workspace/AutoAnnotatePanel';
import { TaskProgressBar } from '../components/workspace/TaskProgressBar';
import { GpuStatusWidget } from '../components/workspace/GpuStatusWidget';
import { PreviewResultsPanel } from '../components/workspace/PreviewResultsPanel';
import { SmartFilterPanel } from '../components/workspace/SmartFilterPanel';
import { BatchConfigModal } from '../components/workspace/BatchConfigModal';
import { BatchResultModal } from '../components/workspace/BatchResultModal';
import { BackendErrorModal } from '../components/workspace/BackendErrorModal';

/**
 * Image workspace page — React assembly of the legacy
 * `js/pages/image-workspace.js` God Object page.
 *
 * Initialization order mirrors the legacy render():
 *   loadProjectInfo → restoreUiState → (route mode wins) → loadImages →
 *   restore the selected image. Unmount mirrors legacy unmount(): abort /
 *   clear bundle cache / flush ui_state (useUiStateSync) / reset all stores.
 *
 * Viewer callbacks dispatch to the stores exactly like the legacy wiring:
 *   onPromptAdded         → viewerStore.addPrompt
 *   onAnnotationSelected  → viewerStore.setFocusedAnnotation
 *   onAnnotationEditStart → annotationStore.pushHistory
 *   onAnnotationUpdated   → annotationStore.handleGeometryUpdated (markDirty)
 *   onAnnotationCreated   → annotationStore.createAnnotation (+review continuous)
 */
export function ImageWorkspacePage() {
  const { id = '' } = useParams();
  const projectId = id;
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const theme = useTheme();
  const themeMode = useSettingsStore((s) => s.themeMode);
  const setSetting = useSettingsStore((s) => s.set);

  /** Canvas / center-column background, aligned with the viewer core. */
  const canvasBg = theme.palette.mode === 'dark' ? '#1b1e26' : '#eaeff2';

  // Route-derived workspace mode (legacy routeWorkspaceMode).
  const routeMode = location.pathname.endsWith('/review') ? 'review' : 'auto';

  const viewerRef = useRef<ImageViewerHandle | null>(null);
  /** Manual-polygon point counter (the viewer exposes no point callbacks). */
  const polygonPointsRef = useRef(0);
  /** Synchronous probe detecting a polygon commit inside finishManualPolygon. */
  const commitProbeRef = useRef<'idle' | 'pending' | 'created'>('idle');
  const commitPolygonGuardRef = useRef<() => boolean>(() => true);

  // ─── Store subscriptions ────────────────────────────────────────────────────
  const projectMeta = useProjectStore((s) => s.projectMeta);
  const totalImages = useProjectStore((s) => s.totalImages);

  const selectedImageId = useImageStore((s) => s.selectedImageId);
  const selectedImagePath = useImageStore((s) => s.selectedImagePath);
  const isImageLoading = useImageStore((s) => s.isLoading);
  const previewInfo = useImageStore((s) => s.previewInfo);
  const tileInfo = useImageStore((s) => s.tileInfo);

  const annotations = useAnnotationStore((s) => s.annotations);
  const sourceFilter = useAnnotationStore((s) => s.sourceFilter);
  const autosaveEnabled = useAnnotationStore((s) => s.autosaveEnabled);
  const saveStatus = useAnnotationStore((s) => s.saveStatus);
  const canUndo = useAnnotationStore(selectCanUndo);
  const canRedo = useAnnotationStore(selectCanRedo);

  const promptMode = useViewerStore((s) => s.promptMode);
  const boxPromptLabel = useViewerStore((s) => s.boxPromptLabel);
  const currentPrompts = useViewerStore((s) => s.currentPrompts);
  const previews = useViewerStore((s) => s.previews);
  const focusedAnnotationId = useViewerStore((s) => s.focusedAnnotationId);
  const showMasks = useViewerStore((s) => s.showMasks);
  const previewSectionCollapsed = useViewerStore((s) => s.previewSectionCollapsed);

  const workspaceMode = useLayoutStore((s) => s.workspaceMode);
  const leftPanelHidden = useLayoutStore((s) => s.leftPanelHidden);
  const rightPanelHidden = useLayoutStore((s) => s.rightPanelHidden);
  const classesSectionCollapsed = useLayoutStore((s) => s.classesSectionCollapsed);
  const annotationsSectionCollapsed = useLayoutStore((s) => s.annotationsSectionCollapsed);
  const unlabeledNavigationEnabled = useLayoutStore((s) => s.unlabeledNavigationEnabled);
  const smartFilterOpen = useLayoutStore((s) => s.smartFilterOpen);

  // Backend health indicator — legacy startHealthCheck (10 s /api/health).
  const backendHealth = useBackendHealth();

  // Effective mode: review-only UI is a phase-9 slot; auto-only UI is
  // conditionally rendered through this flag (legacy .ws-auto-only elements).
  const isReviewMode = workspaceMode === 'review';

  // Legacy single-select source filter applied to the viewer + list.
  const visibleAnnotations = useMemo(
    () => filterAnnotationsBySource(annotations, sourceFilter),
    [annotations, sourceFilter],
  );

  const viewerOptions = useMemo(() => ({ showMasks }), [showMasks]);

  const { loadImages, goToPage, toggleUnlabeledNavigation, deleteProjectImage } =
    useImageNavigation();
  const { keepAll } = usePreviewInference();

  // Debounced ui_state sync + unmount flush (legacy scheduleProjectUIStateSave).
  useUiStateSync(projectId);
  // Restore the project's active infer job on mount, stop polling on unmount.
  useJobPolling(projectId);

  // ─── Viewer callback dispatch ───────────────────────────────────────────────

  const handlePromptAdded = useCallback((type: 'point' | 'box', data: number[]) => {
    useViewerStore.getState().addPrompt(type, data);
  }, []);

  const handleAnnotationSelected = useCallback((annotationId: string | null) => {
    useViewerStore.getState().setFocusedAnnotation(annotationId);
  }, []);

  const handleAnnotationEditStart = useCallback(() => {
    useAnnotationStore.getState().pushHistory();
  }, []);

  const handleAnnotationUpdated = useCallback((annotation: Annotation) => {
    const annotationId = String(annotation?.id || '');
    if (!annotationId) return;
    useAnnotationStore.getState().handleGeometryUpdated(annotationId, annotation);
  }, []);

  const handleAnnotationCreated = useCallback((draft: ManualAnnotationDraft) => {
    commitProbeRef.current = 'created';
    polygonPointsRef.current = 0;
    const project = useProjectStore.getState();
    const layout = useLayoutStore.getState();
    const previousMode = useViewerStore.getState().promptMode;
    // Legacy selectedOrDefaultClass.
    const className =
      String(project.selectedClass || project.classes[0] || 'object').trim() || 'object';
    useAnnotationStore
      .getState()
      .createAnnotation({ bbox: draft.bbox, polygon: draft.polygon }, className);
    // Legacy review continuous mode: keep drawing manual shapes after commit.
    if (
      layout.workspaceMode === 'review' &&
      layout.reviewContinuousMode &&
      (previousMode === 'manual-box' || previousMode === 'manual-polygon')
    ) {
      setTimeout(() => {
        useViewerStore.getState().setPromptMode(previousMode, layout.workspaceMode);
      }, 0);
    }
  }, []);

  // ─── Manual polygon commit guard (legacy commitPendingManualPolygon) ───────
  // The viewer handle exposes no hasActiveManualPolygon/point-count API, so the
  // page tracks points itself: mousedown capture increments the counter while
  // in manual-polygon mode; the counter resets on mode change, Escape and any
  // created annotation (Enter / double-click / closing near the first point).
  commitPolygonGuardRef.current = () => {
    if (useViewerStore.getState().promptMode !== 'manual-polygon') return true;
    const points = polygonPointsRef.current;
    if (points === 0) return true; // no draft started yet
    if (points < 3) {
      toast(t('polygon_need_3_points'), 'error');
      return false;
    }
    commitProbeRef.current = 'pending';
    viewerRef.current?.finishManualPolygon();
    // finishManualPolygon synchronously fires onAnnotationCreated, which flips
    // the probe to 'created'; TS cannot see that mutation, so widen the type.
    const committed = (commitProbeRef.current as string) === 'created';
    commitProbeRef.current = 'idle';
    if (!committed) {
      toast(t('polygon_commit_failed'), 'error');
      return false;
    }
    return true;
  };

  const onViewerMouseDownCapture = useCallback((event: React.MouseEvent) => {
    if (event.button !== 0 || event.altKey) return;
    if (useViewerStore.getState().promptMode === 'manual-polygon') {
      polygonPointsRef.current += 1;
    }
  }, []);

  useEffect(() => {
    polygonPointsRef.current = 0;
  }, [promptMode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') polygonPointsRef.current = 0;
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // ─── Initialization / teardown (legacy render + unmount) ───────────────────

  useEffect(() => {
    if (!projectId) return undefined;
    let cancelled = false;

    // Aggregate reset for a clean mount (also covers StrictMode remounts).
    useProjectStore.getState().reset();
    useImageStore.getState().reset();
    useAnnotationStore.getState().reset();
    useViewerStore.getState().reset();
    useInferenceStore.getState().reset();
    useLayoutStore.getState().reset();
    useSmartFilterStore.getState().reset();

    useViewerStore
      .getState()
      .registerCommitPolygonGuard(() => commitPolygonGuardRef.current());
    useLayoutStore.getState().setRouteWorkspaceMode(routeMode);
    useProjectStore.getState().setProjectId(projectId);
    useTasksStore.getState().setProjectContext(projectId);
    useTasksStore.getState().startPolling();

    void (async () => {
      // Legacy order: loadProjectInfo → restoreProjectUIState → mode →
      // loadImages → restoreSelectedImage.
      await useProjectStore.getState().loadProjectInfo();
      if (cancelled) return;
      useTasksStore.getState().setProjectContext(
        projectId,
        useProjectStore.getState().projectMeta?.name ?? null,
      );
      const restored = await restoreUiState(projectId);
      if (cancelled) return;
      // Legacy: after restoring persisted state the route mode wins.
      useLayoutStore.getState().setWorkspaceMode(routeMode);
      await loadImages();
      if (cancelled) return;

      const project = useProjectStore.getState();
      const list = project.images;
      let targetId = String(restored.selectedImageId || '');
      const hasFilter =
        Boolean(project.imageFilterClass) || project.imageFilterStatus !== 'all';
      if (hasFilter && list.length > 0 && !list.some((img) => String(img.id) === targetId)) {
        targetId = String(list[0].id);
      }
      if (!targetId && list.length > 0) targetId = String(list[0].id);
      if (targetId) void useImageStore.getState().selectImage(targetId);
    })();

    return () => {
      cancelled = true;
      useViewerStore.getState().registerCommitPolygonGuard(null);
      // Aggregate cleanup (legacy unmount): stop task polling/job polling,
      // clear the bundle cache, abort + reset every workspace store.
      useTasksStore.getState().reset();
      stopJobPolling();
      useSmartFilterStore.getState().reset();
      clearBundleCache();
      useImageStore.getState().reset();
      useInferenceStore.getState().reset();
      useAnnotationStore.getState().reset();
      useViewerStore.getState().reset();
      useLayoutStore.getState().reset();
      useProjectStore.getState().reset();
      useAnnotationStore.getState().setUnmounted(true);
    };
  }, [projectId, routeMode, loadImages]);

  // ─── Keyboard shortcuts (legacy KeyboardCommandManager) ─────────────────────

  const handleFitToScreen = useCallback(() => {
    viewerRef.current?.fitToScreen();
  }, []);

  const handleDeleteImage = useCallback(
    (imageId: string) => {
      void deleteProjectImage(imageId);
    },
    [deleteProjectImage],
  );

  useKeyboardCommands({ onFitToScreen: handleFitToScreen, onDeleteImage: handleDeleteImage });

  // ─── Toolbar / status-bar helpers ───────────────────────────────────────────

  const setToolMode = useCallback(
    (mode: 'none' | 'manual-box' | 'manual-polygon') => {
      useViewerStore.getState().setPromptMode(mode, workspaceMode);
    },
    [workspaceMode],
  );

  const handleDeleteFocusedAnnotation = useCallback(() => {
    const focused = useViewerStore.getState().focusedAnnotationId;
    if (!focused) {
      toast(t('select_annotation_first'), 'info');
      return;
    }
    useAnnotationStore.getState().deleteAnnotation(focused);
  }, [t]);

  const handleClearPrompts = useCallback(() => {
    useViewerStore.getState().clearPromptsAndPreviews();
    toast(t('prompts_cleared'));
  }, [t]);

  const handleAutosaveToggle = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const store = useAnnotationStore.getState();
      store.setAutosaveEnabled(event.target.checked);
      if (event.target.checked) store.triggerAutosave();
    },
    [],
  );

  const handleMigrateSources = useCallback(async () => {
    if (!projectId) return;
    if (!window.confirm(t('migrate_sources_confirm'))) return;
    try {
      const res = await migrateSourcesApi(projectId);
      toast(t('migrate_done', { total: Number(res?.migrated || 0) }), 'success');
      await useProjectStore.getState().loadProjectInfo();
      if (useImageStore.getState().selectedImageId) {
        void useImageStore.getState().reloadSelectedImage();
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, [projectId, t]);

  // ─── Derived display strings ────────────────────────────────────────────────

  const projectName = projectMeta?.name || projectId;
  const total = Number(projectMeta?.num_images || totalImages || 0);
  const labeled = Number(projectMeta?.labeled_images || 0);
  const progressPct = total > 0 ? Math.min(100, (labeled / total) * 100) : 0;

  const promptModeText =
    promptMode === 'manual-box'
      ? t('mode_manual_box')
      : promptMode === 'manual-polygon'
        ? t('mode_manual_polygon')
        : promptMode === 'box'
          ? boxPromptLabel === 0
            ? t('negative_box_tool')
            : t('positive_box_tool')
          : t('mode_select_edit');

  const imageStatusText = selectedImagePath
    ? `${selectedImagePath} | ${promptModeText}`
    : promptModeText;

  const saveStatusText =
    saveStatus === 'unsaved'
      ? t('save_status_unsaved')
      : saveStatus === 'pending'
        ? t('save_status_pending')
        : saveStatus === 'saving'
          ? t('save_status_saving')
          : saveStatus === 'failed'
            ? t('save_status_failed')
            : t('save_status_saved');

  const saveStatusColor =
    saveStatus === 'failed' ? '#ef4444' : saveStatus === 'saved' ? '#10b981' : 'text.secondary';

  const floatingToolSx = (active: boolean) => ({
    minWidth: 0,
    width: 40,
    height: 40,
    borderRadius: '20px',
    fontSize: 11,
    fontWeight: 800,
    bgcolor: active ? 'action.selected' : 'transparent',
    border: '1px solid',
    borderColor: active ? 'primary.main' : 'transparent',
    color: active ? 'primary.main' : 'text.primary',
  });

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', bgcolor: 'background.default' }}>
      {/* 1. Top navigation bar */}
      <Box
        sx={{
          height: 56,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          px: 3,
          gap: 2.5,
          zIndex: 100,
          borderBottom: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <Box
          role="button"
          tabIndex={0}
          onClick={() => navigate('/')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              navigate('/');
            }
          }}
          title={t('back_to_projects')}
          sx={{ display: 'flex', alignItems: 'center', gap: 1.5, cursor: 'pointer' }}
        >
          <Typography component="span" sx={{ fontSize: 18 }} aria-hidden>
            {'<'}
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', maxWidth: 280 }}>
            <Typography sx={{ fontWeight: 700, fontSize: 14 }} noWrap>
              {projectName}
            </Typography>
            <Typography sx={{ fontSize: 10, color: 'text.secondary' }}>
              {t('image_project')}
            </Typography>
          </Box>
        </Box>

        <Box sx={{ flex: 1 }} />
        <GpuStatusWidget active />
        <Box sx={{ flex: 1 }} />

        {/* Panel visibility toggles — always available fallback when panels
            are collapsed (restored ui_state or edge buttons out of reach). */}
        <Tooltip title={t('left_panel_toggle')}>
          <IconButton
            size="small"
            onClick={() => useLayoutStore.getState().toggleLeftPanel()}
            aria-label={t('left_panel_toggle')}
            aria-pressed={!leftPanelHidden}
            sx={{
              width: 32,
              height: 32,
              color: leftPanelHidden ? 'text.secondary' : 'primary.main',
              bgcolor: leftPanelHidden ? 'transparent' : 'action.selected',
            }}
          >
            <ChevronLeftIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={t('right_panel_toggle')}>
          <IconButton
            size="small"
            onClick={() => useLayoutStore.getState().toggleRightPanel()}
            aria-label={t('right_panel_toggle')}
            aria-pressed={!rightPanelHidden}
            sx={{
              width: 32,
              height: 32,
              color: rightPanelHidden ? 'text.secondary' : 'primary.main',
              bgcolor: rightPanelHidden ? 'transparent' : 'action.selected',
            }}
          >
            <ChevronRightIcon fontSize="small" />
          </IconButton>
        </Tooltip>

        {/* Theme toggle (legacy btn-toggle-theme) */}
        <Tooltip title={t('toggle_theme')}>
          <IconButton
            size="small"
            onClick={() => setSetting('themeMode', themeMode === 'dark' ? 'light' : 'dark')}
            aria-label={t('toggle_theme')}
            sx={{ width: 32, height: 32, color: 'text.secondary' }}
          >
            {themeMode === 'dark' ? <LightModeIcon fontSize="small" /> : <DarkModeIcon fontSize="small" />}
          </IconButton>
        </Tooltip>

        {/* Backend health indicator (legacy startHealthCheck, 10 s polling) */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          <Box
            sx={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              bgcolor:
                backendHealth === 'online'
                  ? '#10b981'
                  : backendHealth === 'checking'
                    ? '#fbbf24'
                    : '#ef4444',
            }}
          />
          <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
            {backendHealth === 'online'
              ? t('backend_online')
              : backendHealth === 'error'
                ? t('backend_error')
                : backendHealth === 'offline'
                  ? t('backend_offline')
                  : t('backend_checking')}
          </Typography>
        </Box>

        {/* Mode indicator (review-specific UI is a phase-9 slot) */}
        <Chip
          size="small"
          label={isReviewMode ? t('workspace_mode_review') : t('workspace_mode_auto')}
          color={isReviewMode ? 'warning' : 'primary'}
          variant={isReviewMode ? 'outlined' : 'filled'}
          sx={{ fontWeight: 800, fontSize: 11 }}
        />
      </Box>

      {/* 2. Top operation bar (mode switch / review flow / dashboard+export) */}
      <WorkspaceToolbar projectId={projectId} />

      {/* 2b. Auto-annotate (inference) panel on its own wrapping row so its
             grouped controls are never clipped on narrow windows. */}
      {workspaceMode === 'auto' && (
        <Box
          sx={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            px: 3,
            py: 1.25,
            zIndex: 89,
            borderBottom: '1px solid',
            borderColor: 'divider',
            bgcolor: 'background.paper',
          }}
        >
          <AutoAnnotatePanel />
        </Box>
      )}

      {/* 3. Task progress bar (shadow row) */}
      <TaskProgressBar />

      {/* 4. Main workspace area */}
      <Box sx={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        {/* Left column: project meta + image list */}
        {!leftPanelHidden && (
          <Box
            sx={{
              width: 320,
              minWidth: 320,
              display: 'flex',
              flexDirection: 'column',
              zIndex: 50,
              minHeight: 0,
              bgcolor: 'background.paper',
              borderRight: '1px solid',
              borderColor: 'divider',
            }}
          >
            <Box sx={{ p: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
              <Paper variant="outlined" sx={{ p: 1.75, borderRadius: 2 }}>
                <Typography sx={{ fontSize: 15, fontWeight: 700 }} noWrap>
                  {projectName}
                </Typography>
                <Typography
                  sx={{ fontSize: 10, color: 'text.secondary', wordBreak: 'break-all', fontFamily: 'monospace' }}
                >
                  {projectId}
                </Typography>
                <Box sx={{ mt: 1.25, display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                  <Typography component="span" sx={{ fontSize: 11 }}>
                    {t('total')}: <b>{total}</b>
                  </Typography>
                  <Typography component="span" sx={{ fontSize: 11, color: '#10b981' }}>
                    {t('labeled')}: <b>{labeled}</b>
                  </Typography>
                </Box>
                <Box sx={{ mt: 1.5, display: 'flex', alignItems: 'center', gap: 1.25 }}>
                  <LinearProgress
                    variant="determinate"
                    value={progressPct}
                    sx={{ flex: 1, height: 6, borderRadius: 999 }}
                  />
                  <Typography sx={{ fontSize: 11, fontWeight: 700, color: 'text.secondary' }}>
                    {labeled} / {total}
                  </Typography>
                </Box>
              </Paper>
            </Box>

            <Box sx={{ px: 2.5, py: 1.5, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1.5 }}>
              <Typography sx={{ fontSize: 14, textTransform: 'uppercase', letterSpacing: 1, color: 'text.secondary' }}>
                {t('image_list')}
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Button
                  size="small"
                  variant={unlabeledNavigationEnabled ? 'contained' : 'outlined'}
                  title={t('unlabeled_nav_title')}
                  onClick={toggleUnlabeledNavigation}
                  sx={{ height: 28, fontSize: 11, fontWeight: 700 }}
                >
                  {unlabeledNavigationEnabled ? t('unlabeled_nav_on') : t('unlabeled_nav')}
                </Button>
                <Chip size="small" label={totalImages} sx={{ fontWeight: 700, fontSize: 11 }} />
              </Box>
            </Box>

            <FilterBar />
            <ImageList
              onDeleteImage={(imageId) => void deleteProjectImage(imageId)}
              onPageChange={(page) => void goToPage(page)}
            />
          </Box>
        )}

        {/* Center column: canvas + floating tools */}
        <Box sx={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, minHeight: 0, bgcolor: canvasBg }}>
          <Box sx={{ flex: 1, position: 'relative' }} onMouseDownCapture={onViewerMouseDownCapture}>
            <ImageViewer
              ref={viewerRef}
              tileInfo={tileInfo}
              previewInfo={previewInfo}
              annotations={visibleAnnotations}
              previews={previews}
              prompts={currentPrompts}
              promptMode={promptMode}
              boxPromptLabel={boxPromptLabel}
              focusedAnnotationId={focusedAnnotationId}
              options={viewerOptions}
              onPromptAdded={handlePromptAdded}
              onAnnotationSelected={handleAnnotationSelected}
              onAnnotationEditStart={handleAnnotationEditStart}
              onAnnotationUpdated={handleAnnotationUpdated}
              onAnnotationCreated={handleAnnotationCreated}
            />

            {(!selectedImageId || isImageLoading) && (
              <Box
                sx={{
                  position: 'absolute',
                  top: '50%',
                  left: '50%',
                  transform: 'translate(-50%, -50%)',
                  textAlign: 'center',
                  pointerEvents: 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 1.5,
                }}
              >
                {selectedImageId ? (
                  <CircularProgress size={32} sx={{ color: 'text.secondary' }} />
                ) : (
                  <ImageIcon sx={{ fontSize: 56, color: 'text.disabled' }} />
                )}
                <Typography sx={{ fontSize: 16, fontWeight: 600, color: 'text.secondary' }}>
                  {selectedImageId ? t('loading_image_annotations') : t('select_image_prompt')}
                </Typography>
              </Box>
            )}

            {/* Floating annotation toolbar (legacy canvas hover toolbar) */}
            <Paper
              elevation={4}
              sx={{
                position: 'absolute',
                top: 20,
                left: '50%',
                transform: 'translateX(-50%)',
                height: 50,
                borderRadius: '25px',
                display: 'flex',
                alignItems: 'center',
                px: 1,
                gap: 0.5,
                zIndex: 100,
              }}
            >
              <Typography sx={{ fontSize: 10, fontWeight: 800, color: 'text.secondary', px: 0.5 }}>
                {t('toolbar_annotate')}
              </Typography>
              <Tooltip title={t('tool_pointer_title')}>
                <Button size="small" onClick={() => setToolMode('none')} sx={floatingToolSx(promptMode === 'none')}>
                  <NearMeIcon fontSize="small" />
                </Button>
              </Tooltip>
              <Tooltip title={t('tool_manual_box_title')}>
                <Button size="small" onClick={() => setToolMode('manual-box')} sx={floatingToolSx(promptMode === 'manual-box')}>
                  <CropSquareIcon fontSize="small" />
                </Button>
              </Tooltip>
              <Tooltip title={t('tool_manual_polygon_title')}>
                <Button size="small" onClick={() => setToolMode('manual-polygon')} sx={floatingToolSx(promptMode === 'manual-polygon')}>
                  <PolylineIcon fontSize="small" />
                </Button>
              </Tooltip>
              <Box sx={{ width: 1, height: 24, bgcolor: 'divider', mx: 0.5 }} />
              <Tooltip title={t('tool_undo_title')}>
                <span>
                  <Button size="small" disabled={!canUndo} onClick={() => useAnnotationStore.getState().undo()} sx={floatingToolSx(false)}>
                    <UndoIcon fontSize="small" />
                  </Button>
                </span>
              </Tooltip>
              <Tooltip title={t('tool_redo_title')}>
                <span>
                  <Button size="small" disabled={!canRedo} onClick={() => useAnnotationStore.getState().redo()} sx={floatingToolSx(false)}>
                    <RedoIcon fontSize="small" />
                  </Button>
                </span>
              </Tooltip>
              <Tooltip title={t('tool_delete_ann_title')}>
                <Button size="small" onClick={handleDeleteFocusedAnnotation} sx={{ ...floatingToolSx(false), color: '#ef4444', opacity: focusedAnnotationId ? 1 : 0.45 }}>
                  <DeleteIcon fontSize="small" />
                </Button>
              </Tooltip>
              {/* SAM box-exemplar tools are auto-mode only (legacy .ws-auto-only) */}
              {!isReviewMode && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Box sx={{ width: 1, height: 24, bgcolor: 'divider', mx: 0.5 }} />
                  <Typography sx={{ fontSize: 10, fontWeight: 800, color: 'text.secondary', px: 0.5 }}>
                    {t('toolbar_sam')}
                  </Typography>
                  <Tooltip title={t('positive_box_tool')}>
                    <Button
                      size="small"
                      onClick={() => useViewerStore.getState().setBoxPromptLabel(1)}
                      sx={{ ...floatingToolSx(promptMode === 'box' && boxPromptLabel === 1), color: '#16a34a', width: 'auto', px: 1.25, gap: 0.5 }}
                    >
                      <AddBoxIcon fontSize="small" />
                      {t('tool_box_positive')}
                    </Button>
                  </Tooltip>
                  <Tooltip title={t('negative_box_tool')}>
                    <Button
                      size="small"
                      onClick={() => useViewerStore.getState().setBoxPromptLabel(0)}
                      sx={{ ...floatingToolSx(promptMode === 'box' && boxPromptLabel === 0), color: '#dc2626', width: 'auto', px: 1.25, gap: 0.5 }}
                    >
                      <IndeterminateCheckBoxIcon fontSize="small" />
                      {t('tool_box_negative')}
                    </Button>
                  </Tooltip>
                  <Tooltip title={t('tool_clear_prompts_title')}>
                    <Button size="small" onClick={handleClearPrompts} sx={floatingToolSx(false)}>
                      <ClearIcon fontSize="small" />
                    </Button>
                  </Tooltip>
                </Box>
              )}
              <Box sx={{ width: 1, height: 24, bgcolor: 'divider', mx: 0.5 }} />
              <Tooltip title={t('tool_fit_title')}>
                <Button size="small" onClick={handleFitToScreen} sx={floatingToolSx(false)}>
                  <ZoomOutMapIcon fontSize="small" />
                </Button>
              </Tooltip>
            </Paper>

            {/* Panel re-show toggles (legacy LayoutController edge buttons) */}
            <Tooltip title={t('collapse_expand')}>
              <IconButton
                size="small"
                onClick={() => useLayoutStore.getState().toggleLeftPanel()}
                sx={{
                  position: 'absolute',
                  top: '50%',
                  left: 14,
                  transform: 'translateY(-50%)',
                  width: 34,
                  height: 64,
                  borderRadius: '17px',
                  zIndex: 95,
                  border: '1px solid',
                  borderColor: 'divider',
                  bgcolor: (th) =>
                    `${th.palette.mode === 'dark' ? 'rgba(26,29,38,0.72)' : 'rgba(255,255,255,0.72)'}`,
                  backdropFilter: 'blur(4px)',
                  color: 'text.primary',
                }}
                aria-label={t('collapse_expand')}
              >
                {leftPanelHidden ? <ChevronRightIcon /> : <ChevronLeftIcon />}
              </IconButton>
            </Tooltip>
            <Tooltip title={t('collapse_expand')}>
              <IconButton
                size="small"
                onClick={() => useLayoutStore.getState().toggleRightPanel()}
                sx={{
                  position: 'absolute',
                  top: '50%',
                  right: 14,
                  transform: 'translateY(-50%)',
                  width: 34,
                  height: 64,
                  borderRadius: '17px',
                  zIndex: 95,
                  border: '1px solid',
                  borderColor: 'divider',
                  bgcolor: (th) =>
                    `${th.palette.mode === 'dark' ? 'rgba(26,29,38,0.72)' : 'rgba(255,255,255,0.72)'}`,
                  backdropFilter: 'blur(4px)',
                  color: 'text.primary',
                }}
                aria-label={t('collapse_expand')}
              >
                {rightPanelHidden ? <ChevronLeftIcon /> : <ChevronRightIcon />}
              </IconButton>
            </Tooltip>

            {/* Submit-all previews action bar (auto mode only) */}
            {!isReviewMode && previews.length > 0 && (
              <Button
                variant="contained"
                onClick={() => void keepAll()}
                sx={{
                  position: 'absolute',
                  bottom: 60,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  zIndex: 100,
                  borderRadius: '30px',
                  px: 4,
                  py: 1.5,
                  fontSize: 16,
                  fontWeight: 800,
                }}
              >
                {t('submit_all')}
              </Button>
            )}
          </Box>

          {/* Display toggles & status strip */}
          <Box
            sx={{
              height: 40,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              px: 2.5,
              gap: 2.5,
              bgcolor: 'background.paper',
              borderTop: '1px solid',
              borderColor: 'divider',
              zIndex: 40,
              fontSize: 11,
            }}
          >
            <FormControlLabel
              sx={{ m: 0, fontSize: 11 }}
              control={
                <Checkbox
                  size="small"
                  checked={showMasks}
                  onChange={(e) => useViewerStore.getState().setShowMasks(e.target.checked)}
                />
              }
              label={<Typography sx={{ fontSize: 11 }}>{t('show_masks')}</Typography>}
            />
            <FormControlLabel
              sx={{ m: 0 }}
              control={
                <Checkbox size="small" checked={autosaveEnabled} onChange={handleAutosaveToggle} />
              }
              label={<Typography sx={{ fontSize: 11 }}>{t('autosave_label')}</Typography>}
            />
            <Typography sx={{ fontWeight: 700, color: saveStatusColor, minWidth: 72, fontSize: 11 }}>
              {saveStatusText}
            </Typography>
            <Box sx={{ flex: 1 }} />
            <Typography sx={{ fontWeight: 700, color: 'text.secondary', fontSize: 11 }} noWrap>
              {isImageLoading && selectedImageId
                ? `${imageStatusText} | ${t('loading_image_annotations')}`
                : imageStatusText}
            </Typography>
          </Box>
        </Box>

        {/* Right column: classes + annotations + preview panels */}
        {!rightPanelHidden && (
          <Box
            sx={{
              width: 320,
              minWidth: 320,
              display: 'flex',
              flexDirection: 'column',
              zIndex: 50,
              minHeight: 0,
              bgcolor: 'background.paper',
              borderLeft: '1px solid',
              borderColor: 'divider',
            }}
          >
            {/* Classes management section */}
            <Box
              sx={{
                p: 2.5,
                borderBottom: '1px solid',
                borderColor: 'divider',
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
                maxHeight: '40%',
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
                <Typography sx={{ fontSize: 14, textTransform: 'uppercase', letterSpacing: 1, color: 'text.secondary' }}>
                  {t('annotations_summary')}
                </Typography>
                <IconButton
                  size="small"
                  title={t('collapse_expand')}
                  onClick={() => useLayoutStore.getState().toggleClassesSection()}
                  sx={{ width: 28, height: 28 }}
                  aria-label={t('collapse_expand')}
                >
                  {classesSectionCollapsed ? <ChevronRightIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                </IconButton>
              </Box>
              <ClassPanel collapsed={classesSectionCollapsed} />
            </Box>

            {/* Annotation list section */}
            <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
              <Box sx={{ px: 2.5, py: 1.25, borderBottom: '1px solid', borderColor: 'divider', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography sx={{ fontSize: 14, textTransform: 'uppercase', letterSpacing: 1, color: 'text.secondary' }}>
                  {t('annotation_list')}
                </Typography>
                <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'center' }}>
                  <Button
                    size="small"
                    variant="outlined"
                    title={t('migrate_sources')}
                    onClick={() => void handleMigrateSources()}
                    sx={{ height: 26, fontSize: 10, fontWeight: 600 }}
                  >
                    {t('migrate_sources')}
                  </Button>
                  <IconButton
                    size="small"
                    title={t('collapse_expand')}
                    onClick={() => useLayoutStore.getState().toggleAnnotationsSection()}
                    sx={{ width: 28, height: 28 }}
                    aria-label={t('collapse_expand')}
                  >
                    {annotationsSectionCollapsed ? <ChevronRightIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                  </IconButton>
                </Box>
              </Box>
              <AnnotationList collapsed={annotationsSectionCollapsed} />

              {/* SAM example-preview results (auto mode only) */}
              {!isReviewMode && (
                <Box sx={{ p: 1.5, borderTop: '1px solid', borderColor: 'divider', flexShrink: 0 }}>
                  <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1, mb: 0.5 }}>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography sx={{ fontSize: 13, fontWeight: 700 }}>
                        {t('preview_results')}
                      </Typography>
                      <Typography sx={{ fontSize: 10, color: 'text.secondary', lineHeight: 1.5 }}>
                        {t('preview_results_desc')}
                      </Typography>
                    </Box>
                    <IconButton
                      size="small"
                      title={t('collapse_expand')}
                      onClick={() => useViewerStore.getState().togglePreviewSection()}
                      sx={{ width: 24, height: 24, flexShrink: 0 }}
                      aria-label={t('collapse_expand')}
                    >
                      {previewSectionCollapsed ? <ChevronRightIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                    </IconButton>
                  </Box>
                  {!previewSectionCollapsed && <PreviewResultsPanel />}
                </Box>
              )}

              {/* Smart filter workbench (toolbar-toggled, right-column slot) */}
              {smartFilterOpen && (
                <Box
                  sx={{
                    borderTop: '1px solid',
                    borderColor: 'divider',
                    flexShrink: 0,
                    maxHeight: '55%',
                    overflowY: 'auto',
                    minHeight: 0,
                  }}
                >
                  <SmartFilterPanel
                    projectId={projectId}
                    onClose={() => useLayoutStore.getState().toggleSmartFilter()}
                  />
                </Box>
              )}
            </Box>
          </Box>
        )}
      </Box>

      {/* Modals */}
      <BatchConfigModal />
      <BatchResultModal />
      <BackendErrorModal />
    </Box>
  );
}
