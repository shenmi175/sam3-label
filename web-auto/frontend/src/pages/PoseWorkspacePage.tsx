import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Box, Button, IconButton, TextField, Tooltip, Typography } from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import { useTranslation } from 'react-i18next';
import { getProject, type ProjectInfo } from '../api/projects';
import { getImages, getImageFileUrl } from '../api/images';
import { getAnnotations, saveAnnotations as saveAnnotationsApi } from '../api/annotations';
import { inferPose, type PoseAnnotation } from '../api/pose';
import type { Annotation, ImageInfo } from '../api/types';
import { toast } from '../utils/notify';

const POSE_PAGE_LIMIT = 1000;

/** Legacy normalizeAnnotations — fills ids/labels and array defaults. */
function normalizeAnnotations(anns: PoseAnnotation[] | null | undefined): PoseAnnotation[] {
  return (Array.isArray(anns) ? anns : [])
    .filter((ann) => Boolean(ann) && typeof ann === 'object')
    .map((ann, index) => ({
      ...ann,
      id: ann.id || `pose_local_${index + 1}`,
      type: 'pose',
      label: ann.label || ann.class_name || 'person_pose',
      class_name: ann.class_name || ann.label || 'person_pose',
      keypoints: Array.isArray(ann.keypoints) ? ann.keypoints : [],
      skeleton_links: Array.isArray(ann.skeleton_links) ? ann.skeleton_links : [],
    }));
}

/**
 * Pose workspace page — 1:1 port of the legacy pages/pose-workspace.js:
 * image list (fully paginated), /api/pose/infer with sapiens, SVG keypoint /
 * skeleton / bbox overlay with draggable keypoints, thresholds, save/clear,
 * arrow-key navigation and Ctrl+S.
 */
