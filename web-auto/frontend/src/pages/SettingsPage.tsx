import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Box, Button, Paper, Tab, Tabs, Typography } from '@mui/material';
import { getGlobalConfig, type GlobalConfig } from '../api/config';
import { useSettingsStore } from '../stores/settingsStore';
import { useToast } from '../components/common/ToastProvider';
import { BasicTab } from '../components/settings/BasicTab';
import { PathsTab } from '../components/settings/PathsTab';
import { RuntimeTab } from '../components/settings/RuntimeTab';
import { CacheTab } from '../components/settings/CacheTab';
import { ShortcutsTab } from '../components/settings/ShortcutsTab';

type SettingsTabValue = 'basic' | 'paths' | 'runtime' | 'cache' | 'shortcuts';

const SETTINGS_TABS = new Set<SettingsTabValue>(['basic', 'paths', 'runtime', 'cache', 'shortcuts']);

function settingsTabValue(value: string | null): SettingsTabValue {
  return SETTINGS_TABS.has(value as SettingsTabValue) ? value as SettingsTabValue : 'basic';
}

function stripTrailingSlashes(value: unknown): string {
  return String(value ?? '').replace(/\/+$/, '');
}

export function SettingsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { showToast } = useToast();

  const [activeTab, setActiveTab] = useState<SettingsTabValue>(() => settingsTabValue(searchParams.get('tab')));
  const [config, setConfig] = useState<GlobalConfig>({});
  const [statusLine, setStatusLine] = useState('');

  const loadConfig = useCallback(async () => {
    let cfg: GlobalConfig = {};
    try {
      const res = await getGlobalConfig();
      cfg = res.config || {};
    } catch (e) {
      showToast((e as Error).message, 'error');
    }

    // Reconcile local API URLs against the server allow-lists (same as old settings.js)
    const store = useSettingsStore.getState();
    const allowed = cfg.allowed_sam3_api_base_urls || [];
    let samUrl = store.sam3ApiUrl || cfg.sam3_api_base_url || '';
    if (
      allowed.length &&
      !allowed.map((item) => stripTrailingSlashes(item)).includes(stripTrailingSlashes(samUrl))
    ) {
      samUrl = cfg.sam3_api_base_url || allowed[0] || samUrl;
      store.set('sam3ApiUrl', samUrl);
    }
    const locateAllowed = cfg.allowed_locate_api_base_urls || [];
    let locateUrl = store.locateApiUrl || cfg.locate_api_base_url || '';
    if (
      locateAllowed.length &&
      !locateAllowed
        .map((item) => stripTrailingSlashes(item))
        .includes(stripTrailingSlashes(locateUrl))
    ) {
      locateUrl = cfg.locate_api_base_url || locateAllowed[0] || locateUrl;
      store.set('locateApiUrl', locateUrl);
    }

    setConfig(cfg);
    setStatusLine(t('settings_loaded'));
  }, [showToast, t]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    setActiveTab(settingsTabValue(searchParams.get('tab')));
  }, [searchParams]);

  const selectTab = (value: SettingsTabValue) => {
    setActiveTab(value);
    setSearchParams(value === 'basic' ? {} : { tab: value }, { replace: true });
  };

  return (
    <Box sx={{ height: '100vh', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          px: 5,
          py: 2.5,
          gap: 2,
          borderBottom: '1px solid',
          borderColor: 'divider',
          flexWrap: 'wrap',
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography component="h1" variant="h4" sx={{ display: 'inline-block', fontWeight: 800 }}>
            {t('global_settings')}
          </Typography>
          <Typography
            component="span"
            sx={{ ml: 1.5, color: 'text.secondary', fontSize: 14, fontWeight: 500 }}
          >
            {statusLine}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Button variant="outlined" onClick={() => navigate('/')}>
            {t('back_to_projects')}
          </Button>
        </Box>
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: 'minmax(180px, 220px) minmax(0, 780px)' },
          gap: 3.5,
          p: { xs: 2.5, md: 5 },
          alignItems: 'start',
        }}
      >
        <Paper sx={{ p: 1.75 }}>
          <Tabs
            value={activeTab}
            onChange={(_, value: SettingsTabValue) => selectTab(value)}
            orientation="vertical"
            variant="scrollable"
            sx={{
              flexDirection: { xs: 'row', md: 'column' },
              '& .MuiTab-root': { textAlign: 'left', alignItems: 'flex-start', minHeight: 44 },
            }}
          >
            <Tab value="basic" label={t('settings_basic')} />
            <Tab value="paths" label={t('settings_paths')} />
            <Tab value="runtime" label={t('settings_runtime')} />
            <Tab value="cache" label={t('settings_cache')} />
            <Tab value="shortcuts" label={t('shortcut_help_title')} />
          </Tabs>
        </Paper>

        <Paper sx={{ p: 3.5 }}>
          {activeTab === 'basic' && (
            <BasicTab config={config} onSaved={setConfig} onReload={loadConfig} />
          )}
          {activeTab === 'paths' && <PathsTab config={config} onSaved={setConfig} />}
          {activeTab === 'runtime' && (
            <RuntimeTab config={config} onReload={loadConfig} onStatusChange={setStatusLine} />
          )}
          {activeTab === 'cache' && <CacheTab />}
          {activeTab === 'shortcuts' && <ShortcutsTab />}
        </Paper>
      </Box>
    </Box>
  );
}
