import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BeforeAfterCompare } from './BeforeAfterCompare';
import '../../i18n';

afterEach(cleanup);

describe('cleaning difference viewer', () => {
  it('defaults to the lossless change crop and supports whole-image and side-by-side views', () => {
    render(<BeforeAfterCompare beforeUrl="/before" afterUrl="/after" diffUrl="/diff"
      beforeDetailUrl="/before-detail" afterDetailUrl="/after-detail" diffDetailUrl="/diff-detail" sampleName="sample" />);
    expect(screen.getByRole('img')).toHaveAttribute('src', '/diff-detail');
    fireEvent.click(screen.getByRole('button', { name: '查看整图' }));
    expect(screen.getByRole('img')).toHaveAttribute('src', '/diff');
    fireEvent.click(screen.getByRole('button', { name: '并排' }));
    expect(screen.getAllByRole('img').map((img) => img.getAttribute('src'))).toEqual(['/before', '/after']);
    fireEvent.click(screen.getByRole('button', { name: '定位变化区域' }));
    expect(screen.getAllByRole('img').map((img) => img.getAttribute('src'))).toEqual(['/before-detail', '/after-detail']);
  });
});
