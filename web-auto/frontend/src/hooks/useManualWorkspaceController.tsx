import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Menu, MenuItem } from '@mui/material';
import { useTranslation } from 'react-i18next';
import type { Annotation } from '../api/types';
import type { AiCandidate } from '../api/ai';
import type { ImageViewerHandle } from '../components/viewer/ImageViewer';
import type { ManualAnnotationDraft } from '../components/viewer/viewer-core';
import { NewAnnotationClassDialog } from '../components/workspace/NewAnnotationClassDialog';
import { useAnnotationStore, selectCanRedo, selectCanUndo } from '../stores/workspace/annotationStore';
import { useAiAssistantStore } from '../stores/workspace/aiAssistantStore';
import type { AiOperationMode } from '../stores/workspace/aiAssistantStore';
import { useImageStore } from '../stores/workspace/imageStore';
import { useLayoutStore } from '../stores/workspace/layoutStore';
import { useProjectStore } from '../stores/workspace/projectStore';
import { useViewerStore } from '../stores/workspace/viewerStore';
import { closeCurrentSession, useAiAssistant } from './useAiAssistant';
import { toast } from '../utils/notify';

type PendingNewAnnotation =
  | { kind: 'manual'; draft: ManualAnnotationDraft; returnMode: 'manual-box' | 'manual-polygon' }
  | { kind: 'ai'; candidate: AiCandidate };

export interface ManualWorkspaceController {
  aiCandidate: AiCandidate | null;
  aiEnabled: boolean;
  aiPredicting: boolean;
  aiOperationMode: AiOperationMode;
  aiPromptCount: number;
  aiCanUndoPrompt: boolean;
  aiCanRedoPrompt: boolean;
  pointPromptLabel: 0 | 1;
  canUndo: boolean;
  canRedo: boolean;
  onPromptAdded: (type: 'point', data: number[]) => void;
  onAnnotationEditStart: () => void;
  onAnnotationUpdated: (annotation: Annotation) => void;
  onAnnotationCreated: (draft: ManualAnnotationDraft) => void;
  onInteractionComplete: () => Promise<void>;
  onCanvasContextMenu: (info: { clientX: number; clientY: number }) => void;
  onViewerMouseDownCapture: (event: React.MouseEvent) => void;
  onSelectAiPointLabel: (label: 0 | 1) => void;
  onToggleAiPointLabel: () => void;
  onSetAiOperationMode: (mode: AiOperationMode) => void;
  onToggleAiOperationMode: () => void;
  onClearAiPrompts: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onDeleteFocusedAnnotation: () => void;
  commitPolygonGuard: () => boolean;
  overlays: React.ReactNode;
}

