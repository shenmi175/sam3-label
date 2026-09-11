export type FeatureEventAction =
  | 'open_full_image_inference'
  | 'open_ai_assistant'
  | 'open_data_cleaning'
  | 'open_import_export'
  | 'open_service_management';

/** Best-effort semantic UI telemetry. It must never block the user's action. */
export function logFeatureEvent(
  action: FeatureEventAction,
  projectId = '',
  details: Record<string, unknown> = {},
): void {
  try {
    const body = JSON.stringify({ action, project_id: projectId, details });
    if (new TextEncoder().encode(body).byteLength > 16 * 1024) return;
    void fetch('/api/log/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Telemetry must never interrupt the feature being opened.
  }
}
