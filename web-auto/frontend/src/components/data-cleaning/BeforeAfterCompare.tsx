import { useState } from 'react';
import CloseIcon from '@mui/icons-material/Close';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import { Box, Button, Dialog, DialogTitle, IconButton, Tooltip, Typography } from '@mui/material';
import { ReactCompareSlider, ReactCompareSliderImage } from 'react-compare-slider';
import { useTranslation } from 'react-i18next';

interface BeforeAfterCompareProps {
  beforeUrl: string;
  afterUrl: string;
  sampleName: string;
  diffUrl?: string;
  beforeDetailUrl?: string;
  afterDetailUrl?: string;
  diffDetailUrl?: string;
}

function ComparisonCanvas({
  beforeUrl,
  afterUrl,
  sampleName,
  expanded = false,
}: BeforeAfterCompareProps & { expanded?: boolean }) {
  const { t } = useTranslation();

  return (
    <Box
      sx={{
        position: 'relative',
        width: '100%',
        height: expanded ? 'calc(100vh - 72px)' : { xs: 320, md: 'clamp(360px, 46vh, 560px)' },
        overflow: 'hidden',
        borderRadius: expanded ? 0 : 1.5,
        bgcolor: '#111827',
      }}
    >
      <ReactCompareSlider
        aria-label={t('sf_compare_viewer')}
        keyboardIncrement="2%"
        itemOne={(
          <ReactCompareSliderImage
            src={beforeUrl}
            alt={`${sampleName} ${t('sf_preview_before')}`}
            style={{ objectFit: 'contain', background: '#111827' }}
          />
        )}
        itemTwo={(
          <ReactCompareSliderImage
            src={afterUrl}
            alt={`${sampleName} ${t('sf_preview_after')}`}
            style={{ objectFit: 'contain', background: '#111827' }}
          />
        )}
        style={{ width: '100%', height: '100%' }}
      />
      <Box
        sx={{
          position: 'absolute',
          inset: '12px 12px auto 12px',
          zIndex: 2,
          display: 'flex',
          justifyContent: 'space-between',
          pointerEvents: 'none',
        }}
      >
        {[t('sf_compare_before'), t('sf_compare_after')].map((label) => (
          <Typography
            key={label}
            sx={{
              px: 1.25,
              py: 0.5,
              borderRadius: 1,
              bgcolor: 'rgba(17,24,39,.78)',
              color: '#fff',
              fontSize: 12,
              fontWeight: 800,
              boxShadow: 2,
            }}
          >
            {label}
          </Typography>
        ))}
      </Box>
    </Box>
  );
}

export function BeforeAfterCompare(props: BeforeAfterCompareProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<'diff' | 'side' | 'slider'>(props.diffUrl ? 'diff' : 'slider');
  const [detail, setDetail] = useState(Boolean(props.diffDetailUrl));
  const [zoom, setZoom] = useState(1);
  const before = detail ? props.beforeDetailUrl || props.beforeUrl : props.beforeUrl;
  const after = detail ? props.afterDetailUrl || props.afterUrl : props.afterUrl;
  const diff = detail ? props.diffDetailUrl || props.diffUrl : props.diffUrl;
  const content = (large = false) => mode === 'slider'
    ? <ComparisonCanvas {...props} beforeUrl={before} afterUrl={after} expanded={large} />
    : <Box sx={{ overflow: 'auto', maxHeight: large ? '80vh' : 560, bgcolor: '#111827' }}>
      <Box sx={{ display: 'flex', width: `${zoom * 100}%`, minHeight: 320 }}>
        {(mode === 'diff' ? [diff] : [before, after]).map((src, index) => (
          <Box key={`${mode}-${index}`} sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ color: 'white', p: 1 }}>{mode === 'diff' ? t('sf_diff_legend') : t(index === 0 ? 'sf_compare_before' : 'sf_compare_after')}</Typography>
            <img src={src} alt={`${props.sampleName} ${mode === 'diff' ? t('sf_diff') : t(index === 0 ? 'sf_compare_before' : 'sf_compare_after')}`} style={{ width: '100%', imageRendering: zoom > 1 ? 'pixelated' : 'auto' }} />
          </Box>
        ))}
      </Box>
    </Box>;

  return (
    <>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 1 }}>
        {(['diff', 'side', 'slider'] as const).map((value) => <Button key={value} size="small" disabled={value === 'diff' && !props.diffUrl} variant={mode === value ? 'contained' : 'outlined'} onClick={() => setMode(value)}>{t(`sf_view_${value}`)}</Button>)}
        {props.diffDetailUrl && <Button size="small" onClick={() => setDetail(!detail)}>{t(detail ? 'sf_show_whole' : 'sf_show_detail')}</Button>}
        {mode !== 'slider' && <><Button onClick={() => setZoom(Math.max(1, zoom / 2))}>−</Button><Button onClick={() => setZoom(Math.min(8, zoom * 2))}>+</Button></>}
      </Box>
      <Box sx={{ position: 'relative' }}>
        {content()}
        <Tooltip title={t('sf_compare_expand')}>
          <IconButton
            aria-label={t('sf_compare_expand')}
            onClick={() => setExpanded(true)}
            sx={{
              position: 'absolute',
              zIndex: 3,
              right: 12,
              bottom: 12,
              bgcolor: 'rgba(17,24,39,.82)',
              color: '#fff',
              '&:hover': { bgcolor: 'rgba(17,24,39,.96)' },
            }}
          >
            <FullscreenIcon />
          </IconButton>
        </Tooltip>
      </Box>
      <Typography sx={{ mt: 0.75, fontSize: 11, color: 'text.secondary', textAlign: 'center' }}>
        {t(mode === 'slider' ? 'sf_compare_hint' : 'sf_diff_hint')}
      </Typography>

      <Dialog open={expanded} onClose={() => setExpanded(false)} fullScreen>
        <DialogTitle
          sx={{
            height: 72,
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 2,
            py: 1,
          }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography noWrap sx={{ fontSize: 15, fontWeight: 800 }}>{props.sampleName}</Typography>
            <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{t(mode === 'slider' ? 'sf_compare_hint' : 'sf_diff_hint')}</Typography>
          </Box>
          <IconButton aria-label={t('sf_compare_close')} onClick={() => setExpanded(false)}>
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        {content(true)}
      </Dialog>
    </>
  );
}
