import { Box, Chip, Paper, Typography } from '@mui/material';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import { useTranslation } from 'react-i18next';
import { WORKSPACE_SHORTCUT_SECTIONS } from '../../shortcuts/shortcutDefinitions';

export function ShortcutsTab() {
  const { t } = useTranslation();

  return (
    <Box sx={{ display: 'grid', gap: 2.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
        <KeyboardIcon color="primary" />
        <Box>
          <Typography component="h2" sx={{ fontSize: 20, fontWeight: 900 }}>
            {t('shortcut_help_title')}
          </Typography>
          <Typography sx={{ color: 'text.secondary', fontSize: 12 }}>
            {t('shortcut_help_subtitle')}
          </Typography>
        </Box>
      </Box>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography sx={{ color: 'text.secondary', fontSize: 13 }}>
          {t('shortcut_input_scope_hint')}
        </Typography>
      </Paper>

      {WORKSPACE_SHORTCUT_SECTIONS.map((section) => (
        <Paper key={section.titleKey} variant="outlined" sx={{ overflow: 'hidden' }}>
          <Typography sx={{ px: 2.5, py: 1.75, fontSize: 16, fontWeight: 800, borderBottom: '1px solid', borderColor: 'divider' }}>
            {t(section.titleKey)}
          </Typography>
          <Box component="dl" sx={{ m: 0 }}>
            {section.items.map((item, index) => (
              <Box
                key={item.descriptionKey}
                sx={{ px: 2.5, py: 1.5, display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '220px 1fr' }, gap: 1.5, alignItems: 'center', borderTop: index ? '1px solid' : 0, borderColor: 'divider' }}
              >
                <Box component="dt" sx={{ m: 0, display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                  {item.keys.map((key) => (
                    <Box key={key} component="kbd" sx={{ px: 1, py: 0.4, borderRadius: 1, border: '1px solid', borderColor: 'divider', bgcolor: 'action.hover', fontFamily: 'monospace', fontWeight: 800, fontSize: 12 }}>
                      {key.startsWith('shortcut_key_') ? t(key) : key}
                    </Box>
                  ))}
                  {item.manualOnly ? <Chip size="small" variant="outlined" label={t('shortcut_manual_only')} sx={{ height: 22, fontSize: 10 }} /> : null}
                </Box>
                <Typography component="dd" sx={{ m: 0, fontSize: 14 }}>
                  {t(item.descriptionKey)}
                </Typography>
              </Box>
            ))}
          </Box>
        </Paper>
      ))}
    </Box>
  );
}
