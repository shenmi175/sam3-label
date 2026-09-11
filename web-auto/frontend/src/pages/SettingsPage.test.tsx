import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/common/ToastProvider';
import { SettingsPage } from './SettingsPage';

vi.mock('../api/config', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api/config')>();
  return { ...original, getGlobalConfig: vi.fn().mockResolvedValue({ config: {} }) };
});

describe('SettingsPage shortcut help', () => {
  beforeEach(() => localStorage.setItem('language', 'zh'));
  afterEach(cleanup);

  it('opens shortcut help as a settings tab from the URL', () => {
    render(
      <MemoryRouter initialEntries={['/settings?tab=shortcuts']}>
        <ToastProvider>
          <SettingsPage />
        </ToastProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole('tab', { name: '快捷键说明' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: '快捷键说明' })).toBeInTheDocument();
    expect(screen.getByText('切换到上一张图片')).toBeInTheDocument();
  });
});
