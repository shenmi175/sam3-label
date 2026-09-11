import { useMemo, type ReactNode } from 'react';
import { Box, Paper, Skeleton, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { BarChart, HeatmapChart, PieChart } from 'echarts/charts';
import {
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';

echarts.use([
  BarChart,
  HeatmapChart,
  PieChart,
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

interface AnalyticsChartProps {
  title: string;
  subtitle?: string;
  option: EChartsCoreOption;
  empty?: boolean;
  loading?: boolean;
  height?: number;
  headerAction?: ReactNode;
}

export function AnalyticsChart({ title, subtitle, option, empty, loading, height = 330, headerAction }: AnalyticsChartProps) {
  const theme = useTheme();
  const themedOption = useMemo<EChartsCoreOption>(() => ({
    animationDuration: 350,
    backgroundColor: 'transparent',
    textStyle: {
      color: theme.palette.text.primary,
      fontFamily: theme.typography.fontFamily,
    },
    aria: { enabled: true, decal: { show: true } },
    ...option,
  }), [option, theme]);

  return (
    <Paper variant="outlined" sx={{ p: 2.25, minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <Typography sx={{ fontSize: 15, fontWeight: 800 }}>{title}</Typography>
        {headerAction}
      </Box>
      {subtitle && <Typography sx={{ color: 'text.secondary', fontSize: 11, mt: 0.35 }}>{subtitle}</Typography>}
      {loading ? (
        <Skeleton variant="rounded" height={height} sx={{ mt: 1.5 }} />
      ) : empty ? (
        <Box sx={{ height, display: 'grid', placeItems: 'center', color: 'text.secondary' }}>--</Box>
      ) : (
        <ReactEChartsCore
          echarts={echarts}
          option={themedOption}
          notMerge
          lazyUpdate
          style={{ height, width: '100%' }}
        />
      )}
    </Paper>
  );
}
