import { create } from 'zustand';
import type { AiCandidate } from '../../api/ai';

export type AiOperationMode = 'new' | 'refine';

interface AiAssistantStore {
  enabled: boolean;
  preparing: boolean;
  predicting: boolean;
  available: boolean;
  unavailableReason: string;
  sessionId: string;
  imageId: string;
  candidate: AiCandidate | null;
  operationMode: AiOperationMode;
  pointLabel: 0 | 1;
  selectedAnnotationId: string;
  featureStatus: string;
  promptCount: number;
  canUndoPrompt: boolean;
  canRedoPrompt: boolean;
  set: (partial: Partial<AiAssistantStore>) => void;
  clearDraft: () => void;
  reset: () => void;
}

const initial = {
  enabled: false,
  preparing: false,
  predicting: false,
  available: true,
  unavailableReason: '',
  sessionId: '',
  imageId: '',
  candidate: null,
  operationMode: 'new' as AiOperationMode,
  pointLabel: 1 as 0 | 1,
  selectedAnnotationId: '',
  featureStatus: '',
  promptCount: 0,
  canUndoPrompt: false,
  canRedoPrompt: false,
};

export const useAiAssistantStore = create<AiAssistantStore>((set) => ({
  ...initial,
  set: (partial) => set(partial),
  clearDraft: () => set({ candidate: null, pointLabel: 1, promptCount: 0, canUndoPrompt: false, canRedoPrompt: false }),
  reset: () => set(initial),
}));
