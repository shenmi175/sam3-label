import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportProject, preflightExport } from './exports';


const options = {
  project_id: 'project-1',
  profile: 'yolo_instance' as const,
  output_dir: '/srv/exports',
  source_models: ['sam3'],
  classes: ['door'],
  val_ratio: 0.2,
  yolo_multipart_policy: 'official_bridge' as const,
  image_mode: 'none' as const,
  confirmed_issue_codes: [],
};

describe('profile export API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the common preflight endpoint for every profile', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        ok: true,
        profile: 'yolo_instance',
        project_content_rev: 3,
        confirmation_required_codes: ['YOLO_MULTIPART_BRIDGE'],
        stats: {}, warnings: [], blockers: [], format_details: {},
      }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const result = await preflightExport(options);
    expect(result.project_content_rev).toBe(3);
    expect(fetchMock).toHaveBeenCalledWith('/api/export/preflight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });
  });

  it('sends the preflight revision and explicit issue confirmation when exporting', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true, output: '/srv/exports/yolo_instance' }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const payload = { ...options, confirmed_issue_codes: ['YOLO_MULTIPART_BRIDGE'], expected_content_rev: 3 };
    await exportProject(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/export', expect.objectContaining({ body: JSON.stringify(payload) }));
  });
});