export function useManualWorkspaceController(
  viewerRef: RefObject<ImageViewerHandle | null>,
): ManualWorkspaceController {
  const { t } = useTranslation();
  const [pendingNewAnnotation, setPendingNewAnnotation] = useState<PendingNewAnnotation | null>(null);
  const [aiContextMenu, setAiContextMenu] = useState<{ mouseX: number; mouseY: number } | null>(null);
  const polygonPointsRef = useRef(0);
  const commitProbeRef = useRef<'idle' | 'pending' | 'created'>('idle');
  const pendingAiBindingRef = useRef('');
  const failedAiBindingRef = useRef('');

  const selectedImageId = useImageStore((state) => state.selectedImageId);
  const isImageLoading = useImageStore((state) => state.isLoading);
  const focusedAnnotationId = useViewerStore((state) => state.focusedAnnotationId);
  const promptMode = useViewerStore((state) => state.promptMode);
  const pointPromptLabel = useViewerStore((state) => state.pointPromptLabel);
  const canUndo = useAnnotationStore(selectCanUndo);
  const canRedo = useAnnotationStore(selectCanRedo);
  const aiEnabled = useAiAssistantStore((state) => state.enabled);
  const aiSessionImageId = useAiAssistantStore((state) => state.imageId);
  const aiSelectedAnnotationId = useAiAssistantStore((state) => state.selectedAnnotationId);
  const aiCandidate = useAiAssistantStore((state) => state.candidate);
  const aiCanUndoPrompt = useAiAssistantStore((state) => state.canUndoPrompt);
  const aiCanRedoPrompt = useAiAssistantStore((state) => state.canRedoPrompt);
  const aiPromptCount = useAiAssistantStore((state) => state.promptCount);
  const aiPreparing = useAiAssistantStore((state) => state.preparing);
  const aiPredicting = useAiAssistantStore((state) => state.predicting);
  const aiOperationMode = useAiAssistantStore((state) => state.operationMode);
  const ai = useAiAssistant();
  const { addPoint: addAiPoint, prepareCurrent: prepareAiCurrent } = ai;

  const onPromptAdded = useCallback((type: 'point', data: number[]) => {
    useViewerStore.getState().addPrompt(type, data);
    if (useAiAssistantStore.getState().enabled) {
      void addAiPoint(Number(data[0] || 0), Number(data[1] || 0), Number(data[2]) === 0 ? 0 : 1);
    }
  }, [addAiPoint]);

  const onAnnotationEditStart = useCallback(() => {
    useAnnotationStore.getState().pushHistory();
  }, []);

  const onAnnotationUpdated = useCallback((annotation: Annotation) => {
    const annotationId = String(annotation?.id || '');
    if (annotationId) useAnnotationStore.getState().handleGeometryUpdated(annotationId, annotation);
  }, []);

  const onAnnotationCreated = useCallback((draft: ManualAnnotationDraft) => {
    commitProbeRef.current = 'created';
    polygonPointsRef.current = 0;
    const currentMode = useViewerStore.getState().promptMode;
    setPendingNewAnnotation({
      kind: 'manual',
      draft,
      returnMode: currentMode === 'manual-polygon' ? 'manual-polygon' : 'manual-box',
    });
  }, []);

  const onInteractionComplete = useCallback(async () => {
    if (!useAiAssistantStore.getState().enabled) return;
    const result = await ai.finish();
    if (result?.kind === 'new') setPendingNewAnnotation({ kind: 'ai', candidate: result.candidate });
    if (result?.kind === 'updated' && !useAnnotationStore.getState().autosaveEnabled) {
      void useAnnotationStore.getState().saveCurrent();
    }
  }, [ai]);

  const onSelectAiPointLabel = useCallback((label: 0 | 1) => {
    const assistant = useAiAssistantStore.getState();
    if (
      assistant.enabled
      && assistant.operationMode === 'refine'
      && !assistant.sessionId
      && !useViewerStore.getState().focusedAnnotationId
    ) {
      useViewerStore.getState().setPromptMode('none', 'review');
      toast(t('ai_refine_select_first'), 'info');
      return;
    }
    useAiAssistantStore.getState().set({ pointLabel: label });
    useViewerStore.getState().setPointPromptLabel(label);
    if (!useAiAssistantStore.getState().enabled) void ai.toggle();
  }, [ai, t]);

  const onSetAiOperationMode = useCallback((mode: AiOperationMode) => {
    void ai.setOperationMode(mode);
  }, [ai]);

  const onToggleAiPointLabel = useCallback(() => {
    if (!useAiAssistantStore.getState().enabled) return;
    const current = useViewerStore.getState().pointPromptLabel;
    onSelectAiPointLabel(current === 1 ? 0 : 1);
  }, [onSelectAiPointLabel]);

  const onToggleAiOperationMode = useCallback(() => {
    const state = useAiAssistantStore.getState();
    void ai.setOperationMode(state.operationMode === 'new' ? 'refine' : 'new');
  }, [ai]);

  const onCanvasContextMenu = useCallback((info: { clientX: number; clientY: number }) => {
    if (useAiAssistantStore.getState().enabled) {
      setAiContextMenu({ mouseX: info.clientX + 2, mouseY: info.clientY + 2 });
    }
  }, []);

  const confirmNewAnnotation = useCallback((className: string) => {
    const pending = pendingNewAnnotation;
    if (!pending) return;
    useProjectStore.getState().setSelectedClass(className);
    if (pending.kind === 'manual') {
      useAnnotationStore.getState().createAnnotation(
        { bbox: pending.draft.bbox, polygon: pending.draft.polygon },
        className,
      );
      if (useLayoutStore.getState().reviewContinuousMode) {
        useViewerStore.getState().setPromptMode(pending.returnMode, 'review');
      }
    } else {
      useAnnotationStore.getState().acceptAiCandidate(pending.candidate, '', className);
      void ai.clear();
      useViewerStore.getState().setFocusedAnnotation(null);
      if (!useAnnotationStore.getState().autosaveEnabled) void useAnnotationStore.getState().saveCurrent();
    }
    setPendingNewAnnotation(null);
  }, [ai, pendingNewAnnotation]);

  const cancelNewAnnotation = useCallback(() => {
    if (pendingNewAnnotation?.kind === 'ai') void ai.clear();
    setPendingNewAnnotation(null);
  }, [ai, pendingNewAnnotation]);

  const onUndo = useCallback(() => {
    if (useAiAssistantStore.getState().canUndoPrompt) void ai.undoPrompt();
    else useAnnotationStore.getState().undo();
  }, [ai]);

  const onRedo = useCallback(() => {
    if (useAiAssistantStore.getState().canRedoPrompt) void ai.redoPrompt();
    else useAnnotationStore.getState().redo();
  }, [ai]);

  const onDeleteFocusedAnnotation = useCallback(() => {
    const focused = useViewerStore.getState().focusedAnnotationId;
    if (!focused) {
      toast(t('select_annotation_first'), 'info');
      return;
    }
    useAnnotationStore.getState().deleteAnnotation(focused);
  }, [t]);

  const commitPolygonGuard = useCallback(() => {
    if (useViewerStore.getState().promptMode !== 'manual-polygon') return true;
    const points = polygonPointsRef.current;
    if (points === 0) return true;
    if (points < 3) {
      toast(t('polygon_need_3_points'), 'error');
      return false;
    }
    commitProbeRef.current = 'pending';
    viewerRef.current?.finishManualPolygon();
    const committed = (commitProbeRef.current as string) === 'created';
    commitProbeRef.current = 'idle';
    if (!committed) toast(t('polygon_commit_failed'), 'error');
    return committed;
  }, [t, viewerRef]);

  const onViewerMouseDownCapture = useCallback((event: React.MouseEvent) => {
    if (event.button === 0 && !event.altKey && useViewerStore.getState().promptMode === 'manual-polygon') {
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

  useEffect(() => {
    if (!aiEnabled) {
      pendingAiBindingRef.current = '';
      failedAiBindingRef.current = '';
      return;
    }
    if (aiPreparing || !selectedImageId || isImageLoading) return;
    if (aiOperationMode === 'refine' && !focusedAnnotationId) return;
    const focused = aiOperationMode === 'refine' ? (focusedAnnotationId || '') : '';
    const bindingKey = `${selectedImageId}:${aiOperationMode}:${focused}`;

    if (failedAiBindingRef.current && failedAiBindingRef.current !== bindingKey) {
      failedAiBindingRef.current = '';
    }
    if (failedAiBindingRef.current === bindingKey || pendingAiBindingRef.current === bindingKey) return;

    if (aiOperationMode === 'refine') {
      const annotationState = useAnnotationStore.getState();
      if (annotationState.imageId !== selectedImageId) return;
      const selected = annotationState.annotations.find((annotation) => String(annotation?.id || '') === focused);
      if (!selected || selected.temporary) {
        // A display-only AI candidate or stale local ID must never be sent as
        // selected_annotation_id. Clear it silently and wait for a real pick.
        useViewerStore.getState().setFocusedAnnotation(null);
        return;
      }
    }

    const sessionMatches = aiSessionImageId === selectedImageId
      && (aiOperationMode !== 'refine' || focused === aiSelectedAnnotationId);
    if (sessionMatches) return;
    if (
      aiOperationMode === 'refine'
      && (useViewerStore.getState().currentPrompts.length > 0 || aiCandidate)
    ) return;

    pendingAiBindingRef.current = bindingKey;
    void prepareAiCurrent().then((prepared) => {
      if (pendingAiBindingRef.current === bindingKey) pendingAiBindingRef.current = '';
      if (prepared) {
        if (failedAiBindingRef.current === bindingKey) failedAiBindingRef.current = '';
      } else {
        failedAiBindingRef.current = bindingKey;
      }
    });
  }, [
    aiEnabled,
    aiPreparing,
    selectedImageId,
    isImageLoading,
    aiSessionImageId,
    aiOperationMode,
    focusedAnnotationId,
    aiSelectedAnnotationId,
    aiCandidate,
    prepareAiCurrent,
  ]);

  useEffect(() => () => {
    void closeCurrentSession();
    useAiAssistantStore.getState().reset();
  }, []);

  const overlays = (
    <>
      <NewAnnotationClassDialog
        open={Boolean(pendingNewAnnotation)}
        onCancel={cancelNewAnnotation}
        onConfirm={confirmNewAnnotation}
      />
      <Menu
        open={Boolean(aiContextMenu)}
        onClose={() => setAiContextMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={aiContextMenu ? { top: aiContextMenu.mouseY, left: aiContextMenu.mouseX } : undefined}
      >
        <MenuItem disabled={!aiCandidate || aiPredicting} onClick={() => { setAiContextMenu(null); void onInteractionComplete(); }}>
          {t('ai_finish_from_menu')}
        </MenuItem>
        <MenuItem disabled={!aiCanUndoPrompt || aiPredicting} onClick={() => { setAiContextMenu(null); onUndo(); }}>
          {t('ai_undo_prompt')}
        </MenuItem>
        <MenuItem disabled={!aiCanRedoPrompt || aiPredicting} onClick={() => { setAiContextMenu(null); onRedo(); }}>
          {t('ai_redo_prompt')}
        </MenuItem>
        <MenuItem disabled={!aiEnabled || aiPredicting} onClick={() => { setAiContextMenu(null); void ai.clear(); }}>
          {t('ai_clear_prompts')}
        </MenuItem>
      </Menu>
    </>
  );

  return {
    aiCandidate,
    aiEnabled,
    aiPredicting,
    aiOperationMode,
    aiPromptCount,
    aiCanUndoPrompt,
    aiCanRedoPrompt,
    pointPromptLabel,
    canUndo,
    canRedo,
    onPromptAdded,
    onAnnotationEditStart,
    onAnnotationUpdated,
    onAnnotationCreated,
    onInteractionComplete,
    onCanvasContextMenu,
    onViewerMouseDownCapture,
    onSelectAiPointLabel,
    onToggleAiPointLabel,
    onSetAiOperationMode,
    onToggleAiOperationMode,
    onClearAiPrompts: () => { void ai.clear(); },
    onUndo,
    onRedo,
    onDeleteFocusedAnnotation,
    commitPolygonGuard,
    overlays,
  };
}
