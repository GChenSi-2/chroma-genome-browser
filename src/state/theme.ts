import { createSignal, createEffect } from 'solid-js';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'chroma.theme';

function readInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

const [theme, setTheme] = createSignal<Theme>(readInitialTheme());

createEffect(() => {
  const t = theme();
  document.documentElement.setAttribute('data-theme', t);
  try {
    window.localStorage.setItem(STORAGE_KEY, t);
  } catch {
    /* private mode, ignore */
  }
});

export function toggleTheme(): void {
  setTheme((t) => (t === 'light' ? 'dark' : 'light'));
}

export { theme };
