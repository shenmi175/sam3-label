import { describe, expect, it } from 'vitest';
import { annotationSource, hasSegmentationGeometry } from './annotations';

describe('annotation interpretation helpers', () => {
  it('infers source-less segmentation as SAM3 but leaves bbox-only provenance unknown', () => {
    expect(annotationSource({ id: 'missing' })).toBe('unknown');
    expect(annotationSource({ id: 'legacy-mask', mask_url: '/mask.png' })).toBe('sam3');
    expect(annotationSource({ id: 'legacy-polygon', polygon: [[0, 0], [1, 0], [1, 1]] })).toBe('sam3');
    expect(annotationSource({ id: 'manual', source: 'manual' })).toBe('sam3');
    expect(annotationSource({ id: 'la', source_model: 'LA' })).toBe('locate-anything');
  });

  it('treats empty polygon collections as absent', () => {
    expect(hasSegmentationGeometry({ id: 'empty', polygon: [], polygons: [] })).toBe(false);
    expect(hasSegmentationGeometry({ id: 'polygon', polygon: [[0, 0], [1, 0], [1, 1]] })).toBe(true);
    expect(hasSegmentationGeometry({ id: 'mask', mask_url: '/mask.png' })).toBe(true);
  });
});
