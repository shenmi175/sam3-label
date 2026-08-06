import { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  FormControlLabel,
  IconButton,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { previewExport, exportProject } from '../../api/exports';
import type { ExportPreviewResponse } from '../../api/exports';
import type { ApiError } from '../../api/client';
import { useProjectStore } from '../../stores/workspace/projectStore';
import { toast } from '../../utils/notify';

interface ExportPanelProps {
  projectId: string;
  open: boolean;
  onClose: () => void;
}

const SOURCES = ['sam3', 'locate-anything', 'manual'] as const;

/**
 * Export dialog — 1:1 port of the legacy ExportController + export-panel.js
 * with purely local state: preview counts (per source / per class), source
 * filters, class selection (all/invert), COCO/YOLO/JSON format options and
 * the final export with the legacy stats message.
 */
export function ExportPanel({ projectId, open, onClose }: ExportPanelProps) {
  const { t } = useTranslation();
  const projectClasses = useProjectStore((s) => s.classes);

  const [format, setFormat] = useState('coco');
  const [includeBbox, setIncludeBbox] = useState(true);
  const [includeMask, setIncludeMask] = useState(false);
  const [sources, setSources] = useState<Record<string, boolean>>({
    sam3: true,
    'locate-anything': false,
    manual: true,
  });
  const [selectedClasses, setSelectedClasses] = useState<Record<string, boolean>>({});
  const [valRatio, setValRatio] = useState(0);
  const [writeDataYaml, setWriteDataYaml] = useState(true);
  const [outputDir, setOutputDir] = useState('');
  const [status, setStatus] = useState(t('export_ready_hint'));
  const [stats, setStats] = useState('');
  const [preview, setPreview] = useState<ExportPreviewResponse | null>(null);
  const [exporting, setExporting] = useState(false);

  // Legacy loadPreview: fetch per-source/per-class counts when opened.
  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    setStatus(t('export_ready_hint'));
    setStats('');
    void (async () => {
      let data: ExportPreviewResponse | null = null;
      try {
        data = await previewExport({ project_id: projectId });
      } catch {
        if (!cancelled) setStatus(t('export_preview_failed'));
      }
      if (cancelled) return;
      setPreview(data);
      const classes = data?.classes?.length ? data.classes : projectClasses;
      setSelectedClasses(Object.fromEntries(classes.map((cls) => [cls, true])));
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectId, projectClasses, t]);

  // Legacy updateExportOptions: yolo cannot export bbox+mask together.
  const handleFormatChange = (next: string) => {
    setFormat(next);
    if (next === 'yolo' && includeBbox && includeMask) setIncludeMask(false);
  };
  const handleBboxChange = (checked: boolean) => {
    setIncludeBbox(checked);
    if (format === 'yolo' && checked && includeMask) setIncludeMask(false);
  };
  const handleMaskChange = (checked: boolean) => {
    setIncludeMask(checked);
    if (format === 'yolo' && includeBbox && checked) setIncludeBbox(false);
  };

  const classList = preview?.classes?.length ? preview.classes : projectClasses;
  const byClass = preview?.by_class || {};
  const bySource = preview?.by_source || {};
  const noPolygon = preview?.no_polygon_by_source || {};

  const toggleAllClasses = useCallback(() => {
    setSelectedClasses((prev) => {
      const allChecked = classList.length > 0 && classList.every((cls) => prev[cls]);
      return Object.fromEntries(classList.map((cls) => [cls, !allChecked]));
    });
  }, [classList]);

  const invertClasses = useCallback(() => {
    setSelectedClasses((prev) => Object.fromEntries(classList.map((cls) => [cls, !prev[cls]])));
  }, [classList]);

  const handleExport = async () => {
    const checkedSources = SOURCES.filter((src) => sources[src]);
    if (!checkedSources.length) {
      setStatus(t('export_empty_title'));
      return;
    }
    const checkedClasses = classList.filter((cls) => selectedClasses[cls]);
    const allSelected = classList.length > 0 && checkedClasses.length === classList.length;
    try {
      setExporting(true);
      setStatus(t('export_running'));
      setStats('');
      const res = await exportProject({
        project_id: projectId,
        format,
        include_bbox: includeBbox,
        include_mask: includeMask,
        output_dir: outputDir.trim() || null,
        source_models: checkedSources,
        classes: allSelected ? [] : checkedClasses,
        val_ratio: Number(valRatio) || 0,
        write_data_yaml: writeDataYaml,
      });
      setStatus(t('export_done', { output: res?.output || '' }));
      const s = res?.stats || {};
      setStats(
        t('export_stats', {
          anns: Number(s.annotations_written || 0),
          images: Number(s.images_written || 0),
          source: Number(s.skipped_source || 0),
          cls: Number(s.skipped_class || 0),
          poly: Number(s.skipped_no_polygon || 0),
          bbox: Number(s.skipped_no_bbox || 0),
          missing: Number(s.images_missing || 0),
        }),
      );
      toast(t('export_success'), 'success');
    } catch (err) {
      const detail = (err as ApiError)?.detail as
        | { code?: string; by_source?: Record<string, number> }
        | undefined;
      if (detail && detail.code === 'EXPORT_EMPTY') {
        const bySourceText = Object.entries(detail.by_source || {})
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        setStatus(`${t('export_empty_title')}${bySourceText ? ` (${bySourceText})` : ''}`);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setStatus(message);
        toast(message, 'error');
      }
    } finally {
      setExporting(false);
    }
  };

  const labelSx = { fontSize: 11, fontWeight: 700, mb: 0.75, display: 'block' };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <Box sx={{ p: 3, position: 'relative', maxHeight: '88vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <IconButton
          size="small"
          onClick={onClose}
          aria-label={t('close')}
          sx={{ position: 'absolute', top: 12, right: 12, color: '#ef4444' }}
        >
          {'\u00D7'}
        </IconButton>
        <Typography sx={{ fontSize: 18, fontWeight: 800 }}>{t('export')}</Typography>

        <Box sx={{ display: 'flex', gap: 2 }}>
          <Box sx={{ flex: 1 }}>
            <Typography component="label" sx={labelSx}>{t('export_format')}</Typography>
            <Select size="small" fullWidth value={format} onChange={(e) => handleFormatChange(String(e.target.value))}>
              <MenuItem value="coco">COCO</MenuItem>
              <MenuItem value="yolo">YOLO</MenuItem>
              <MenuItem value="json">JSON</MenuItem>
            </Select>
          </Box>
          <Box sx={{ flex: 1 }}>
            <Typography component="label" sx={labelSx}>{t('export_content')}</Typography>
            <Box sx={{ display: 'flex', gap: 2 }}>
              <FormControlLabel sx={{ m: 0 }} control={<Checkbox size="small" checked={includeBbox} onChange={(e) => handleBboxChange(e.target.checked)} />} label={<Typography sx={{ fontSize: 12 }}>BBox</Typography>} />
              <FormControlLabel sx={{ m: 0 }} control={<Checkbox size="small" checked={includeMask} onChange={(e) => handleMaskChange(e.target.checked)} />} label={<Typography sx={{ fontSize: 12 }}>Mask</Typography>} />
            </Box>
          </Box>
        </Box>

        <Box>
          <Typography component="label" sx={labelSx}>{t('export_sources')}</Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            {SOURCES.map((src) => {
              const count = Number(bySource[src] || 0);
              const blank = Number(noPolygon[src] || 0);
              const suffix = blank
                ? `(${count}, ${t('export_no_polygon_hint', { count: blank })})`
                : `(${count})`;
              return (
                <FormControlLabel
                  key={src}
                  sx={{ m: 0 }}
                  control={
                    <Checkbox
                      size="small"
                      checked={Boolean(sources[src])}
                      onChange={(e) => setSources((prev) => ({ ...prev, [src]: e.target.checked }))}
                    />
                  }
                  label={
                    <Typography sx={{ fontSize: 12 }}>
                      {src === 'locate-anything' ? t('source_la') : src === 'manual' ? t('source_manual') : src}{' '}
                      <Typography component="span" sx={{ color: 'text.secondary' }}>{suffix}</Typography>
                    </Typography>
                  }
                />
              );
            })}
          </Box>
        </Box>

        <Box>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.75 }}>
            <Typography sx={{ fontSize: 11, fontWeight: 700 }}>{t('export_classes')}</Typography>
            <Box sx={{ display: 'flex', gap: 0.75 }}>
              <Button size="small" variant="outlined" onClick={toggleAllClasses} sx={{ height: 22, fontSize: 10 }}>{t('export_select_all')}</Button>
              <Button size="small" variant="outlined" onClick={invertClasses} sx={{ height: 22, fontSize: 10 }}>{t('export_invert')}</Button>
            </Box>
          </Box>
          <Box sx={{ maxHeight: 150, overflowY: 'auto', p: 1.25, borderRadius: 1.5, bgcolor: 'action.hover', display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            {classList.length === 0 ? (
              <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{t('no_annotations_visible')}</Typography>
            ) : (
              classList.map((cls) => (
                <FormControlLabel
                  key={cls}
                  sx={{ m: 0 }}
                  control={
                    <Checkbox
                      size="small"
                      checked={Boolean(selectedClasses[cls])}
                      onChange={(e) => setSelectedClasses((prev) => ({ ...prev, [cls]: e.target.checked }))}
                    />
                  }
                  label={
                    <Typography sx={{ fontSize: 12 }}>
                      {cls}{' '}
                      <Typography component="span" sx={{ color: 'text.secondary' }}>
                        ({Number(byClass[cls] || 0)})
                      </Typography>
                    </Typography>
                  }
                />
              ))
            )}
          </Box>
        </Box>

        {format === 'yolo' && (
          <Box>
            <Typography component="label" sx={labelSx}>YOLO</Typography>
            <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
              <Typography sx={{ fontSize: 12 }}>{t('export_val_ratio')}</Typography>
              <TextField
                size="small"
                type="number"
                value={valRatio}
                inputProps={{ min: 0, max: 0.9, step: 0.05 }}
                onChange={(e) => setValRatio(Number(e.target.value) || 0)}
                sx={{ width: 90 }}
              />
              <FormControlLabel
                sx={{ m: 0 }}
                control={<Checkbox size="small" checked={writeDataYaml} onChange={(e) => setWriteDataYaml(e.target.checked)} />}
                label={<Typography sx={{ fontSize: 12 }}>{t('export_write_data_yaml')}</Typography>}
              />
            </Box>
          </Box>
        )}

        <Box>
          <Typography component="label" sx={labelSx}>{t('export_dir')}</Typography>
          <TextField
            size="small"
            fullWidth
            value={outputDir}
            onChange={(e) => setOutputDir(e.target.value)}
            placeholder={t('export_dir_placeholder')}
          />
          <Typography sx={{ mt: 0.75, fontSize: 11, color: 'text.secondary' }}>
            {format === 'yolo' ? t('export_yolo_hint') : t('export_coco_hint')}
          </Typography>
        </Box>

        <Box sx={{ p: 1.5, borderRadius: 1.5, bgcolor: 'action.hover' }}>
          <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{status}</Typography>
          {stats && <Typography sx={{ mt: 0.75, fontSize: 11, color: 'text.secondary' }}>{stats}</Typography>}
        </Box>

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
          <Button size="small" onClick={onClose}>{t('cancel')}</Button>
          <Button
            size="small"
            variant="contained"
            disabled={exporting}
            onClick={() => void handleExport()}
            sx={{ fontWeight: 700 }}
          >
            {t('export_confirm')}
          </Button>
        </Box>
      </Box>
    </Dialog>
  );
}
