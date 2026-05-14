import { Show } from 'solid-js';
// Per-icon imports — `import { Moon } from 'lucide-solid'` pulls 1000+
// icon modules through Vite's dev server (no pre-bundling on a barrel).
import Moon from 'lucide-solid/icons/moon';
import Sun from 'lucide-solid/icons/sun';
import { theme, toggleTheme } from '~state/theme';

export function ThemeToggle() {
  return (
    <button
      type="button"
      class="theme-toggle"
      onClick={toggleTheme}
      title="Toggle theme (t)"
      aria-label="Toggle color theme"
    >
      <Show when={theme() === 'light'} fallback={<Sun size={16} />}>
        <Moon size={16} />
      </Show>
    </button>
  );
}
