import { Box, Button, Chip, IconButton, Paper, ToggleButton, ToggleButtonGroup, Tooltip } from '@mui/material';
import NearMeIcon from '@mui/icons-material/NearMe';
import CropSquareIcon from '@mui/icons-material/CropSquare';
import PolylineIcon from '@mui/icons-material/Polyline';
import UndoIcon from '@mui/icons-material/Undo';
import RedoIcon from '@mui/icons-material/Redo';
import DeleteIcon from '@mui/icons-material/Delete';
import ClearIcon from '@mui/icons-material/Clear';
import ZoomOutMapIcon from '@mui/icons-material/ZoomOutMap';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import { useTranslation } from 'react-i18next';
import type { PromptMode } from '../viewer/ImageViewer';
import type { AiOperationMode } from '../../stores/workspace/aiAssistantStore';

type ToolMode = 'none' | 'manual-box' | 'manual-polygon' | 'point';

interface CommonCanvasToolbarProps {
  promptMode: PromptMode;
  onSetToolMode: (mode: ToolMode) => void;
  onFitToScreen: () => void;
}

interface ManualCanvasToolbarProps extends CommonCanvasToolbarProps {
  aiEnabled: boolean;
  aiPredicting: boolean;
  aiPromptCount: number;
  aiOperationMode: AiOperationMode;
  aiCanUndoPrompt: boolean;
  aiCanRedoPrompt: boolean;
  pointPromptLabel: 0 | 1;
  canUndo: boolean;
  canRedo: boolean;
  hasFocusedAnnotation: boolean;
  onSelectAiPointLabel: (label: 0 | 1) => void;
  onSetAiOperationMode: (mode: AiOperationMode) => void;
  onClearAiPrompts: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onDeleteFocusedAnnotation: () => void;
}

const frameSx = {
  position: 'absolute',
  bottom: 20,
  left: 16,
  right: 16,
  minHeight: 58,
  borderRadius: '18px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  px: 1.5,
  py: 0.75,
  gap: 0.75,
  zIndex: 100,
  overflowX: 'auto',
} as const;

function toolSx(active: boolean) {
  return {
    minWidth: 0,
    width: 40,
    height: 40,
    borderRadius: '20px',
    fontSize: 11,
    fontWeight: 800,
    bgcolor: active ? 'action.selected' : 'transparent',
    border: '1px solid',
    borderColor: active ? 'primary.main' : 'transparent',
    color: active ? 'primary.main' : 'text.primary',
  };
}

function CommonTools({ promptMode, onSetToolMode, onFitToScreen }: CommonCanvasToolbarProps) {
  const { t } = useTranslation();
  return (
    <>
      <Tooltip title={t('tool_pointer_title')}>
        <IconButton size="small" onClick={() => onSetToolMode('none')} aria-label={t('tool_pointer_title')} aria-pressed={promptMode === 'none'} sx={toolSx(promptMode === 'none')}>
          <NearMeIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title={t('tool_fit_title')}>
        <IconButton size="small" onClick={onFitToScreen} aria-label={t('tool_fit_title')} sx={toolSx(false)}>
          <ZoomOutMapIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </>
  );
}

export function AutoCanvasToolbar(props: CommonCanvasToolbarProps) {
  return (
    <Paper elevation={4} sx={frameSx}>
      <CommonTools {...props} />
    </Paper>
  );
}

