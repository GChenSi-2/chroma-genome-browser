import { Show } from 'solid-js';
import { Moon, Sun } from 'lucide-solid';
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
