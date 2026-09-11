import type { Annotation } from '../api/types';

export function annotationSource(annotation: Annotation | null | undefined): string {
  const raw = String(annotation?.source_model || annotation?.source || '').trim().toLowerCase();
  if (!raw) return hasSegmentationGeometry(annotation) ? 'sam3' : 'unknown';
  const slug = raw.replaceAll('_', '-').replace(/\s+/g, '-');
  if (slug === 'sam' || slug === 'sam-3') return 'sam3';
  if (slug === 'la' || slug === 'locateanything') return 'locate-anything';
  // Legacy human/manual producer values are migrated into the SAM3 result
  // layer. Keep old cached payloads visible until that migration is applied.
  if (slug === 'manual' || slug === 'human' || slug === 'annotator' || slug === 'human-annotation') return 'sam3';
  return slug;
}

export function hasSegmentationGeometry(annotation: Annotation | null | undefined): boolean {
  if (!annotation) return false;
  const polygon = annotation.polygon;
  const polygons = annotation.polygons;
  return (
    (Array.isArray(polygon) && polygon.length >= 3)
    || (Array.isArray(polygons) && polygons.some((region) => Array.isArray(region) && region.length >= 3))
    || Boolean(String(annotation.mask_url || annotation.mask_png_base64 || annotation.mask_png || '').trim())
  );
}
