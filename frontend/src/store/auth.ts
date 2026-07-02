import { create } from 'zustand';

export interface User {
  id: number;
  username: string;
  is_admin: boolean;
  must_reset: boolean;
  /** The resource submenus (concrete k8s resources) this user may view. */
  nav: { submenus: string[] };
  /** Effective global permissions: area → granted actions. */
  global: Record<string, string[]>;
}

const TOKEN_KEY = 'omnikube_token';

interface AuthState {
  token: string | null;
  user: User | null;
  setToken: (token: string | null) => void;
  setUser: (user: User | null) => void;
  /** Set token + user in one update — avoids a transient token-without-user
   *  state that would flash the app-level loader over the login page. */
  setAuth: (token: string, user: User) => void;
  clearMustReset: () => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: localStorage.getItem(TOKEN_KEY),
  user: null,
  setToken: (token) => {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
    set({ token });
  },
  setUser: (user) => set({ user }),
  setAuth: (token, user) => {
    localStorage.setItem(TOKEN_KEY, token);
    set({ token, user });
  },
  clearMustReset: () =>
    set((s) => (s.user ? { user: { ...s.user, must_reset: false } } : {})),
  logout: () => {
    localStorage.removeItem(TOKEN_KEY);
    set({ token: null, user: null });
  },
}));

/** Read the current token outside React (used by the axios interceptor). */
export function getToken(): string | null {
  return useAuthStore.getState().token ?? localStorage.getItem(TOKEN_KEY);
}
