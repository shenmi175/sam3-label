import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Alert, Box, Button, Checkbox, Chip, FormControl, InputLabel, LinearProgress,
  ListItemText, MenuItem, Paper, Select, Tab, Tabs, Typography,
  type SelectChangeEvent,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useTheme } from '@mui/material/styles';
import type { EChartsCoreOption } from 'echarts/core';
import { getProject, type ProjectInfo } from '../../api/projects';
import type { AnalyticsDistribution, AnalyticsHeatmap, AnalyticsSource, AnalyticsTask } from '../../api/analytics';
import { AnalyticsChart } from './AnalyticsChart';
import { useAnalyticsDashboard } from './useAnalyticsDashboard';

const TASKS: AnalyticsTask[] = ['detection', 'instance_segmentation'];
const KNOWN_SOURCES: AnalyticsSource[] = ['sam3', 'locate-anything', 'unknown'];
const SOURCE_COLORS: Record<string, string> = {
  sam3: '#1976d2', 'locate-anything': '#ed6c02', unknown: '#78909c',
};
const validSource = (value: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 64;
const sourceColor = (source: AnalyticsSource) => {
  if (SOURCE_COLORS[source]) return SOURCE_COLORS[source];
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) hash = ((hash * 31) + source.charCodeAt(index)) >>> 0;
  return `hsl(${hash % 360} 62% 46%)`;
};
const fmt = (value: unknown) => Number(value || 0).toLocaleString();

function SummaryCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }}>
      <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{label}</Typography>
      <Typography sx={{ fontSize: 25, fontWeight: 900, mt: 0.4, color, fontVariantNumeric: 'tabular-nums' }}>
        {fmt(value)}
      </Typography>
    </Paper>
  );
}

