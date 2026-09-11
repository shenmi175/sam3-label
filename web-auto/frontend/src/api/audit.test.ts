import { afterEach, describe, expect, it, vi } from 'vitest';
import { logFeatureEvent } from './audit';

describe('feature event logging', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses a compact keepalive request and includes project context', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));
    logFeatureEvent('open_data_cleaning', 'project-1', { entry: 'toolbar' });
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/log/events');
    expect(options).toMatchObject({ method: 'POST', keepalive: true });
    expect(JSON.parse(String(options?.body))).toEqual({
      action: 'open_data_cleaning',
      project_id: 'project-1',
      details: { entry: 'toolbar' },
    });
  });

  it('silently ignores collection failures', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    expect(() => logFeatureEvent('open_service_management')).not.toThrow();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