export function PoseWorkspacePage() {
  const { id = '' } = useParams();
  const projectId = id;
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedImageId, setSelectedImageId] = useState('');
  const [annotations, setAnnotations] = useState<PoseAnnotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState('');
  const [status, setStatus] = useState(t('pose_status_waiting'));
  const [bboxThr, setBboxThr] = useState(0.3);
  const [kptThr, setKptThr] = useState(0.3);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [imgRev, setImgRev] = useState(0);
  const [naturalSize, setNaturalSize] = useState({ w: 1, h: 1 });

  const svgRef = useRef<SVGSVGElement | null>(null);
  const draggingRef = useRef<{ annId: string; keypointIndex: number } | null>(null);
  const imagesRef = useRef<ImageInfo[]>([]);
  imagesRef.current = images;
  const annotationsRef = useRef<PoseAnnotation[]>([]);
  annotationsRef.current = annotations;

  // ─── Data loading (legacy loadProject + loadImages) ─────────────────────────

  const loadAllImages = useCallback(async (): Promise<ImageInfo[]> => {
    let offset = 0;
    let totalCount = 0;
    const items: ImageInfo[] = [];
    do {
      const data = await getImages(projectId, offset, POSE_PAGE_LIMIT);
      const pageItems = data?.items || [];
      items.push(...pageItems);
      totalCount = Number(data?.total || items.length || 0);
      offset += pageItems.length;
      if (!pageItems.length) break;
    } while (offset < totalCount);
    setImages(items);
    setTotal(totalCount || items.length);
    return items;
  }, [projectId]);

  const selectImage = useCallback(
    async (imageId: string) => {
      const image = imagesRef.current.find((item) => item.id === imageId);
      if (!image) return;
      setSelectedImageId(imageId);
      setSelectedAnnotationId('');
      setAnnotations([]);
      setStatus(t('pose_status_loading'));
      setImgRev(Date.now());
      try {
        const data = await getAnnotations(projectId, imageId);
        const normalized = normalizeAnnotations(data?.annotations || []);
        setAnnotations(normalized);
        setStatus(t('pose_status_loaded', { count: normalized.length }));
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
        setStatus(t('pose_status_load_failed'));
      }
    },
    [projectId, t],
  );

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await getProject(projectId, false);
        if (cancelled) return;
        const info = data?.project;
        if (!info || String(info.project_type || 'image') !== 'pose') {
          toast(t('pose_not_pose_project'), 'error');
          navigate('/');
          return;
        }
        setProject(info);
        const items = await loadAllImages();
        if (cancelled) return;
        if (items.length > 0) {
          // imagesRef is kept in sync with setImages for selectImage lookups.
          imagesRef.current = items;
          await selectImage(String(items[0].id));
        }
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const selectByOffset = useCallback(
    (delta: number) => {
      const list = imagesRef.current;
      if (!list.length) return;
      const current = list.findIndex((img) => img.id === selectedImageId);
      const base = current >= 0 ? current : 0;
      const next = Math.max(0, Math.min(list.length - 1, base + delta));
      if (next === base && selectedImageId) return;
      void selectImage(String(list[next].id));
    },
    [selectedImageId, selectImage],
  );

  // ─── Actions (legacy runPose / saveAnnotations / clearAnnotations) ──────────

  const runPose = useCallback(async () => {
    if (!selectedImageId || running) return;
    setRunning(true);
    setStatus(t('pose_status_infer_running'));
    try {
      const data = await inferPose({
        project_id: projectId,
        image_id: selectedImageId,
        bbox_threshold: Number(bboxThr) || 0.3,
        keypoint_threshold: Number(kptThr) || 0.3,
        nms_threshold: 0.3,
      });
      const normalized = normalizeAnnotations(data?.saved_annotations || data?.annotations || []);
      setAnnotations(normalized);
      setImages((prev) =>
        prev.map((img) =>
          img.id === selectedImageId
            ? { ...img, status: normalized.length ? 'labeled' : 'unlabeled' }
            : img,
        ),
      );
      setStatus(t('pose_status_generated', { count: normalized.length }));
      toast(t('pose_infer_done'), 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
      setStatus(t('pose_status_infer_failed'));
    } finally {
      setRunning(false);
    }
  }, [selectedImageId, running, projectId, bboxThr, kptThr, t]);

  const saveAnnotations = useCallback(
    async (listOverride?: PoseAnnotation[]) => {
      if (!selectedImageId) return;
      const list = listOverride ?? annotationsRef.current;
      try {
        setSaving(true);
        const data = await saveAnnotationsApi(
          projectId,
          selectedImageId,
          list as unknown as Annotation[],
        );
        const saved = normalizeAnnotations(
          (data as { saved_annotations?: PoseAnnotation[] })?.saved_annotations || [],
        );
        const next = saved.length ? saved : list;
        setAnnotations(next);
        setImages((prev) =>
          prev.map((img) =>
            img.id === selectedImageId ? { ...img, status: next.length ? 'labeled' : 'unlabeled' } : img,
          ),
        );
        setStatus(t('pose_status_saved'));
        toast(t('save_success'), 'success');
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        setSaving(false);
      }
    },
    [projectId, selectedImageId, t],
  );

  const clearAnnotations = useCallback(() => {
    if (!selectedImageId) return;
    setAnnotations([]);
    setSelectedAnnotationId('');
    void saveAnnotations([]);
  }, [selectedImageId, saveAnnotations]);

  const deleteAnnotation = useCallback((annId: string) => {
    setAnnotations((prev) => prev.filter((ann) => ann.id !== annId));
    setSelectedAnnotationId((prev) => (prev === annId ? '' : prev));
  }, []);

  // ─── Keyboard shortcuts (legacy keyHandler) ─────────────────────────────────

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.key === 'ArrowLeft') selectByOffset(-1);
      if (event.key === 'ArrowRight') selectByOffset(1);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveAnnotations();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectByOffset, saveAnnotations]);

  // ─── SVG overlay interaction (legacy renderOverlay + drag handlers) ─────────

  const eventToImagePoint = useCallback(
    (event: React.PointerEvent) => {
      const svg = svgRef.current;
      const w = naturalSize.w || 1;
      const h = naturalSize.h || 1;
      if (!svg) return { x: 0, y: 0 };
      const rect = svg.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * w;
      const y = ((event.clientY - rect.top) / Math.max(1, rect.height)) * h;
      return { x: Math.max(0, Math.min(w, x)), y: Math.max(0, Math.min(h, y)) };
    },
    [naturalSize],
  );

  const startDrag = useCallback((event: React.PointerEvent, annId: string, keypointIndex: number) => {
    const ann = annotationsRef.current.find((item) => item.id === annId);
    if (!ann || !Number.isInteger(keypointIndex)) return;
    setSelectedAnnotationId(annId);
    draggingRef.current = { annId, keypointIndex };
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }, []);

  const moveDrag = useCallback(
    (event: React.PointerEvent) => {
      const dragging = draggingRef.current;
      if (!dragging) return;
      const pos = eventToImagePoint(event);
      setAnnotations((prev) =>
        prev.map((ann) => {
          if (ann.id !== dragging.annId) return ann;
          const keypoints = (ann.keypoints || []).map((kp, idx) =>
            idx === dragging.keypointIndex ? [pos.x, pos.y, Number(kp?.[2] ?? 1), 1] : kp,
          );
          return { ...ann, keypoints };
        }),
      );
    },
    [eventToImagePoint],
  );

  const endDrag = useCallback(() => {
    draggingRef.current = null;
  }, []);

  const isVisibleKp = useCallback(
    (kp: number[] | undefined) => Number(kp?.[3] ?? 1) > 0 && Number(kp?.[2] ?? 1) >= kptThr,
    [kptThr],
  );

  // ─── Render ─────────────────────────────────────────────────────────────────

  const selectedIndex = images.findIndex((img) => img.id === selectedImageId);

  return (
    <Box sx={{ height: '100vh', overflow: 'hidden', display: 'grid', gridTemplateRows: 'auto 1fr', bgcolor: 'background.default' }}>
      {/* Header */}
      <Box
        sx={{
          height: 56,
          px: 2.25,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
          borderBottom: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
          <Button size="small" variant="outlined" onClick={() => navigate('/')} sx={{ minWidth: 32, width: 32, height: 32, p: 0 }} aria-label={t('pose_back')}>
            {'\u2190'}
          </Button>
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ fontSize: 16, fontWeight: 800 }} noWrap>
              {project?.name || projectId || t('pose_workspace_title')}
            </Typography>
            <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.25 }}>
              {project ? t('pose_subtitle') : t('pose_loading')}
            </Typography>
          </Box>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Tooltip title={t('project_manage')}>
            <IconButton size="small" onClick={() => navigate(`/project/${encodeURIComponent(projectId)}/manage`)} aria-label={t('project_manage')}>
              <SettingsIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Button size="small" variant="outlined" onClick={() => selectByOffset(-1)} sx={{ fontSize: 12 }}>
            {t('pose_prev')}
          </Button>
          <Button size="small" variant="outlined" onClick={() => selectByOffset(1)} sx={{ fontSize: 12 }}>
            {t('pose_next')}
          </Button>
          <Button
            size="small"
            variant="contained"
            disabled={running || !selectedImageId}
            onClick={() => void runPose()}
            sx={{ fontWeight: 800, fontSize: 12 }}
          >
            {running ? t('pose_running') : t('pose_run')}
          </Button>
          <Button
            size="small"
            variant="outlined"
            disabled={saving || !selectedImageId}
            onClick={() => void saveAnnotations()}
            sx={{ fontSize: 12 }}
          >
            {t('pose_save')}
          </Button>
        </Box>
      </Box>

      {/* Body */}
      <Box sx={{ minHeight: 0, display: 'grid', gridTemplateColumns: '280px minmax(0,1fr) 320px', gap: 1.75, p: 1.75 }}>
        {/* Image list */}
        <Box sx={{ p: 1.75, minHeight: 0, display: 'grid', gridTemplateRows: 'auto 1fr', gap: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 2, bgcolor: 'background.paper' }}>
          <Box>
            <Typography sx={{ fontWeight: 800, fontSize: 15 }}>{t('pose_image_list')}</Typography>
            <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5 }}>
              {t('pose_images_count', { count: total })}
              {selectedIndex >= 0 ? ` · ${selectedIndex + 1}/${images.length}` : ''}
            </Typography>
          </Box>
          <Box sx={{ minHeight: 0, overflow: 'auto', display: 'grid', gap: 1, alignContent: 'start' }}>
            {images.length === 0 && (
              <Typography sx={{ fontSize: 13, color: 'text.secondary', p: 1.75 }}>{t('pose_no_images')}</Typography>
            )}
            {images.map((img, index) => {
              const selected = img.id === selectedImageId;
              const labeled = img.status === 'labeled';
              return (
                <Button
                  key={String(img.id)}
                  variant={selected ? 'contained' : 'outlined'}
                  onClick={() => void selectImage(String(img.id))}
                  sx={{ flexDirection: 'column', alignItems: 'stretch', gap: 0.5, p: 1.25, textTransform: 'none' }}
                >
                  <Typography sx={{ fontSize: 13, fontWeight: 800, textAlign: 'left' }} noWrap>
                    {index + 1}. {img.rel_path || img.id}
                  </Typography>
                  <Typography sx={{ fontSize: 11, textAlign: 'left', color: labeled ? '#10b981' : selected ? 'inherit' : 'text.secondary' }}>
                    {labeled ? t('pose_labeled') : t('pose_unlabeled')}
                  </Typography>
                </Button>
              );
            })}
          </Box>
        </Box>

        {/* Canvas */}
        <Box sx={{ padding: 0, minHeight: 0, overflow: 'hidden', position: 'relative', border: '1px solid', borderColor: 'divider', borderRadius: 2, bgcolor: 'background.paper' }}>
          <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'rgba(0,0,0,0.16)', overflow: 'hidden' }}>
            <Box sx={{ position: 'relative', maxWidth: '100%', maxHeight: '100%', lineHeight: 0 }}>
              {selectedImageId && (
                <img
                  src={`${getImageFileUrl(projectId, selectedImageId)}?rev=${imgRev}`}
                  alt=""
                  onLoad={(e) => {
                    const el = e.currentTarget;
                    setNaturalSize({ w: el.naturalWidth || 1, h: el.naturalHeight || 1 });
                  }}
                  style={{ display: 'block', maxWidth: '100%', maxHeight: 'calc(100vh - 92px)', userSelect: 'none' }}
                />
              )}
              <svg
                ref={svgRef}
                viewBox={`0 0 ${naturalSize.w} ${naturalSize.h}`}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible', touchAction: 'none' }}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                {annotations.map((ann) => {
                  const selected = ann.id === selectedAnnotationId;
                  const color = selected ? '#38bdf8' : '#fbbf24';
                  const keypoints = Array.isArray(ann.keypoints) ? ann.keypoints : [];
                  const bbox = Array.isArray(ann.bbox) && ann.bbox.length >= 4 ? ann.bbox : null;
                  return (
                    <g key={String(ann.id)}>
                      {bbox && (
                        <rect
                          x={Number(bbox[0])}
                          y={Number(bbox[1])}
                          width={Math.max(0, Number(bbox[2]) - Number(bbox[0]))}
                          height={Math.max(0, Number(bbox[3]) - Number(bbox[1]))}
                          fill="none"
                          stroke={color}
                          strokeWidth={1.2}
                          strokeDasharray="6 4"
                          opacity={0.55}
                          vectorEffect="non-scaling-stroke"
                        />
                      )}
                      {(Array.isArray(ann.skeleton_links) ? ann.skeleton_links : []).map((pair, idx) => {
                        const a = Number(pair?.[0]);
                        const b = Number(pair?.[1]);
                        if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
                        const ka = keypoints[a];
                        const kb = keypoints[b];
                        if (!isVisibleKp(ka) || !isVisibleKp(kb)) return null;
                        return (
                          <line
                            key={idx}
                            x1={Number(ka[0])}
                            y1={Number(ka[1])}
                            x2={Number(kb[0])}
                            y2={Number(kb[1])}
                            stroke={color}
                            strokeWidth={selected ? 2.8 : 1.8}
                            opacity={0.78}
                            vectorEffect="non-scaling-stroke"
                          />
                        );
                      })}
                      {keypoints.map((kp, idx) => {
                        if (!isVisibleKp(kp)) return null;
                        return (
                          <circle
                            key={idx}
                            cx={Number(kp[0])}
                            cy={Number(kp[1])}
                            r={selected ? 4.2 : 3.2}
                            fill={color}
                            stroke="#0f172a"
                            strokeWidth={1.5}
                            vectorEffect="non-scaling-stroke"
                            style={{ cursor: 'grab' }}
                            onPointerDown={(e) => startDrag(e, String(ann.id), idx)}
                          />
                        );
                      })}
                    </g>
                  );
                })}
              </svg>
            </Box>
          </Box>
        </Box>

        {/* Right panel */}
        <Box sx={{ p: 1.75, minHeight: 0, display: 'grid', gridTemplateRows: 'auto auto 1fr', gap: 1.75, border: '1px solid', borderColor: 'divider', borderRadius: 2, bgcolor: 'background.paper' }}>
          <Box>
            <Typography sx={{ fontWeight: 800, fontSize: 15 }}>{t('pose_annotations_title')}</Typography>
            <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5 }}>{status}</Typography>
          </Box>
          <Box sx={{ p: 1.5, display: 'grid', gap: 1.25, borderRadius: 1.5, boxShadow: 'inset 2px 2px 5px rgba(0,0,0,0.06)' }}>
            <TextField
              size="small"
              type="number"
              fullWidth
              label={t('pose_bbox_thr')}
              value={bboxThr}
              inputProps={{ min: 0, max: 1, step: 0.05 }}
              onChange={(e) => setBboxThr(Number(e.target.value) || 0)}
            />
            <TextField
              size="small"
              type="number"
              fullWidth
              label={t('pose_kpt_thr')}
              value={kptThr}
              inputProps={{ min: 0, max: 1, step: 0.05 }}
              onChange={(e) => setKptThr(Number(e.target.value) || 0)}
            />
            <Button size="small" variant="outlined" color="error" onClick={clearAnnotations} disabled={!selectedImageId}>
              {t('pose_clear')}
            </Button>
          </Box>
          <Box sx={{ minHeight: 0, overflow: 'auto', display: 'grid', gap: 1, alignContent: 'start' }}>
            {annotations.length === 0 && (
              <Typography sx={{ fontSize: 13, color: 'text.secondary', p: 1.75 }}>{t('pose_no_annotations')}</Typography>
            )}
            {annotations.map((ann, index) => {
              const selected = ann.id === selectedAnnotationId;
              const keypoints = ann.keypoints || [];
              const visiblePoints = keypoints.filter((kp) => Number(kp?.[3] ?? 1) > 0).length;
              const score = Number(ann.score || 0);
              return (
                <Box
                  key={String(ann.id)}
                  sx={{
                    p: 1.5,
                    display: 'grid',
                    gap: 1,
                    borderRadius: 1.5,
                    border: '1px solid',
                    borderColor: selected ? 'primary.main' : 'divider',
                    boxShadow: selected ? 'inset 2px 2px 5px rgba(0,0,0,0.06)' : 'none',
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1.25 }}>
                    <Button
                      size="small"
                      onClick={() => setSelectedAnnotationId(String(ann.id))}
                      sx={{ flex: 1, justifyContent: 'flex-start', fontWeight: 800, fontSize: 12, textTransform: 'none' }}
                    >
                      <Typography noWrap sx={{ fontWeight: 800, fontSize: 12 }}>
                        #{index + 1} {ann.label || 'person_pose'}
                      </Typography>
                    </Button>
                    <Button
                      size="small"
                      onClick={() => deleteAnnotation(String(ann.id))}
                      sx={{ minWidth: 30, width: 30, height: 30, p: 0, color: '#ef4444' }}
                      aria-label={t('delete')}
                    >
                      {'\u00D7'}
                    </Button>
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Typography component="span" sx={{ fontSize: 12, color: 'text.secondary' }}>
                      {visiblePoints}/{keypoints.length} {t('pose_points')}
                    </Typography>
                    <Typography component="span" sx={{ fontSize: 12, color: 'text.secondary' }}>
                      {t('pose_conf')} {score.toFixed(3)}
                    </Typography>
                  </Box>
                </Box>
              );
            })}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
