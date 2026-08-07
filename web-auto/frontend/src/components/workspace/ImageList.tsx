import { useEffect, useRef, useState } from 'react';
import { Box, Button, IconButton, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../stores/workspace/projectStore';
import { useImageStore } from '../../stores/workspace/imageStore';
import { getImageThumbnailUrl } from '../../api/images';

interface ImageListProps {
  onDeleteImage: (imageId: string) => void;
  onPageChange: (page: number) => void;
}

/** Per-row thumbnail with a graceful placeholder when the image 404s. */
function ImageThumb({ projectId, imageId }: { projectId: string; imageId: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !projectId || !imageId) {
    return (
      <Box
        component="span"
        sx={{
          width: 36,
          height: 36,
          borderRadius: 1.5,
          bgcolor: 'action.disabledBackground',
          flexShrink: 0,
        }}
      />
    );
  }
  return (
    <Box
      component="img"
      src={getImageThumbnailUrl(projectId, imageId)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      sx={{
        width: 36,
        height: 36,
        borderRadius: 1.5,
        objectFit: 'cover',
        flexShrink: 0,
        bgcolor: 'action.disabledBackground',
      }}
    />
  );
}

/**
 * Image list with thumbnails, labeled-state dots and pagination — 1:1 port of
 * the legacy image-list.js rows + prev/page-jump/next footer.
 */
export function ImageList({ onDeleteImage, onPageChange }: ImageListProps) {
  const { t } = useTranslation();
  const projectId = useProjectStore((s) => s.projectId);
  const images = useProjectStore((s) => s.images);
  const totalImages = useProjectStore((s) => s.totalImages);
  const offset = useProjectStore((s) => s.offset);
  const limit = useProjectStore((s) => s.limit);
  const selectedImageId = useImageStore((s) => s.selectedImageId);
  const isLoading = useImageStore((s) => s.isLoading);

  const totalPages = Math.max(1, Math.ceil(totalImages / limit));
  const currentPage = Math.min(totalPages, Math.floor(offset / limit) + 1);
  const [jumpValue, setJumpValue] = useState(String(currentPage));
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setJumpValue(String(currentPage));
  }, [currentPage]);

  // Keep the selected row in view when the selection changes.
  useEffect(() => {
    if (!selectedImageId) return;
    const timer = setTimeout(() => {
      listRef.current
        ?.querySelector(`[data-image-item="${selectedImageId}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    }, 50);
    return () => clearTimeout(timer);
  }, [selectedImageId, images]);

  const goToPage = (page: number) => {
    const target = Math.min(Math.max(1, page), totalPages);
    onPageChange(target);
  };

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Status-dot legend */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 2, pb: 0.75, fontSize: 10, color: 'text.secondary' }}>
        <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Box component="span" sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: '#10b981' }} />
          {t('labeled')}
        </Box>
        <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Box component="span" sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'action.disabled' }} />
          {t('unlabeled')}
        </Box>
      </Box>

      <Box ref={listRef} sx={{ flex: 1, overflowY: 'auto', px: 1.5, py: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
        {images.length === 0 ? (
          <Box sx={{ textAlign: 'center', py: 5 }}>
            <Typography sx={{ color: 'text.secondary', fontSize: 13 }}>
              {isLoading ? t('loading_images') : t('no_images')}
            </Typography>
            {!isLoading && (
              <Typography sx={{ color: 'text.disabled', fontSize: 11, mt: 0.75 }}>
                {t('no_images_hint')}
              </Typography>
            )}
          </Box>
        ) : (
          images.map((img) => {
            const selected = String(selectedImageId || '') === String(img.id || '');
            const labeled = img.status === 'labeled' || Boolean(img.labeled);
            return (
              <Box
                key={String(img.id)}
                data-image-item={String(img.id)}
                tabIndex={0}
                role="button"
                onClick={() => void useImageStore.getState().selectImage(String(img.id))}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  px: 1.25,
                  py: 1,
                  borderRadius: '12px',
                  cursor: 'pointer',
                  bgcolor: selected ? 'action.selected' : 'transparent',
                  border: '1px solid',
                  borderColor: selected ? 'primary.main' : 'transparent',
                  fontWeight: selected ? 700 : 500,
                  fontSize: 13,
                  '&:hover': { bgcolor: selected ? 'action.selected' : 'action.hover' },
                }}
              >
                <ImageThumb projectId={projectId} imageId={String(img.id)} />
                <Box
                  component="span"
                  sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: labeled ? '#10b981' : 'action.disabled', flexShrink: 0 }}
                />
                <Typography
                  component="span"
                  sx={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 13 }}
                >
                  {String(img.rel_path || img.id)}
                </Typography>
                <IconButton
                  size="small"
                  aria-label={t('delete_image_title')}
                  title={t('delete_image_title')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteImage(String(img.id));
                  }}
                  sx={{ width: 24, height: 24, color: '#ef4444', fontSize: 15, fontWeight: 800, flexShrink: 0 }}
                >
                  ×
                </IconButton>
              </Box>
            );
          })
        )}
      </Box>

      <Box sx={{ p: 1.5, display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid', borderColor: 'divider' }}>
        <Button
          variant="outlined"
          size="small"
          sx={{ minWidth: 40, width: 40, height: 40, borderRadius: '50%', fontSize: 18 }}
          disabled={currentPage <= 1}
          onClick={() => goToPage(currentPage - 1)}
        >
          ‹
        </Button>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, fontSize: 12, fontWeight: 700 }}>
          <TextField
            value={jumpValue}
            onChange={(e) => setJumpValue(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const page = Number.parseInt(jumpValue, 10);
                if (Number.isFinite(page)) goToPage(page);
              }
            }}
            inputProps={{
              'inputMode': 'numeric',
              'aria-label': t('page_jump_label'),
              'title': t('page_jump_title', { current: currentPage, total: totalPages }),
              style: { width: 42, textAlign: 'center', padding: '6px 4px', fontSize: 12, fontWeight: 800 },
            }}
            variant="outlined"
            size="small"
          />
          <Typography component="span" sx={{ color: 'text.secondary' }}>/</Typography>
          <Typography component="span" sx={{ minWidth: 22 }}>{totalPages}</Typography>
        </Box>
        <Button
          variant="outlined"
          size="small"
          sx={{ minWidth: 40, width: 40, height: 40, borderRadius: '50%', fontSize: 18 }}
          disabled={currentPage >= totalPages}
          onClick={() => goToPage(currentPage + 1)}
        >
          ›
        </Button>
      </Box>
    </Box>
  );
}