export function ManualCanvasToolbar({
  promptMode,
  onSetToolMode,
  onFitToScreen,
  aiEnabled,
  aiPredicting,
  aiPromptCount,
  aiOperationMode,
  aiCanUndoPrompt,
  aiCanRedoPrompt,
  pointPromptLabel,
  canUndo,
  canRedo,
  hasFocusedAnnotation,
  onSelectAiPointLabel,
  onSetAiOperationMode,
  onClearAiPrompts,
  onUndo,
  onRedo,
  onDeleteFocusedAnnotation,
}: ManualCanvasToolbarProps) {
  const { t } = useTranslation();
  return (
    <Paper elevation={4} sx={frameSx}>
      <Tooltip title={t('tool_pointer_title')}>
        <IconButton size="small" onClick={() => onSetToolMode('none')} aria-label={t('tool_pointer_title')} aria-pressed={promptMode === 'none'} sx={toolSx(promptMode === 'none')}>
          <NearMeIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title={t('tool_manual_box_title')}>
        <IconButton size="small" onClick={() => onSetToolMode('manual-box')} aria-label={t('tool_manual_box_title')} aria-pressed={promptMode === 'manual-box'} sx={toolSx(promptMode === 'manual-box')}>
          <CropSquareIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title={t('tool_manual_polygon_title')}>
        <IconButton size="small" onClick={() => onSetToolMode('manual-polygon')} aria-label={t('tool_manual_polygon_title')} aria-pressed={promptMode === 'manual-polygon'} sx={toolSx(promptMode === 'manual-polygon')}>
          <PolylineIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 0.75, py: 0.25, borderRadius: 2, bgcolor: 'action.hover', flexShrink: 0 }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={aiOperationMode}
          disabled={aiPredicting}
          onChange={(_event, value: AiOperationMode | null) => { if (value) onSetAiOperationMode(value); }}
          aria-label={t('ai_operation_mode')}
          sx={{ '& .MuiToggleButton-root': { height: 34, px: 1.1, fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap' } }}
        >
          <ToggleButton value="new">{t('ai_mode_new')}</ToggleButton>
          <ToggleButton value="refine">{t('ai_mode_refine')}</ToggleButton>
        </ToggleButtonGroup>
        {aiOperationMode === 'refine' && !hasFocusedAnnotation ? (
          <Chip size="small" color="warning" variant="outlined" label={t('ai_refine_select_short')} sx={{ height: 26, fontSize: 10 }} />
        ) : null}
        {!aiEnabled ? (
          <Tooltip title={t('ai_canvas_tool_title')}>
            <Button size="small" onClick={() => onSelectAiPointLabel(1)} sx={{ ...toolSx(false), width: 'auto', px: 1.25, gap: 0.5, whiteSpace: 'nowrap', flexShrink: 0 }}>
              <AutoFixHighIcon fontSize="small" />
              {t('ai_segment_tool')}
            </Button>
          </Tooltip>
        ) : (
          <>
            <Tooltip title={t('ai_foreground_tool_hint')}>
              <Button size="small" variant={pointPromptLabel === 1 ? 'contained' : 'text'} color="success" onClick={() => onSelectAiPointLabel(1)} sx={{ height: 36, minWidth: 64, px: 1.25, fontSize: 11, fontWeight: 800 }}>
                {t('ai_foreground_point')}
              </Button>
            </Tooltip>
            <Tooltip title={t('ai_background_tool_hint')}>
              <Button size="small" variant={pointPromptLabel === 0 ? 'contained' : 'text'} color="error" onClick={() => onSelectAiPointLabel(0)} sx={{ height: 36, minWidth: 64, px: 1.25, fontSize: 11, fontWeight: 800 }}>
                {t('ai_background_point')}
              </Button>
            </Tooltip>
            {aiPromptCount > 0 ? (
              <>
                <Chip size="small" label={t('ai_prompt_count', { count: aiPromptCount })} sx={{ height: 26, fontSize: 10 }} />
                <Tooltip title={t('ai_clear_prompts')}>
                  <IconButton size="small" onClick={onClearAiPrompts} aria-label={t('ai_clear_prompts')} sx={toolSx(false)}>
                    <ClearIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </>
            ) : null}
          </>
        )}
      </Box>
      <Tooltip title={t('tool_undo_title')}>
        <span>
          <IconButton size="small" disabled={aiPredicting || (!canUndo && !aiCanUndoPrompt)} onClick={onUndo} aria-label={t('tool_undo_title')} sx={toolSx(false)}>
            <UndoIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={t('tool_redo_title')}>
        <span>
          <IconButton size="small" disabled={aiPredicting || (!canRedo && !aiCanRedoPrompt)} onClick={onRedo} aria-label={t('tool_redo_title')} sx={toolSx(false)}>
            <RedoIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={t('tool_delete_ann_title')}>
        <IconButton size="small" onClick={onDeleteFocusedAnnotation} aria-label={t('tool_delete_ann_title')} sx={{ ...toolSx(false), color: '#ef4444', opacity: hasFocusedAnnotation ? 1 : 0.45 }}>
          <DeleteIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title={t('tool_fit_title')}>
        <IconButton size="small" onClick={onFitToScreen} aria-label={t('tool_fit_title')} sx={toolSx(false)}>
          <ZoomOutMapIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Paper>
  );
}
