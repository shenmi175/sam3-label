import { useCallback } from 'react';
import {
  addAiPoint as addAiPointApi,
  clearAiPrompts,
  closeAiSession,
  openAiSession,
  redoAiPrompt,
  undoAiPrompt,
} from '../api/ai';
import { getSam3Status } from '../api/system';
import { useSettingsStore } from '../stores/settingsStore';
import { useAiAssistantStore } from '../stores/workspace/aiAssistantStore';
import type { AiOperationMode } from '../stores/workspace/aiAssistantStore';
import { useAnnotationStore } from '../stores/workspace/annotationStore';
import { useImageStore } from '../stores/workspace/imageStore';
import { useProjectStore } from '../stores/workspace/projectStore';
import { useViewerStore } from '../stores/workspace/viewerStore';
import { useLayoutStore } from '../stores/workspace/layoutStore';
import { toast } from '../utils/notify';
import i18n from '../i18n';
import { logFeatureEvent } from '../api/audit';

function basePayload() {
  return {
    project_id: useProjectStore.getState().projectId,
    api_base_url: useSettingsStore.getState().sam3ApiUrl,
  };
}

let prepareSequence = 0;
let predictionTail: Promise<void> = Promise.resolve();
let pendingPredictions = 0;

async function closeCurrentSession(invalidate = true) {
  if (invalidate) prepareSequence += 1;
  const ai = useAiAssistantStore.getState();
  if (ai.sessionId) {
    try {
      await closeAiSession({ ...basePayload(), session_id: ai.sessionId });
    } catch {
      // Session expiry/eviction is harmless during cleanup.
    }
  }
  useViewerStore.getState().clearPrompts();
  useAiAssistantStore.getState().set({
    sessionId: '', imageId: '', candidate: null, selectedAnnotationId: '', predicting: false,
    preparing: invalidate ? false : ai.preparing,
    promptCount: 0, canUndoPrompt: false, canRedoPrompt: false,
  });
}

