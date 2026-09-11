import { get, post } from './client';

export interface AiCandidate {
  bbox: [number, number, number, number];
  polygon: [number, number][];
  polygons: [number, number][][];
  area: number;
  score: number;
}

export interface AiSessionResponse {
  session_id: string;
  image_id: string;
  feature_status?: string;
  state?: string;
  selected_annotation_id?: string;
  refining_existing?: boolean;
}

export function openAiSession(payload: Record<string, unknown>) {
  return post<{ ok: boolean; session: AiSessionResponse; prefetch_image_ids?: string[] }>('/ai/session/open', payload);
}

export function addAiPoint(payload: Record<string, unknown>) {
  return post<{
    ok: boolean;
    session_id: string;
    candidate: AiCandidate | null;
    points?: number;
    can_undo?: boolean;
    can_redo?: boolean;
  }>('/ai/point', payload);
}

export function clearAiPrompts(payload: Record<string, unknown>) {
  return post<Record<string, unknown>>('/ai/prompts/clear', payload);
}

export function undoAiPrompt(payload: Record<string, unknown>) {
  return post<{ ok: boolean; candidate: AiCandidate | null; points: number; can_undo: boolean; can_redo: boolean }>('/ai/prompts/undo', payload);
}

export function redoAiPrompt(payload: Record<string, unknown>) {
  return post<{ ok: boolean; candidate: AiCandidate | null; points: number; can_undo: boolean; can_redo: boolean }>('/ai/prompts/redo', payload);
}

export function acceptAiMask(payload: Record<string, unknown>) {
  return post<{ ok: boolean; candidate: AiCandidate; selected_annotation_id: string; refining_existing: boolean }>('/ai/mask/accept', payload);
}

export function closeAiSession(payload: Record<string, unknown>) {
  return post<Record<string, unknown>>('/ai/session/close', payload, { keepalive: true });
}

export function getAiFeatureStatus(projectId: string, imageId = '') {
  const query = new URLSearchParams({ project_id: projectId });
  if (imageId) query.set('image_id', imageId);
  return get<Record<string, unknown>>(`/ai/features/status?${query.toString()}`);
}

export function deleteAiFeatures(payload: Record<string, unknown>) {
  return post<Record<string, unknown>>('/ai/features/delete', payload);
}
