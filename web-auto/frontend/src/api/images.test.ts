import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('./client', () => ({
  get: getMock,
  post: vi.fn(),
  del: vi.fn(),
  request: vi.fn(),
}));

import { getImages } from './images';


describe('getImages', () => {
  beforeEach(() => getMock.mockReset());

  it('binds a class filter to its inference source', () => {
    getImages('project id', 0, 50, {
      className: 'dog',
      sourceModel: 'locate-anything',
    });

    expect(getMock).toHaveBeenCalledOnce();
    expect(getMock.mock.calls[0][0]).toContain('class_name=dog');
    expect(getMock.mock.calls[0][0]).toContain('source_model=locate-anything');
  });

  it('does not scope the unfiltered image list to a source', () => {
    getImages('project', 0, 50, { sourceModel: 'sam3' });

    expect(getMock.mock.calls[0][0]).not.toContain('source_model=');
  });
});