export function useAiAssistant() {
  const prepareCurrent = useCallback(async () => {
    const ai = useAiAssistantStore.getState();
    const image = useImageStore.getState();
    if (!ai.enabled || ai.preparing || !image.selectedImageId || image.isLoading) return false;
    const annotations = useAnnotationStore.getState();
    if (annotations.dirty) {
      if (!annotations.autosaveEnabled) {
        toast(i18n.t('ai_save_before_refine'), 'info');
        return false;
      }
      if (!(await annotations.flushSave('before-ai-assist'))) return false;
    }
    const operationMode = ai.operationMode;
    const focused = operationMode === 'refine'
      ? (useViewerStore.getState().focusedAnnotationId || '')
      : '';
    if (operationMode === 'refine' && !focused) {
      useViewerStore.getState().setPromptMode('none', 'review');
      toast(i18n.t('ai_refine_select_first'), 'info');
      return false;
    }
    if (operationMode === 'refine') {
      const currentAnnotations = useAnnotationStore.getState();
      const selected = currentAnnotations.imageId === image.selectedImageId
        ? currentAnnotations.annotations.find((annotation) => String(annotation?.id || '') === focused)
        : null;
      if (!selected || selected.temporary) {
        useViewerStore.getState().setFocusedAnnotation(null);
        useViewerStore.getState().setPromptMode('none', 'review');
        return false;
      }
    }
    const sequence = ++prepareSequence;
    ai.set({ preparing: true, candidate: null });
    await closeCurrentSession(false);
    const project = useProjectStore.getState();
    const unlabeledNavigation = useLayoutStore.getState().unlabeledNavigationEnabled;
    try {
      const response = await openAiSession({
        ...basePayload(),
        image_id: image.selectedImageId,
        selected_annotation_id: focused,
        image_filter_status: unlabeledNavigation
          ? 'unlabeled'
          : (project.imageFilterStatus === 'all' ? '' : project.imageFilterStatus),
        image_filter_class: unlabeledNavigation ? '' : project.imageFilterClass,
        source_model: !unlabeledNavigation && project.imageFilterClass
          ? useSettingsStore.getState().defaultBackend
          : '',
      });
      const session = response.session;
      if (
        sequence !== prepareSequence
        || useImageStore.getState().selectedImageId !== image.selectedImageId
        || !useAiAssistantStore.getState().enabled
      ) {
        if (session.session_id) {
          void closeAiSession({ ...basePayload(), session_id: session.session_id });
        }
        return false;
      }
      useAiAssistantStore.getState().set({
        sessionId: session.session_id,
        imageId: session.image_id,
        selectedAnnotationId: session.selected_annotation_id || '',
        featureStatus: session.feature_status || '',
      });
      useViewerStore.getState().setPromptMode('point', 'review');
      return true;
    } catch (err) {
      if (sequence === prepareSequence) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
      return false;
    } finally {
      if (sequence === prepareSequence) {
        useAiAssistantStore.getState().set({ preparing: false });
      }
    }
  }, []);

  const setOperationMode = useCallback(async (mode: AiOperationMode) => {
    const ai = useAiAssistantStore.getState();
    if (ai.operationMode === mode) return true;
    if (ai.preparing || ai.predicting || ai.promptCount > 0 || ai.candidate) {
      toast(i18n.t('ai_mode_switch_blocked'), 'info');
      return false;
    }
    ai.set({ operationMode: mode });
    if (mode === 'new') useViewerStore.getState().setFocusedAnnotation(null);
    if (!ai.enabled) return true;
    if (mode === 'refine' && !useViewerStore.getState().focusedAnnotationId) {
      await closeCurrentSession();
      useViewerStore.getState().setPromptMode('none', 'review');
      toast(i18n.t('ai_refine_select_first'), 'info');
      return true;
    }
    return prepareCurrent();
  }, [prepareCurrent]);

  const toggle = useCallback(async () => {
    const ai = useAiAssistantStore.getState();
    if (ai.enabled) {
      ai.set({ enabled: false });
      await closeCurrentSession();
      useViewerStore.getState().setPromptMode('none', 'review');
      return;
    }
    logFeatureEvent('open_ai_assistant', useProjectStore.getState().projectId);
    try {
      const status = await getSam3Status(useSettingsStore.getState().sam3ApiUrl);
      const result = (status.result || {}) as Record<string, unknown>;
      if (!result.model_loaded || !result.instance_interactivity_enabled) {
        const reason = !result.model_loaded
          ? i18n.t('ai_sam3_not_loaded')
          : i18n.t('ai_interactivity_unavailable');
        ai.set({ available: false, unavailableReason: reason });
        toast(reason, 'error');
        return;
      }
      ai.set({ enabled: true, available: true, unavailableReason: '' });
      await prepareCurrent();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ai.set({ available: false, unavailableReason: message });
      toast(message, 'error');
    }
  }, [prepareCurrent]);

  const addPoint = useCallback(async (x: number, y: number, explicitLabel?: 0 | 1) => {
    const ai = useAiAssistantStore.getState();
    if (!ai.enabled || !ai.sessionId) return;
    const sessionId = ai.sessionId;
    const label = explicitLabel ?? ai.pointLabel;
    pendingPredictions += 1;
    ai.set({ predicting: true });
    const task = predictionTail.catch(() => undefined).then(async () => {
      try {
        const response = await addAiPointApi({
          ...basePayload(), session_id: sessionId, x, y, label,
        });
        if (useAiAssistantStore.getState().sessionId === sessionId) {
          useAiAssistantStore.getState().set({
            candidate: response.candidate || null,
            promptCount: Number(response.points ?? useAiAssistantStore.getState().promptCount + 1),
            canUndoPrompt: response.can_undo ?? true,
            canRedoPrompt: response.can_redo ?? false,
          });
          if (!response.candidate) toast(i18n.t('ai_empty_candidate'), 'info');
        }
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        pendingPredictions = Math.max(0, pendingPredictions - 1);
        if (useAiAssistantStore.getState().sessionId === sessionId) {
          useAiAssistantStore.getState().set({ predicting: pendingPredictions > 0 });
        }
      }
    });
    predictionTail = task;
    await task;
  }, []);

  const clear = useCallback(async () => {
    const ai = useAiAssistantStore.getState();
    if (ai.sessionId) {
      try {
        await clearAiPrompts({ ...basePayload(), session_id: ai.sessionId });
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    }
    useViewerStore.getState().clearPrompts();
    ai.clearDraft();
  }, []);

  const finish = useCallback(async () => {
    await predictionTail;
    const ai = useAiAssistantStore.getState();
    if (!ai.sessionId || !ai.candidate) return null;
    if (useAnnotationStore.getState().imageId !== ai.imageId) return null;
    if (ai.selectedAnnotationId) {
      useAnnotationStore.getState().acceptAiCandidate(
        ai.candidate, ai.selectedAnnotationId, '',
      );
      await clear();
      toast(i18n.t('ai_refinement_applied'), 'success');
      return { kind: 'updated' as const };
    }
    return { kind: 'new' as const, candidate: ai.candidate };
  }, [clear]);

  const movePromptHistory = useCallback(async (direction: 'undo' | 'redo') => {
    const ai = useAiAssistantStore.getState();
    if (!ai.sessionId || ai.predicting) return false;
    const sessionId = ai.sessionId;
    ai.set({ predicting: true });
    try {
      let response: {
        candidate: import('../api/ai').AiCandidate | null;
        points: number;
        can_undo: boolean;
        can_redo: boolean;
      };
      try {
        response = await (direction === 'undo' ? undoAiPrompt : redoAiPrompt)({
          ...basePayload(), session_id: sessionId,
        });
      } catch (historyError) {
        const message = historyError instanceof Error ? historyError.message : String(historyError);
        if (!/(?:HTTP|API Error)\s*(?:error\s*)?(?:404|405)|Method Not Allowed/i.test(message)) throw historyError;

        // Compatibility with a SAM3/web-auto process that predates the prompt
        // history routes: reset the existing session and replay the desired
        // prefix through endpoints that were already available.
        const viewer = useViewerStore.getState();
        const desired = direction === 'undo'
          ? viewer.currentPrompts.slice(0, -1)
          : [...viewer.currentPrompts, ...viewer.promptRedoStack.slice(-1)];
        await clearAiPrompts({ ...basePayload(), session_id: sessionId });
        let candidate: import('../api/ai').AiCandidate | null = null;
        for (const prompt of desired) {
          if (prompt.type !== 'point') continue;
          const replayed = await addAiPointApi({
            ...basePayload(),
            session_id: sessionId,
            x: Number(prompt.data[0] || 0),
            y: Number(prompt.data[1] || 0),
            label: Number(prompt.label) === 0 ? 0 : 1,
          });
          candidate = replayed.candidate || null;
        }
        response = {
          candidate,
          points: desired.length,
          can_undo: desired.length > 0,
          can_redo: direction === 'undo',
        };
      }
      if (direction === 'undo') useViewerStore.getState().undoPrompt();
      else useViewerStore.getState().redoPrompt();
      useAiAssistantStore.getState().set({
        candidate: response.candidate || null,
        promptCount: Number(response.points || 0),
        canUndoPrompt: Boolean(response.can_undo),
        canRedoPrompt: Boolean(response.can_redo),
      });
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
      return false;
    } finally {
      if (useAiAssistantStore.getState().sessionId === sessionId) {
        useAiAssistantStore.getState().set({ predicting: false });
      }
    }
  }, []);

  const cancel = useCallback(async () => {
    await clear();
  }, [clear]);

  return {
    toggle, prepareCurrent, setOperationMode, addPoint, clear, finish, cancel,
    undoPrompt: () => movePromptHistory('undo'),
    redoPrompt: () => movePromptHistory('redo'),
  };
}

export { closeCurrentSession };
