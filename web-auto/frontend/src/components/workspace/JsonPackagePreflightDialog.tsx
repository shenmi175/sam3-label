import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import type { ExportIssue, ExportPreflight, ExportProfile } from '../../api/exports';


interface ExportPreflightDialogProps {
  report: ExportPreflight | null;
  exporting: boolean;
  confirmedCodes: string[];
  onConfirmedCodesChange: (codes: string[]) => void;
  onCancel: () => void;
  onConfirm: () => void;
  onOpenDataCleaning: () => void;
}

function IssueList({ issues, profile }: { issues: ExportIssue[]; profile: ExportProfile }) {
  const { t } = useTranslation();
  const sourceLabel = (source: string) => {
    if (source === 'sam3') return t('sam3_backend');
    if (source === 'locate-anything') return t('source_la');
    return source;
  };
  return (
    <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
      {issues.map((issue) => {
        const rawBySource = issue.code === 'SEGMENTATION_REQUIRES_POLYGON'
          ? issue.details?.by_source
          : undefined;
        const bySource = rawBySource && typeof rawBySource === 'object' && !Array.isArray(rawBySource)
          ? Object.entries(rawBySource).filter((entry): entry is [string, number] => (
            typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] > 0
          ))
          : [];
        if (bySource.length > 0) {
          const issueProfile = issue.details?.profile === 'coco_instance' || issue.details?.profile === 'yolo_instance'
            ? issue.details.profile
            : profile;
          const detectionProfile: ExportProfile = issueProfile === 'yolo_instance'
            ? 'yolo_detection'
            : 'coco_detection';
          return (
            <Box component="li" key={issue.code} sx={{ fontSize: 12 }}>
              {bySource.map(([source, count]) => (
                <Typography key={source} sx={{ fontSize: 12 }}>
                  {t('export_issue_segmentation_source', {
                    source: sourceLabel(source),
                    count,
                    profile: t(`export_profile_${issueProfile}`),
                    detectionProfile: t(`export_profile_${detectionProfile}`),
                  })}
                </Typography>
              ))}
            </Box>
          );
        }
        return (
          <Typography component="li" key={issue.code} sx={{ fontSize: 12 }}>
            {t(`export_issue_${issue.code}`, { defaultValue: issue.message })} ({issue.count})
          </Typography>
        );
      })}
    </Box>
  );
}

export function ExportPreflightDialog({
  report,
  exporting,
  confirmedCodes,
  onConfirmedCodesChange,
  onCancel,
  onConfirm,
  onOpenDataCleaning,
}: ExportPreflightDialogProps) {
  const { t } = useTranslation();
  const stats = report?.stats;
  const required = report?.confirmation_required_codes || [];
  const allConfirmed = required.every((code) => confirmedCodes.includes(code));
  const bridge = report?.format_details?.multipart_bridge as Record<string, unknown> | undefined;
  const hasMultipartProblem = Boolean(
    report?.warnings.some((issue) => issue.code === 'YOLO_MULTIPART_BRIDGE')
    || report?.blockers.some((issue) => issue.code === 'YOLO_MULTIPART_REJECTED'),
  );

  return (
    <Dialog open={report !== null} onClose={exporting ? undefined : onCancel} maxWidth="sm" fullWidth>
      <DialogTitle>{t('export_preflight_title')}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {report && stats && (
          <>
            <Alert severity={report.blockers.length ? 'error' : report.warnings.length ? 'warning' : 'success'}>
              {t('export_preflight_summary', {
                annotations: Number(stats.annotations_selected || 0),
                instances: Number(stats.instances_written || 0),
                regions: Number(stats.regions_written || 0),
                images: Number(stats.images_written || 0),
                negative: Number(stats.negative_images || 0),
                records: Number(stats.output_records || 0),
              })}
            </Alert>
            <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
              {t('export_preflight_details', {
                multipart: Number(stats.multipart_instances || 0),
                regrouped: Number(stats.regrouped_instances || 0),
                components: Number(stats.regrouped_components || 0),
                bbox: Number(stats.bbox_only_instances || 0),
              })}
            </Typography>
            {bridge && (
              <Alert severity="warning">
                {t('export_bridge_metrics', {
                  instances: Number(bridge.affected_instances || 0),
                  connections: Number(bridge.connections || 0),
                  pixels: Number(bridge.added_pixels || 0),
                  iou: Number(bridge.iou || 0).toFixed(4),
                  area: (Number(bridge.area_change_ratio || 0) * 100).toFixed(2),
                })}
              </Alert>
            )}
            {report.blockers.length > 0 && (
              <Alert severity="error">
                <Typography sx={{ mb: 0.5, fontSize: 12, fontWeight: 700 }}>{t('export_preflight_blockers')}</Typography>
                <IssueList issues={report.blockers} profile={report.profile} />
              </Alert>
            )}
            {report.warnings.length > 0 && (
              <Alert severity="warning">
                <Typography sx={{ mb: 0.5, fontSize: 12, fontWeight: 700 }}>{t('export_preflight_warnings')}</Typography>
                <IssueList issues={report.warnings} profile={report.profile} />
              </Alert>
            )}
            {required.map((code) => (
              <FormControlLabel
                key={code}
                sx={{ m: 0 }}
                control={(
                  <Checkbox
                    checked={confirmedCodes.includes(code)}
                    onChange={(event) => onConfirmedCodesChange(
                      event.target.checked
                        ? [...new Set([...confirmedCodes, code])]
                        : confirmedCodes.filter((value) => value !== code),
                    )}
                  />
                )}
                label={<Typography sx={{ fontSize: 12 }}>{t(`export_confirm_${code}`)}</Typography>}
              />
            ))}
            {hasMultipartProblem && (
              <Button size="small" variant="outlined" onClick={onOpenDataCleaning} sx={{ alignSelf: 'flex-start' }}>
                {t('export_open_data_cleaning')}
              </Button>
            )}
            <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{t('export_annotation_only_hint')}</Typography>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={exporting}>{t('cancel')}</Button>
        <Button variant="contained" onClick={onConfirm} disabled={!report?.ok || !allConfirmed || exporting}>
          {exporting ? t('export_running_button') : t('export_preflight_confirm')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// Temporary source-level alias for imports in downstream customizations.
export const JsonPackagePreflightDialog = ExportPreflightDialog;
