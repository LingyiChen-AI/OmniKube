import { create } from 'zustand';

const THEME_KEY = 'omnikube_theme';
type Mode = 'dark' | 'light';

interface UiState {
  mode: Mode;
  toggleMode: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  mode: (localStorage.getItem(THEME_KEY) as Mode) || 'dark',
  toggleMode: () =>
    set((s) => {
      const mode: Mode = s.mode === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, mode);
      return { mode };
    }),
}));
