import { useCallback, useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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
import ImageIcon from '@mui/icons-material/Image';
import { useTranslation } from 'react-i18next';
import { ImageViewer, type ImageViewerHandle } from '../components/viewer/ImageViewer';
import type { Annotation } from '../api/types';
import { clearBundleCache } from '../api/bundleCache';
import { useSettingsStore } from '../stores/settingsStore';
import { useProjectStore } from '../stores/workspace/projectStore';
import { useImageStore } from '../stores/workspace/imageStore';
import { useAnnotationStore } from '../stores/workspace/annotationStore';
import { useViewerStore, filterAnnotationsBySource } from '../stores/workspace/viewerStore';
import { useInferenceStore } from '../stores/workspace/inferenceStore';
import { useAiAssistantStore } from '../stores/workspace/aiAssistantStore';
import { useLayoutStore } from '../stores/workspace/layoutStore';
import { useTasksStore } from '../stores/workspace/tasksStore';
import { useSmartFilterStore } from '../stores/workspace/smartFilterStore';
import { useImageNavigation } from '../hooks/useImageNavigation';
import { useKeyboardCommands } from '../hooks/useKeyboardCommands';
import { useUiStateSync, restoreUiState } from '../hooks/useUiStateSync';
import { useJobPolling, stopJobPolling } from '../hooks/useJobPolling';
import { useBackendHealth } from '../hooks/useBackendHealth';
import { ImageList } from '../components/workspace/ImageList';
import { FilterBar } from '../components/workspace/FilterBar';
import { ClassPanel } from '../components/workspace/ClassPanel';
import { AnnotationList } from '../components/workspace/AnnotationList';
import { WorkspaceToolbar } from '../components/workspace/WorkspaceToolbar';
import { TaskProgressBar } from '../components/workspace/TaskProgressBar';
import { GpuStatusWidget } from '../components/workspace/GpuStatusWidget';
import { BatchConfigModal } from '../components/workspace/BatchConfigModal';
import { BatchResultModal } from '../components/workspace/BatchResultModal';
import { BackendErrorModal } from '../components/workspace/BackendErrorModal';
import { UnsavedChangesDialog } from '../components/workspace/UnsavedChangesDialog';
import { AutoCanvasToolbar, ManualCanvasToolbar } from '../components/workspace/CanvasToolbars';
import type { ManualWorkspaceController } from '../hooks/useManualWorkspaceController';

/**
 * Shared image workspace shell — React assembly of the legacy
 * `js/pages/image-workspace.js` God Object page.
 *
 * Initialization order mirrors the legacy render():
 *   loadProjectInfo → restoreUiState → (route mode wins) → loadImages →
 *   restore the selected image. Unmount mirrors legacy unmount(): abort /
 *   clear bundle cache / flush ui_state (useUiStateSync) / reset all stores.
 *
 * Manual-mode viewer callbacks dispatch to the stores like the legacy wiring:
 *   onPromptAdded         → viewerStore.addPrompt
 *   onAnnotationSelected  → viewerStore.setFocusedAnnotation
 *   onAnnotationEditStart → annotationStore.pushHistory
 *   onAnnotationUpdated   → annotationStore.handleGeometryUpdated (markDirty)
 *   onAnnotationCreated   → annotationStore.createAnnotation (+review continuous)
 */
export type ImageWorkspaceShellProps = {
  viewerRef: RefObject<ImageViewerHandle | null>;
  modePanel: ReactNode;
} & (
  | { mode: 'auto'; manual?: never }
  | { mode: 'review'; manual: ManualWorkspaceController }
);

export function ImageWorkspaceShell({ mode, viewerRef, modePanel, manual }: ImageWorkspaceShellProps) {
  const { id = '' } = useParams();
  const projectId = id;
  const navigate = useNavigate();
  const { t } = useTranslation();
  const theme = useTheme();
  const themeMode = useSettingsStore((s) => s.themeMode);
  const setSetting = useSettingsStore((s) => s.set);

  /** Canvas / center-column background, aligned with the viewer core. */
  const canvasBg = theme.palette.mode === 'dark' ? '#1b1e26' : '#eaeff2';

  // Route-derived workspace mode (legacy routeWorkspaceMode).
  const routeMode = mode;
  const editable = mode === 'review';
  const commitPolygonGuardRef = useRef<() => boolean>(() => true);
  commitPolygonGuardRef.current = manual?.commitPolygonGuard ?? (() => true);

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
  const saveStatus = useAnnotationStore((s) => s.saveStatus);

  const promptMode = useViewerStore((s) => s.promptMode);
  const currentPrompts = useViewerStore((s) => s.currentPrompts);
  const focusedAnnotationId = useViewerStore((s) => s.focusedAnnotationId);
  const highlightedAnnotationIds = useViewerStore((s) => s.highlightedAnnotationIds);
  const showMasks = useViewerStore((s) => s.showMasks);

  const workspaceMode = useLayoutStore((s) => s.workspaceMode);
  const leftPanelHidden = useLayoutStore((s) => s.leftPanelHidden);
  const rightPanelHidden = useLayoutStore((s) => s.rightPanelHidden);
  const classesSectionCollapsed = useLayoutStore((s) => s.classesSectionCollapsed);
  const annotationsSectionCollapsed = useLayoutStore((s) => s.annotationsSectionCollapsed);
  const unlabeledNavigationEnabled = useLayoutStore((s) => s.unlabeledNavigationEnabled);

  // Backend health indicator — legacy startHealthCheck (10 s /api/health).
  const backendHealth = useBackendHealth();

  // The route component owns the mode; persisted UI state cannot override it.
  const isReviewMode = editable;

  // Legacy single-select source filter applied to the viewer + list.
  const visibleAnnotations = useMemo(
    () => filterAnnotationsBySource(annotations, sourceFilter),
    [annotations, sourceFilter],
  );
  const viewerAnnotations = useMemo(() => {
    const aiCandidate = manual?.aiCandidate;
    if (!aiCandidate) return visibleAnnotations;
    const candidate: Annotation = {
      id: '__sam3_ai_candidate__',
      class_name: t('ai_candidate'),
      bbox: aiCandidate.bbox,
      polygon: aiCandidate.polygon,
      polygons: aiCandidate.polygons,
      score: aiCandidate.score,
      color: '#22d3ee',
      source_model: 'sam3',
      temporary: true,
    };
    return [...visibleAnnotations, candidate];
  }, [visibleAnnotations, manual?.aiCandidate, t]);

  const viewerOptions = useMemo(() => ({ showMasks }), [showMasks]);

  const { loadImages, goToPage, toggleUnlabeledNavigation, deleteProjectImage } =
    useImageNavigation();

  // Debounced ui_state sync + unmount flush (legacy scheduleProjectUIStateSave).
  useUiStateSync(projectId);
  // Restore the project's active infer job on mount, stop polling on unmount.
  useJobPolling(projectId);

  const handleAnnotationSelected = useCallback((annotationId: string | null) => {
    useViewerStore.getState().setFocusedAnnotation(annotationId);
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
    useAiAssistantStore.getState().reset();
    useLayoutStore.getState().reset();
    useSmartFilterStore.getState().reset();
    useAnnotationStore.getState().setEditingEnabled(editable);
    useViewerStore.getState().setEditable(editable);

    useViewerStore
      .getState()
      .registerCommitPolygonGuard(() => commitPolygonGuardRef.current());
    useLayoutStore.getState().setRouteWorkspaceMode(routeMode);
    useLayoutStore.getState().setWorkspaceMode(routeMode);
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
      useAiAssistantStore.getState().reset();
      useAnnotationStore.getState().reset();
      useViewerStore.getState().reset();
      useLayoutStore.getState().reset();
      useProjectStore.getState().reset();
      useAnnotationStore.getState().setUnmounted(true);
    };
  }, [projectId, routeMode, editable, loadImages]);

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

  useKeyboardCommands({
    editable,
    onFitToScreen: handleFitToScreen,
    onDeleteImage: handleDeleteImage,
    onUndo: manual?.onUndo,
    onRedo: manual?.onRedo,
    onToggleAiOperationMode: manual?.onToggleAiOperationMode,
    onToggleAiPointLabel: manual?.onToggleAiPointLabel,
  });

  // ─── Toolbar / status-bar helpers ───────────────────────────────────────────

  const setToolMode = useCallback(
    (mode: 'none' | 'manual-box' | 'manual-polygon' | 'point') => {
      useViewerStore.getState().setPromptMode(mode, workspaceMode);
    },
    [workspaceMode],
  );

  const guardedNavigate = useCallback(async (target: string) => {
    if (!useViewerStore.getState().commitPendingManualPolygon()) return;
    if (!(await useAnnotationStore.getState().prepareForNavigation())) return;
    navigate(target);
  }, [navigate]);


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
          onClick={() => void guardedNavigate('/')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              void guardedNavigate('/');
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

        {/* Mode indicator (auto/review switch lives in WorkspaceToolbar) */}
        <Chip
          size="small"
          label={isReviewMode ? t('workspace_mode_review') : t('workspace_mode_auto')}
          color={isReviewMode ? 'warning' : 'primary'}
          variant={isReviewMode ? 'outlined' : 'filled'}
          sx={{ fontWeight: 800, fontSize: 11 }}
        />
      </Box>

      {/* 2. Top operation bar (mode switch / review flow / dashboard+export) */}
      <WorkspaceToolbar mode={mode} modePanel={modePanel} projectId={projectId} />

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
          <Box sx={{ flex: 1, position: 'relative' }} onMouseDownCapture={manual?.onViewerMouseDownCapture}>
            <ImageViewer
              editable={editable}
              ref={viewerRef}
              tileInfo={tileInfo}
              previewInfo={previewInfo}
              annotations={viewerAnnotations}
              prompts={currentPrompts}
              promptMode={promptMode}
              pointPromptLabel={manual?.pointPromptLabel ?? 1}
              focusedAnnotationId={focusedAnnotationId}
              highlightedAnnotationIds={highlightedAnnotationIds}
              options={viewerOptions}
              onPromptAdded={manual?.onPromptAdded}
              onAnnotationSelected={handleAnnotationSelected}
              onAnnotationEditStart={manual?.onAnnotationEditStart}
              onAnnotationUpdated={manual?.onAnnotationUpdated}
              onAnnotationCreated={manual?.onAnnotationCreated}
              onInteractionComplete={manual?.onInteractionComplete}
              onCanvasContextMenu={manual?.onCanvasContextMenu}
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

            {manual ? (
              <ManualCanvasToolbar
                promptMode={promptMode}
                onSetToolMode={setToolMode}
                onFitToScreen={handleFitToScreen}
                aiEnabled={manual.aiEnabled}
                aiPredicting={manual.aiPredicting}
                aiPromptCount={manual.aiPromptCount}
                aiOperationMode={manual.aiOperationMode}
                aiCanUndoPrompt={manual.aiCanUndoPrompt}
                aiCanRedoPrompt={manual.aiCanRedoPrompt}
                pointPromptLabel={manual.pointPromptLabel}
                canUndo={manual.canUndo}
                canRedo={manual.canRedo}
                hasFocusedAnnotation={Boolean(focusedAnnotationId)}
                onSelectAiPointLabel={manual.onSelectAiPointLabel}
                onSetAiOperationMode={manual.onSetAiOperationMode}
                onClearAiPrompts={manual.onClearAiPrompts}
                onUndo={manual.onUndo}
                onRedo={manual.onRedo}
                onDeleteFocusedAnnotation={manual.onDeleteFocusedAnnotation}
              />
            ) : (
              <AutoCanvasToolbar promptMode={promptMode} onSetToolMode={setToolMode} onFitToScreen={handleFitToScreen} />
            )}

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

        {/* Right column: classes + annotations */}
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
              <AnnotationList collapsed={annotationsSectionCollapsed} editable={editable} />
            </Box>
          </Box>
        )}
      </Box>

      {/* Modals */}
      <BatchConfigModal />
      <BatchResultModal />
      <BackendErrorModal />
      <UnsavedChangesDialog />
      {manual?.overlays}
    </Box>
  );
}
