import { Box, Tooltip, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useGpuStatus, formatGpuMemory } from '../../hooks/useGpuStatus';

/**
 * GPU utilization/memory widget for the workspace top bar — 1:1 port of the
 * legacy GpuStatusController rendering: dot color (stale amber / mem ≥90 red /
 * ≥75 amber / else green), util + memory bars, per-GPU tooltip lines.
 */
export function GpuStatusWidget({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const gpu = useGpuStatus(active);

  const dotColor = !gpu.available
    ? '#94a3b8'
    : gpu.stale
      ? '#f59e0b'
      : gpu.memoryPct >= 90
        ? '#ef4444'
        : gpu.memoryPct >= 75
          ? '#f59e0b'
          : '#10b981';

  const tooltipLines: string[] = [];
  if (gpu.stale) {
    tooltipLines.push(t('gpu_stale_detail', { age: Math.round(gpu.ageSeconds) }));
  }
  if (!gpu.available) {
    tooltipLines.push(gpu.statusMessage || t('gpu_unavailable'));
  } else {
    for (const item of gpu.gpus) {
      tooltipLines.push(`GPU${item.index} ${item.name}: ${item.utilizationText}, ${item.memoryText}`);
    }
  }

  return (
    <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{tooltipLines.join('\n')}</span>}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          height: 36,
          px: 1.5,
          borderRadius: '10px',
          border: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.paper',
          minWidth: 300,
        }}
      >
        <Box component="span" sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: dotColor, flexShrink: 0 }} />
        <Typography sx={{ fontSize: 10, fontWeight: 800, color: 'text.secondary', width: 28 }}>GPU</Typography>
        <Box sx={{ height: 6, flex: 1, minWidth: 48, bgcolor: 'rgba(0,0,0,0.08)', borderRadius: 999, overflow: 'hidden' }}>
          <Box
            sx={{
              width: gpu.gpuUtilization === null ? '0%' : `${gpu.gpuUtilization.toFixed(0)}%`,
              height: '100%',
              bgcolor: '#10b981',
              transition: 'width 0.3s ease',
            }}
          />
        </Box>
        <Typography sx={{ width: 34, textAlign: 'right', fontSize: 10, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
          {gpu.gpuUtilization === null ? '--' : `${gpu.gpuUtilization.toFixed(0)}%`}
        </Typography>
        <Typography sx={{ fontSize: 10, fontWeight: 800, color: 'text.secondary', width: 32 }}>{t('gpu_memory')}</Typography>
        <Box sx={{ height: 6, flex: 1, minWidth: 48, bgcolor: 'rgba(0,0,0,0.08)', borderRadius: 999, overflow: 'hidden' }}>
          <Box sx={{ width: `${gpu.memoryPct.toFixed(0)}%`, height: '100%', bgcolor: '#3b82f6', transition: 'width 0.3s ease' }} />
        </Box>
        <Typography sx={{ width: 78, textAlign: 'right', fontSize: 10, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
          {gpu.available ? `${formatGpuMemory(gpu.memoryUsedMb)}/${formatGpuMemory(gpu.memoryTotalMb)}` : '--'}
        </Typography>
      </Box>
    </Tooltip>
  );
}
