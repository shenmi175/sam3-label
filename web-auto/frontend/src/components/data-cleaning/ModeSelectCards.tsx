import { Box, Button, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import type { FilterTaskType } from '../../api/filters';
import { useSmartFilterStore } from '../../stores/workspace/smartFilterStore';

const GROUPS: Array<{ title: string; tasks: FilterTaskType[] }> = [
  { title: 'sf_group_mask', tasks: ['remove_small_components', 'remove_edge_spurs', 'shortest_bridge', 'morph_close', 'fill_small_holes'] },
  { title: 'sf_group_delete', tasks: ['deduplicate_same_class', 'remove_small_instances', 'remove_confidence_range', 'remove_position_region', 'delete_by_box_count'] },
  { title: 'sf_group_organize', tasks: ['normalize_classes', 'delete_unlabeled_images'] },
];

export const DATA_CLEANING_TASK_TABS: Record<'noise' | 'instances' | 'merge' | 'unlabeled', FilterTaskType[]> = {
  noise: ['remove_small_components', 'deduplicate_same_class', 'normalize_classes'],
  instances: ['remove_small_instances', 'remove_confidence_range', 'remove_position_region', 'delete_by_box_count'],
  merge: ['remove_edge_spurs', 'fill_small_holes', 'shortest_bridge', 'morph_close'],
  unlabeled: ['delete_unlabeled_images'],
};

export function ModeSelectCards({ tasks }: { tasks?: FilterTaskType[] }) {
  const { t } = useTranslation();
  const taskType = useSmartFilterStore((state) => state.config.taskType);
  const selectTask = useSmartFilterStore((state) => state.selectTask);
  const taskButton = (task: FilterTaskType) => (
    <Button
      key={task}
      size="small"
      variant={taskType === task ? 'contained' : 'outlined'}
      onClick={() => selectTask(task)}
      sx={{ justifyContent: 'flex-start', textAlign: 'left', minHeight: 38 }}
    >
      {t(`sf_task_${task}`)}
    </Button>
  );

  if (tasks) {
    return (
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2,minmax(0,1fr))' }, gap: 0.75 }}>
        {tasks.map(taskButton)}
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      {GROUPS.map((group) => (
        <Box key={group.title}>
          <Typography sx={{ mb: 0.75, fontSize: 12, fontWeight: 800, color: 'text.secondary' }}>{t(group.title)}</Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2,minmax(0,1fr))' }, gap: 0.75 }}>
            {group.tasks.map(taskButton)}
          </Box>
        </Box>
      ))}
    </Box>
  );
}
