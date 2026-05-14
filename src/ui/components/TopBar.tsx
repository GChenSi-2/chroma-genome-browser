import { createSignal, onCleanup, onMount } from 'solid-js';
import { setViewport, viewport } from '~state/viewport';
import { jumpTo } from '~state/viewport-actions';
import { formatLocus, parseLocus } from '~state/locus-parser';
import { basePixelWidth, semanticLevel } from '~state/derived';
import { onRequestFocus } from '~state/ui-focus';
import { ThemeToggle } from './ThemeToggle';
import Keyboard from 'lucide-solid/icons/keyboard';

/**
 * TopBar — DESIGN_SYSTEM §6 + §5 layout:
 *
 *   [ ■ Chroma ]   [ <locus input>  bpw · level ]   [ ? ]  [ theme ]
 *
 * Locus input behaviour (T2.D.1):
 *   - Always shows `formatLocus(viewport())` when unfocused.
 *   - Focus selects all text; typing live-validates against `parseLocus`
 *     and paints a subtle accent / danger underline. Viewport is NOT
 *     mutated until Enter.
 *   - Enter on a valid locus → `setViewport(jumpTo(...))`, then blur.
 *   - Enter on an invalid locus → a 200ms CSS shake; focus stays.
 *   - Escape → revert to canonical + blur.
 *   - The `g` global shortcut requests focus via the `ui-focus` signal.
 *
 * Suppression of global shortcuts while typing: `isTypingTarget` in
 * `global-shortcuts.ts` already excludes `<input>` targets, so we get
 * this for free as long as our element is a plain `<input>`.
 */
export function TopBar() {
  let inputRef: HTMLInputElement | undefined;

  // Draft = what the user is currently typing. `null` means "not editing,
  // mirror the viewport". On focus we copy the canonical string into draft
  // so the input stays controlled-ish without re-rendering on every keystroke.
  const [draft, setDraft] = createSignal<string | null>(null);
  // 'idle' | 'ok' | 'invalid' — drives the underline.
  const [status, setStatus] = createSignal<'idle' | 'ok' | 'invalid'>('idle');
  // Bump on shake start so the CSS animation re-fires for repeat bad Enters.
  const [shakeKey, setShakeKey] = createSignal(0);

  const displayValue = () => draft() ?? formatLocus(viewport());

  function revalidate(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      setStatus('idle');
      return;
    }
    const parsed = parseLocus(trimmed);
    setStatus(parsed.ok ? 'ok' : 'invalid');
  }

  function handleFocus(e: FocusEvent): void {
    const target = e.currentTarget as HTMLInputElement;
    setDraft(formatLocus(viewport()));
    setStatus('idle');
    // Defer selection — Solid's reactive set fires synchronously but the
    // browser still needs the value to be in the input first.
    queueMicrotask(() => target.select());
  }

  function handleBlur(): void {
    setDraft(null);
    setStatus('idle');
  }

  function handleInput(e: InputEvent): void {
    const target = e.currentTarget as HTMLInputElement;
    setDraft(target.value);
    revalidate(target.value);
  }

  function commit(): void {
    const text = draft();
    if (text === null) return;
    const parsed = parseLocus(text);
    if (!parsed.ok) {
      setShakeKey((n) => n + 1);
      setStatus('invalid');
      return;
    }
    setViewport((v) => jumpTo(v, parsed.locus.chrom, parsed.locus.start, parsed.locus.end));
    setDraft(null);
    setStatus('idle');
    inputRef?.blur();
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(null);
      setStatus('idle');
      inputRef?.blur();
    }
    // Other keys: do nothing here, let the browser handle text editing.
  }

  // Register a focus handler so the global `g` shortcut can pull focus in.
  onMount(() => {
    const dispose = onRequestFocus('locus-input', () => {
      inputRef?.focus();
    });
    onCleanup(dispose);
  });

  return (
    <header class="chroma-topbar">
      <div class="chroma-brand">
        <span class="chroma-mark" aria-hidden="true" />
        <span class="chroma-wordmark">Chroma</span>
      </div>

      <div class="chroma-topbar-center">
        <input
          ref={inputRef}
          type="text"
          class="chroma-locus-input"
          classList={{
            'chroma-locus-input--ok': status() === 'ok',
            'chroma-locus-input--invalid': status() === 'invalid',
          }}
          spellcheck={false}
          autocomplete="off"
          autocapitalize="off"
          aria-label="Locus (chrom:start-end)"
          value={displayValue()}
          data-shake={shakeKey()}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
        />
        <span class="chroma-locus-meta" aria-hidden="true">
          bpw {basePixelWidth().toExponential(2)} · {semanticLevel()}
        </span>
      </div>

      <div class="chroma-topbar-spacer" />

      <button
        type="button"
        class="chroma-topbar-icon-btn"
        title="Keyboard shortcuts (?)"
        aria-label="Show keyboard shortcuts"
      >
        <Keyboard size={16} />
      </button>
      <ThemeToggle />
    </header>
  );
}
