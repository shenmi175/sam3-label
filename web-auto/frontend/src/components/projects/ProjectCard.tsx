import { useTranslation } from 'react-i18next';
import { Box, Button, LinearProgress, Paper, Typography } from '@mui/material';
import type { ProjectInfo } from '../../api/projects';
import { safeFormatDate } from './utils';

interface ProjectCardProps {
  project: ProjectInfo;
  onOpen: (id: string, projectType: string) => void;
  onAddData: (imageDir: string, projectId: string) => void;
  onDelete: (project: ProjectInfo) => void;
}

export function ProjectCard({ project, onOpen, onAddData, onDelete }: ProjectCardProps) {
  const { t } = useTranslation();

  const projectType = String(project.project_type || 'image');
  const typeLabel = projectType === 'pose' ? t('pose_project') : t('image_project');
  const total = Number(project.num_images || 0);
  const labeled = Number(project.labeled_images || 0);
  const progress = total > 0 ? Math.round((labeled / total) * 100) : 0;
  const sourcePath = String(project.image_dir || '');

  return (
    <Paper sx={{ p: 2.75, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2 }}>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', minWidth: 0 }}>
          <Box
            sx={{
              width: 48,
              height: 48,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 22,
              borderRadius: 2,
              bgcolor: 'action.hover',
              flex: '0 0 auto',
            }}
          >
            {projectType === 'pose' ? '⌁' : '▣'}
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="h6" sx={{ fontSize: 18, fontWeight: 700, overflowWrap: 'anywhere' }}>
              {project.name || ''}
            </Typography>
            <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.5, overflowWrap: 'anywhere' }}>
              ID: {project.id || ''}
            </Typography>
          </Box>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Button onClick={() => onOpen(project.id, projectType)} sx={{ fontWeight: 600 }}>
            {t('open_btn')}
          </Button>
          <Button onClick={() => onAddData(sourcePath, project.id)}>{t('add_data_btn')}</Button>
          <Button color="error" onClick={() => onDelete(project)}>
            {t('delete_btn')}
          </Button>
        </Box>
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
          gap: 1.75,
          p: 1.75,
          bgcolor: 'action.hover',
          borderRadius: 2,
          fontSize: 13,
        }}
      >
        <Box>
          <Typography sx={{ color: 'text.secondary', fontSize: 11, mb: 0.25 }}>{t('type')}</Typography>
          <Typography sx={{ fontWeight: 700 }}>{typeLabel.toUpperCase()}</Typography>
        </Box>
        <Box>
          <Typography sx={{ color: 'text.secondary', fontSize: 11, mb: 0.25 }}>{t('total')}</Typography>
          <Typography sx={{ fontWeight: 700 }}>{total}</Typography>
        </Box>
        <Box>
          <Typography sx={{ color: 'text.secondary', fontSize: 11, mb: 0.25 }}>{t('labeled')}</Typography>
          <Typography sx={{ fontWeight: 700, color: '#48bb78' }}>{labeled}</Typography>
        </Box>
        <Box>
          <Typography sx={{ color: 'text.secondary', fontSize: 11, mb: 0.25 }}>{t('unlabeled')}</Typography>
          <Typography sx={{ fontWeight: 700, color: 'primary.main' }}>{Math.max(0, total - labeled)}</Typography>
        </Box>
      </Box>

      <Box sx={{ fontSize: 12, color: 'text.secondary', display: 'flex', gap: 2.5, minWidth: 0 }}>
        <Typography component="span" sx={{ fontSize: 12, color: 'text.secondary', overflowWrap: 'anywhere' }}>
          <Typography component="strong" sx={{ fontWeight: 700, color: 'text.primary', fontSize: 12 }}>
            {t('path')}:
          </Typography>{' '}
          {sourcePath}
        </Typography>
        <Typography component="span" sx={{ ml: 'auto', whiteSpace: 'nowrap', fontSize: 12, color: 'text.secondary' }}>
          {t('created')}: {safeFormatDate(project.created_at)}
        </Typography>
      </Box>

      <LinearProgress variant="determinate" value={progress} sx={{ height: 6, borderRadius: 3, mt: 0.5 }} />
    </Paper>
  );
}