export function DataAnalyticsPage() {
  const { id = '' } = useParams();
  const projectId = id;
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useTranslation();
  const theme = useTheme();
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [projectError, setProjectError] = useState('');
  const rawTask = searchParams.get('task');
  const task: AnalyticsTask = TASKS.includes(rawTask as AnalyticsTask) ? rawTask as AnalyticsTask : 'detection';
  const parsedSources = searchParams.getAll('source').filter((source) => source !== 'manual' && validSource(source));
  const sources = parsedSources.length ? Array.from(new Set(parsedSources)) : ['sam3'] as AnalyticsSource[];
  const { index, dimensions, overview, loading, error, reload, startRebuild } = useAnalyticsDashboard(projectId, task, sources);
  const [heatmapSource, setHeatmapSource] = useState<AnalyticsSource>(sources[0]);

  const setFilters = (nextTask: AnalyticsTask, nextSources: AnalyticsSource[]) => {
    const next = new URLSearchParams();
    next.set('task', nextTask);
    nextSources.forEach((source) => next.append('source', source));
    setSearchParams(next, { replace: true });
  };

  useEffect(() => {
    if (rawTask !== task || parsedSources.length !== sources.length || searchParams.getAll('source').length === 0) {
      setFilters(task, sources);
    }
  }, []); // canonicalize invalid/missing URL state on entry

  useEffect(() => {
    if (!sources.includes(heatmapSource)) setHeatmapSource(sources[0]);
  }, [sources.join(','), heatmapSource]);

  useEffect(() => {
    const taskDimension = dimensions?.tasks.find((item) => item.task === task);
    if (!taskDimension || sources.length !== 1 || sources[0] !== 'sam3') return;
    const sam3 = taskDimension.sources.find((item) => item.source === 'sam3');
    if ((sam3?.instance_count || 0) > 0) return;
    const first = taskDimension.sources.find((item) => item.instance_count > 0);
    if (first) setFilters(task, [first.source]);
  }, [dimensions, task, sources.join(',')]);

  useEffect(() => {
    let active = true;
    getProject(projectId).then((response) => {
      if (active) setProject(response.project || null);
    }).catch((err) => {
      if (active) setProjectError(err instanceof Error ? err.message : String(err));
    });
    return () => { active = false; };
  }, [projectId]);

  const back = () => {
    const state = location.state as { from?: string } | null;
    const from = String(state?.from || '');
    const safePrefix = `/project/image/${encodeURIComponent(projectId)}`;
    navigate(from.startsWith(safePrefix) ? from : `${safePrefix}/auto`);
  };

  const knownSourceNames = new Set(KNOWN_SOURCES);
  const sourceName = (source: AnalyticsSource) => {
    if (knownSourceNames.has(source)) return t(`analytics_source_${source.replace('-', '_')}`);
    return dimensions?.sources.find((item) => item.source === source)?.display_name || source;
  };
  const taskName = (value: AnalyticsTask) => t(`analytics_task_${value}`);
  const taskDimension = dimensions?.tasks.find((item) => item.task === task);
  const sourceCounts = new Map((taskDimension?.sources || []).map((item) => [item.source, item.instance_count]));
  const availableSources = Array.from(new Set([
    ...(taskDimension?.sources || []).map((item) => item.source),
    ...sources,
  ])).filter((source) => source !== 'manual');
  const handleSources = (event: SelectChangeEvent<AnalyticsSource[]>) => {
    const value = event.target.value;
    const next = (typeof value === 'string' ? value.split(',') : value) as AnalyticsSource[];
    if (next.length) setFilters(task, availableSources.filter((source) => next.includes(source)));
  };
  const reset = () => {
    const detectionDimension = dimensions?.tasks.find((item) => item.task === 'detection');
    const sam3Count = detectionDimension?.sources.find((item) => item.source === 'sam3')?.instance_count || 0;
    const fallback = detectionDimension?.sources.find((item) => item.instance_count > 0)?.source || 'sam3';
    setFilters('detection', [sam3Count > 0 ? 'sam3' : fallback]);
  };

  const axisColor = theme.palette.text.secondary;
  const splitColor = theme.palette.divider;
  const commonAxis = { axisLabel: { color: axisColor }, axisLine: { lineStyle: { color: splitColor } }, splitLine: { lineStyle: { color: splitColor } } };
  const charts = useMemo(() => {
    if (!overview) return null;
    const groupedBar = (distribution: AnalyticsDistribution | null, horizontal = false): EChartsCoreOption => {
      if (!distribution) return {};
      const categories = horizontal ? distribution.categories.slice().reverse() : distribution.categories;
      return {
        tooltip: { trigger: 'axis' },
        legend: { top: 0, textStyle: { color: axisColor } },
        grid: { left: horizontal ? 125 : 56, right: 24, top: 48, bottom: horizontal ? 30 : 62 },
        xAxis: horizontal ? { type: 'value', ...commonAxis } : { type: 'category', data: categories, axisLabel: { color: axisColor, rotate: categories.length > 7 ? 28 : 0 }, axisLine: commonAxis.axisLine },
        yAxis: horizontal ? { type: 'category', data: categories, ...commonAxis } : { type: 'value', ...commonAxis },
        series: distribution.series.map((item) => ({
          name: sourceName(item.source), type: 'bar',
          data: horizontal ? item.values.slice().reverse() : item.values,
          itemStyle: { color: sourceColor(item.source) },
        })),
      };
    };
    const heatmap = (data: AnalyticsHeatmap, source: AnalyticsSource, resolution = false): EChartsCoreOption => {
      const selected = data.series.find((item) => item.source === source)?.cells || [];
      const xLabels = resolution ? data.x_edges.slice(0, -1).map(String) : data.x_edges.slice(0, -1).map((value) => value.toFixed(2));
      const yLabels = resolution ? data.y_edges.slice(0, -1).map(String) : data.y_edges.slice(0, -1).map((value) => value.toFixed(2));
      return {
        tooltip: { formatter: (params: any) => {
          const [x, y, count] = params.value as number[];
          if (resolution) return `${data.x_edges[x]}–${data.x_edges[x + 1]} px × ${data.y_edges[y]}–${data.y_edges[y + 1]} px<br/>${fmt(count)} ${t('dashboard_images_unit')}`;
          return `x ${data.x_edges[x].toFixed(2)}–${data.x_edges[x + 1].toFixed(2)}, y ${data.y_edges[y].toFixed(2)}–${data.y_edges[y + 1].toFixed(2)}<br/>${fmt(count)}`;
        } },
        grid: { left: 66, right: 72, top: 22, bottom: 54 },
        xAxis: { type: 'category', name: resolution ? t('analytics_width') : 'x', data: xLabels, ...commonAxis },
        yAxis: { type: 'category', name: resolution ? t('analytics_height') : 'y', data: yLabels, ...commonAxis },
        visualMap: { min: 0, max: Math.max(1, ...selected.map((cell) => cell.count)), right: 0, top: 'middle', calculable: true, textStyle: { color: axisColor } },
        dataZoom: resolution ? [{ type: 'inside', xAxisIndex: 0 }, { type: 'inside', yAxisIndex: 0 }] : [],
        series: [{ name: sourceName(source), type: 'heatmap', data: selected.map((cell) => [cell.x, cell.y, cell.count]) }],
      };
    };
    return {
      classDistribution: groupedBar(overview.class_distribution, true),
      density: groupedBar(overview.density_distribution),
      area: groupedBar(overview.area_distribution),
      aspect: groupedBar(overview.aspect_ratio_distribution),
      geometry: groupedBar(overview.geometry_distribution_by_source),
      center: overview.center_heatmap ? heatmap(overview.center_heatmap, heatmapSource) : {},
      resolution: heatmap(overview.resolution_distribution, heatmapSource, true),
    };
  }, [overview, heatmapSource, axisColor, splitColor, t]);

  const building = index?.status === 'building';
  const progress = Number(index?.job?.progress_pct || 0);
  const heatmapPicker = (
    <Select size="small" value={heatmapSource} onChange={(event) => setHeatmapSource(event.target.value as AnalyticsSource)} sx={{ minWidth: 135, fontSize: 12 }}>
      {sources.map((source) => <MenuItem key={source} value={source}>{sourceName(source)}</MenuItem>)}
    </Select>
  );
  const noData = Boolean(overview && overview.scope.instance_count === 0);

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <Paper square elevation={0} sx={{ px: { xs: 2, md: 3 }, py: 1.5, borderBottom: 1, borderColor: 'divider', display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button startIcon={<ArrowBackIcon />} variant="outlined" onClick={back}>{t('analytics_back_workspace')}</Button>
        <Box sx={{ flex: 1, minWidth: 180 }}>
          <Typography component="h1" sx={{ fontSize: 22, fontWeight: 900 }}>{t('data_dashboard')}</Typography>
          <Typography sx={{ color: 'text.secondary', fontSize: 12 }}>{project?.name || projectId}</Typography>
        </Box>
        <Chip size="small" color={index?.status === 'ready' ? 'success' : building ? 'warning' : 'default'} label={t(`analytics_status_${index?.status || 'loading'}`)} />
        <Button startIcon={<RefreshIcon />} onClick={() => void reload()}>{t('refresh')}</Button>
        <Button variant="contained" disabled={building} onClick={() => void startRebuild()}>{t('analytics_rebuild')}</Button>
      </Paper>
      {building && <LinearProgress variant={progress > 0 ? 'determinate' : 'indeterminate'} value={progress} />}
      <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1680, mx: 'auto' }}>
        {(error || projectError) && <Alert severity="error" sx={{ mb: 2 }}>{error || projectError}</Alert>}
        {index?.status === 'failed' && <Alert severity="error" action={<Button onClick={() => void startRebuild()}>{t('retry')}</Button>} sx={{ mb: 2 }}>{index.last_error || t('analytics_index_failed')}</Alert>}
        {building && <Alert severity="info" sx={{ mb: 2 }}>{index?.job?.message || t('analytics_index_building')} {progress > 0 ? `(${progress.toFixed(1)}%)` : ''}</Alert>}

        <Paper variant="outlined" sx={{ mb: 2.5 }}>
          <Tabs value={task} onChange={(_event, value: AnalyticsTask) => setFilters(value, sources)}>
            {TASKS.map((value) => {
              const count = dimensions?.tasks.find((item) => item.task === value)?.instance_count || 0;
              return <Tab key={value} value={value} label={`${taskName(value)} (${fmt(count)})`} />;
            })}
          </Tabs>
          <Box sx={{ p: 2, display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', borderTop: 1, borderColor: 'divider' }}>
            <FormControl size="small" sx={{ minWidth: 240 }}>
              <InputLabel>{t('analytics_sources')}</InputLabel>
              <Select multiple value={sources} label={t('analytics_sources')} onChange={handleSources} renderValue={(selected) => selected.map(sourceName).join(', ')}>
                {availableSources.map((source) => <MenuItem key={source} value={source}>
                  <Checkbox checked={sources.includes(source)} />
                  <ListItemText primary={`${sourceName(source)} (${fmt(sourceCounts.get(source) || 0)})`} />
                </MenuItem>)}
              </Select>
            </FormControl>
            <Typography sx={{ color: 'text.secondary', fontSize: 13, flex: 1 }}>
              {taskName(task)} · {sources.map(sourceName).join(' + ')} · {fmt(overview?.scope.instance_count || 0)} {t('analytics_instances')}
            </Typography>
            <Button onClick={reset}>{t('analytics_restore_default')}</Button>
          </Box>
        </Paper>

        {noData && <Alert severity="info" sx={{ mb: 2 }}>{t('analytics_empty_scope')}</Alert>}
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(5, 1fr)' }, gap: 1.5, mb: 2.5 }}>
          <SummaryCard label={t('analytics_total_images')} value={overview?.scope.project_total_images || index?.total_images || 0} />
          <SummaryCard label={t('analytics_hit_images')} value={overview?.scope.hit_images || 0} color={theme.palette.success.main} />
          <SummaryCard label={t('analytics_instances')} value={overview?.scope.instance_count || 0} />
          <SummaryCard label={t('analytics_classes')} value={overview?.scope.class_count || 0} />
          <SummaryCard label={t('analytics_anomalies')} value={overview?.scope.anomaly_count || 0} color={theme.palette.error.main} />
        </Box>

        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, minmax(0, 1fr))' }, gap: 2 }}>
          <AnalyticsChart title={t('analytics_class_distribution')} subtitle={overview?.class_distribution_truncated ? t('analytics_class_truncated', { count: overview.class_distribution_truncated }) : undefined} option={charts?.classDistribution || {}} loading={loading || building} empty={!overview?.class_distribution.categories.length} height={Math.max(330, Math.min(780, (overview?.class_distribution.categories.length || 0) * 25 + 100))} />
          <AnalyticsChart title={task === 'detection' ? t('analytics_detection_density') : t('analytics_instance_density')} option={charts?.density || {}} loading={loading || building} empty={noData} />
          <AnalyticsChart title={task === 'detection' ? t('analytics_bbox_area_distribution') : t('analytics_instance_area_distribution')} subtitle={overview ? t('analytics_area_missing', { count: Object.values(overview.area_distribution.missing_by_source).reduce((sum, value) => sum + Number(value || 0), 0) }) : undefined} option={charts?.area || {}} loading={loading || building} empty={noData} />
          {task === 'detection' ? (
            <>
              <AnalyticsChart title={t('analytics_aspect_ratio')} option={charts?.aspect || {}} loading={loading || building} empty={noData} />
              <AnalyticsChart title={t('analytics_bbox_center_heatmap')} option={charts?.center || {}} headerAction={heatmapPicker} loading={loading || building} empty={noData} />
            </>
          ) : (
            <AnalyticsChart title={t('analytics_geometry_distribution')} option={charts?.geometry || {}} loading={loading || building} empty={noData} />
          )}
          <AnalyticsChart title={t('analytics_resolution_distribution')} option={charts?.resolution || {}} headerAction={heatmapPicker} loading={loading || building} empty={!overview?.resolution_distribution.x_edges.length} />
        </Box>
      </Box>
    </Box>
  );
}
