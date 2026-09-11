import { useCallback, useEffect, useRef, useState } from 'react';
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
import {
  exportProject,
  preflightExport,
  previewExport,
  type ImageExportMode,
  type ExportOptions,
  type ExportPreflight,
  type ExportProfile,
  type YoloMultipartPolicy,
} from '../../api/exports';
import type { ApiError } from '../../api/client';
import { useProjectStore } from '../../stores/workspace/projectStore';
import { useSmartFilterStore } from '../../stores/workspace/smartFilterStore';
import { toast } from '../../utils/notify';
import { ExportPreflightDialog } from './JsonPackagePreflightDialog';
import { logFeatureEvent } from '../../api/audit';


interface ExportPanelProps {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onOpenDataCleaning?: () => void;
}

const SOURCES = ['sam3', 'locate-anything'] as const;
const PROFILES: ExportProfile[] = [
  'native_json_v2',
  'coco_detection',
  'coco_instance',
  'yolo_detection',
  'yolo_instance',
];

export function ExportPanel({ projectId, open, onClose, onOpenDataCleaning = () => undefined }: ExportPanelProps) {
  const { t } = useTranslation();
  const projectClasses = useProjectStore((state) => state.classes);
  const [profile, setProfile] = useState<ExportProfile>('coco_detection');
  const [sources, setSources] = useState<Record<string, boolean>>({ sam3: true, 'locate-anything': false });
  const [selectedClasses, setSelectedClasses] = useState<Record<string, boolean>>({});
  const [valRatioPercent, setValRatioPercent] = useState(0);
  const [multipartPolicy, setMultipartPolicy] = useState<YoloMultipartPolicy>('official_bridge');
  const [imageMode, setImageMode] = useState<ImageExportMode>('none');
  const [outputDir, setOutputDir] = useState('');
  const [status, setStatus] = useState(t('export_ready_hint'));
  const [stats, setStats] = useState('');
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewExport>> | null>(null);
  const [preflighting, setPreflighting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [report, setReport] = useState<ExportPreflight | null>(null);
  const [preflightOptions, setPreflightOptions] = useState<ExportOptions | null>(null);
  const [confirmedCodes, setConfirmedCodes] = useState<string[]>([]);
  const loggedOpenRef = useRef(false);

  useEffect(() => {
    if (!open) {
      loggedOpenRef.current = false;
      return;
    }
    if (!projectId) return;
    if (!loggedOpenRef.current) {
      logFeatureEvent('open_import_export', projectId, { feature: 'export' });
      loggedOpenRef.current = true;
    }
    let cancelled = false;
    setStatus(t('export_ready_hint'));
    setStats('');
    setReport(null);
    setPreflightOptions(null);
    setConfirmedCodes([]);
    void previewExport({ project_id: projectId })
      .then((data) => {
        if (cancelled) return;
        setPreview(data);
        const classes = data.classes?.length ? data.classes : projectClasses;
        setSelectedClasses(Object.fromEntries(classes.map((className) => [className, true])));
      })
      .catch(() => {
        if (!cancelled) setStatus(t('export_preview_failed'));
      });
    return () => { cancelled = true; };
  }, [open, projectId, projectClasses, t]);

  const classList = preview?.classes?.length ? preview.classes : projectClasses;
  const byClass = preview?.by_class || {};
  const bySource = preview?.by_source || {};
  const noPolygon = preview?.no_polygon_by_source || {};

  const toggleAllClasses = useCallback(() => {
    setSelectedClasses((previous) => {
      const allSelected = classList.length > 0 && classList.every((className) => previous[className]);
      return Object.fromEntries(classList.map((className) => [className, !allSelected]));
    });
  }, [classList]);

  const invertClasses = useCallback(() => {
    setSelectedClasses((previous) => Object.fromEntries(classList.map((className) => [className, !previous[className]])));
  }, [classList]);

  const options = useCallback((): ExportOptions | null => {
    const checkedSources = SOURCES.filter((source) => sources[source]);
    const checkedClasses = classList.filter((className) => selectedClasses[className]);
    if (!checkedSources.length || !checkedClasses.length) return null;
    return {
      project_id: projectId,
      profile,
      output_dir: outputDir.trim() || null,
      source_models: checkedSources,
      classes: checkedClasses,
      val_ratio: profile.startsWith('yolo_') ? valRatioPercent / 100 : 0,
      yolo_multipart_policy: multipartPolicy,
      image_mode: imageMode,
      confirmed_issue_codes: [],
    };
  }, [classList, imageMode, multipartPolicy, outputDir, profile, projectId, selectedClasses, sources, valRatioPercent]);

  const handlePreflight = async () => {
    const nextOptions = options();
    if (!nextOptions) {
      setStatus(t('export_select_source_class'));
      return;
    }
    try {
      setPreflighting(true);
      setStats('');
      setStatus(t('export_preflight_running'));
      const nextReport = await preflightExport(nextOptions);
      setPreflightOptions(nextOptions);
      setReport(nextReport);
      setConfirmedCodes([]);
      setStatus(nextReport.ok ? t('export_preflight_ready') : t('export_preflight_blocked'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
      toast(message, 'error');
    } finally {
      setPreflighting(false);
    }
  };

  const confirmExport = async () => {
    if (!report || !preflightOptions) return;
    try {
      setExporting(true);
      setStatus(t('export_running'));
      const response = await exportProject({
        ...preflightOptions,
        confirmed_issue_codes: confirmedCodes,
        expected_content_rev: report.project_content_rev,
      });
      const resultStats = response.stats || {};
      setStatus(t('export_done', { output: response.output || '' }));
      setStats(t('export_stats_profile', {
        instances: Number(resultStats.instances_written || 0),
        regions: Number(resultStats.regions_written || 0),
        images: Number(resultStats.images_written || 0),
        negative: Number(resultStats.negative_images || 0),
        records: Number(resultStats.output_records || 0),
      }));
      setReport(null);
      setPreflightOptions(null);
      toast(t('export_success'), 'success');
    } catch (error) {
      const detail = (error as ApiError)?.detail as { code?: string; preflight?: ExportPreflight } | undefined;
      if (detail?.code === 'EXPORT_STALE') {
        setStatus(t('export_stale'));
        try {
          const refreshed = await preflightExport(preflightOptions);
          setReport(refreshed);
          setConfirmedCodes([]);
        } catch {
          setReport(null);
          setPreflightOptions(null);
        }
      } else if (detail?.code === 'EXPORT_CONFIRMATION_REQUIRED' && detail.preflight) {
        setReport(detail.preflight);
        setConfirmedCodes([]);
        setStatus(t('export_confirmation_required'));
      } else {
        const message = error instanceof Error ? error.message : String(error);
        setStatus(message);
        toast(message, 'error');
      }
    } finally {
      setExporting(false);
    }
  };

  const openDataCleaning = () => {
    setReport(null);
    setPreflightOptions(null);
    setConfirmedCodes([]);
    useSmartFilterStore.getState().updateConfig({ operationMode: 'component_noise' });
    onClose();
    onOpenDataCleaning();
  };

  const labelSx = { fontSize: 11, fontWeight: 700, mb: 0.75, display: 'block' };
  const disabled = preflighting || exporting || !SOURCES.some((source) => sources[source]) || !classList.some((className) => selectedClasses[className]);

  return (
    <>
      <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
        <Box sx={{ p: 3, position: 'relative', maxHeight: '88vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <IconButton size="small" onClick={onClose} aria-label={t('close')} sx={{ position: 'absolute', top: 12, right: 12, color: '#ef4444' }}>
            {'\u00D7'}
          </IconButton>
          <Typography sx={{ fontSize: 18, fontWeight: 800 }}>{t('export')}</Typography>

          <Box>
            <Typography component="label" sx={labelSx}>{t('export_profile')}</Typography>
            <Select
              size="small"
              fullWidth
              value={profile}
              onChange={(event) => {
                setProfile(event.target.value as ExportProfile);
                setReport(null);
                setConfirmedCodes([]);
              }}
            >
              {PROFILES.map((value) => <MenuItem key={value} value={value}>{t(`export_profile_${value}`)}</MenuItem>)}
            </Select>
          </Box>

          <Box>
            <Typography component="label" sx={labelSx}>{t('export_sources')}</Typography>
            {SOURCES.map((source) => {
              const count = Number(bySource[source] || 0);
              const blank = Number(noPolygon[source] || 0);
              return (
                <FormControlLabel
                  key={source}
                  sx={{ m: 0, display: 'flex' }}
                  control={<Checkbox size="small" checked={Boolean(sources[source])} onChange={(event) => setSources((previous) => ({ ...previous, [source]: event.target.checked }))} />}
                  label={<Typography sx={{ fontSize: 12 }}>{source === 'locate-anything' ? t('source_la') : source} ({count}{blank ? `, ${t('export_no_polygon_hint', { count: blank })}` : ''})</Typography>}
                />
              );
            })}
          </Box>

          <Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.75 }}>
              <Typography sx={{ fontSize: 11, fontWeight: 700 }}>{t('export_classes')}</Typography>
              <Box sx={{ display: 'flex', gap: 0.75 }}>
                <Button size="small" variant="outlined" onClick={toggleAllClasses}>{t('export_select_all')}</Button>
                <Button size="small" variant="outlined" onClick={invertClasses}>{t('export_invert')}</Button>
              </Box>
            </Box>
            <Box sx={{ maxHeight: 150, overflowY: 'auto', p: 1.25, borderRadius: 1.5, bgcolor: 'action.hover' }}>
              {classList.map((className) => (
                <FormControlLabel
                  key={className}
                  sx={{ m: 0, display: 'flex' }}
                  control={<Checkbox size="small" checked={Boolean(selectedClasses[className])} onChange={(event) => setSelectedClasses((previous) => ({ ...previous, [className]: event.target.checked }))} />}
                  label={<Typography sx={{ fontSize: 12 }}>{className} ({Number(byClass[className] || 0)})</Typography>}
                />
              ))}
            </Box>
          </Box>

          {profile.startsWith('yolo_') && (
            <Box sx={{ display: 'flex', gap: 2 }}>
              <Box>
                <Typography component="label" sx={labelSx}>{t('export_val_ratio')}</Typography>
                <TextField
                  size="small"
                  type="number"
                  value={valRatioPercent}
                  inputProps={{ min: 0, max: 90, step: 5 }}
                  onChange={(event) => setValRatioPercent(Math.min(90, Math.max(0, Number(event.target.value) || 0)))}
                  sx={{ width: 100 }}
                />
              </Box>
              {profile === 'yolo_instance' && (
                <Box sx={{ flex: 1 }}>
                  <Typography component="label" sx={labelSx}>{t('export_yolo_multipart_policy')}</Typography>
                  <Select size="small" fullWidth value={multipartPolicy} onChange={(event) => setMultipartPolicy(event.target.value as YoloMultipartPolicy)}>
                    <MenuItem value="official_bridge">{t('export_yolo_policy_bridge')}</MenuItem>
                    <MenuItem value="reject">{t('export_yolo_policy_reject')}</MenuItem>
                  </Select>
                </Box>
              )}
            </Box>
          )}

          <Box>
            <Typography component="label" sx={labelSx}>{t('export_image_mode')}</Typography>
            <Select
              size="small"
              fullWidth
              value={imageMode}
              onChange={(event) => setImageMode(event.target.value as ImageExportMode)}
            >
              <MenuItem value="none">{t('export_image_mode_none')}</MenuItem>
              <MenuItem value="symlink">{t('export_image_mode_symlink')}</MenuItem>
              <MenuItem value="copy">{t('export_image_mode_copy')}</MenuItem>
            </Select>
            <Typography sx={{ mt: 0.75, fontSize: 11, color: 'text.secondary' }}>
              {t(`export_image_mode_${imageMode}_hint`)}
            </Typography>
          </Box>

          <Box>
            <Typography component="label" sx={labelSx}>{t('export_dir')}</Typography>
            <TextField size="small" fullWidth value={outputDir} onChange={(event) => setOutputDir(event.target.value)} placeholder={t('export_dir_placeholder')} />
            <Typography sx={{ mt: 0.75, fontSize: 11, color: 'text.secondary' }}>{t('export_annotation_only_hint')}</Typography>
          </Box>

          <Box sx={{ p: 1.5, borderRadius: 1.5, bgcolor: 'action.hover' }}>
            <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{status}</Typography>
            {stats && <Typography sx={{ mt: 0.75, fontSize: 11, color: 'text.secondary' }}>{stats}</Typography>}
          </Box>

          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
            <Button size="small" onClick={onClose}>{t('cancel')}</Button>
            <Button size="small" variant="contained" disabled={disabled} onClick={() => void handlePreflight()} sx={{ fontWeight: 700 }}>
              {preflighting ? t('export_preflight_running_button') : t('export_preflight_action')}
            </Button>
          </Box>
        </Box>
      </Dialog>
      <ExportPreflightDialog
        report={report}
        exporting={exporting}
        confirmedCodes={confirmedCodes}
        onConfirmedCodesChange={setConfirmedCodes}
        onCancel={() => setReport(null)}
        onConfirm={() => void confirmExport()}
        onOpenDataCleaning={openDataCleaning}
      />
    </>
  );
}
