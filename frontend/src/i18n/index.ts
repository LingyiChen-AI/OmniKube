import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en';
import zh from './locales/zh';
import ja from './locales/ja';
import ko from './locales/ko';
import fr from './locales/fr';
import de from './locales/de';
import es from './locales/es';

export const SUPPORTED_LANGS = ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es'] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];

export const LANG_STORAGE_KEY = 'omnikube_lang';

export const LANG_OPTIONS: { value: Lang; label: string }[] = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
];

/** The configured default language (VITE_DEFAULT_LANG), falling back to 'zh'. */
export function configuredDefaultLang(): Lang {
  const env = (import.meta.env.VITE_DEFAULT_LANG || '').toString().trim();
  return (SUPPORTED_LANGS as readonly string[]).includes(env) ? (env as Lang) : 'zh';
}

/** Resolve the initial language: stored choice wins, else the configured default. */
export function resolveInitialLang(): Lang {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LANG_STORAGE_KEY);
  } catch {
    stored = null;
  }
  if (stored && (SUPPORTED_LANGS as readonly string[]).includes(stored)) {
    return stored as Lang;
  }
  return configuredDefaultLang();
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    zh: { translation: zh },
    ja: { translation: ja },
    ko: { translation: ko },
    fr: { translation: fr },
    de: { translation: de },
    es: { translation: es },
  },
  lng: resolveInitialLang(),
  fallbackLng: configuredDefaultLang(),
  interpolation: { escapeValue: false },
  returnNull: false,
  react: { useSuspense: false },
});

/** Change language and persist the choice. */
export function setLanguage(lang: Lang): void {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    /* ignore storage errors (e.g. private mode) */
  }
  i18n.changeLanguage(lang);
}

export default i18n;
