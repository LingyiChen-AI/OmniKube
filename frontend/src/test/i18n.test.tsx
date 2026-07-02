import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useTranslation } from 'react-i18next';
import i18n, {
  configuredDefaultLang,
  resolveInitialLang,
  setLanguage,
  LANG_STORAGE_KEY,
} from '../i18n';

function Probe() {
  const { t } = useTranslation();
  return <div data-testid="nav">{t('nav.dashboard')}</div>;
}

function Switcher() {
  return (
    <div>
      <Probe />
      <button onClick={() => setLanguage('zh')}>to-zh</button>
      <button onClick={() => setLanguage('ja')}>to-ja</button>
      <button onClick={() => setLanguage('en')}>to-en</button>
    </div>
  );
}

describe('i18n configuration', () => {
  beforeEach(() => {
    localStorage.clear();
    i18n.changeLanguage('en');
  });

  it('default language falls back to the configured value (zh) when nothing is stored', () => {
    localStorage.removeItem(LANG_STORAGE_KEY);
    expect(configuredDefaultLang()).toBe('zh');
    expect(resolveInitialLang()).toBe('zh');
  });

  it('a stored language choice wins over the configured default', () => {
    localStorage.setItem(LANG_STORAGE_KEY, 'ja');
    expect(resolveInitialLang()).toBe('ja');
  });

  it('ignores an invalid stored language and uses the configured default', () => {
    localStorage.setItem(LANG_STORAGE_KEY, 'xx');
    expect(resolveInitialLang()).toBe('zh');
  });

  it('the language switcher changes the rendered text and persists the choice', async () => {
    const user = userEvent.setup();
    render(<Switcher />);

    expect(screen.getByTestId('nav')).toHaveTextContent('Dashboard');

    await user.click(screen.getByText('to-zh'));
    expect(screen.getByTestId('nav')).toHaveTextContent('仪表盘');
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe('zh');

    await user.click(screen.getByText('to-ja'));
    expect(screen.getByTestId('nav')).toHaveTextContent('ダッシュボード');
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe('ja');
  });
});
