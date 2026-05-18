import { Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import { setTracks } from '~state/tracks';
import type {
  BamTrack,
  BigWigTrack,
  ReferenceTrack,
  TrackConfig,
  VcfTrack,
} from '~state/types';
export { revokeBlobUrlsFor, revokeAllBlobUrls } from './blob-url-helpers';

/**
 * Add Track dialog — modal for creating a track from a local file or
 * remote URL.
 *
 * Local-file path uses `URL.createObjectURL()` to turn the picked File
 * into a `blob:` URL. The rest of the stack (track-engine → worker pool
 * → @gmod parsers) reads the blob URL through standard `fetch()` with
 * no special-casing — Workers in the same document can resolve blob
 * URLs created on the main thread.
 *
 * Trade-offs deliberately accepted:
 *   - blob: URLs are document-scoped, so file-based tracks aren't
 *     shareable. `url-sync` filters them out of `?t=...`.
 *   - The user is responsible for picking a matching index file
 *     (`.bai` for BAM, `.fai` for FASTA). v1 doesn't auto-detect a
 *     same-name sidecar.
 *   - Gene / VCF / BED kinds aren't offered — their parsers either need
 *     an HTTP API (Ensembl REST) or aren't wired yet.
 *
 * On track removal the blob URLs are revoked (see TrackPanel).
 */

type Source = 'file' | 'url';
type SupportedKind = 'bam' | 'bigwig' | 'reference' | 'vcf';

interface AddTrackDialogProps {
  open: boolean;
  onClose: () => void;
}

const KIND_LABELS: Record<SupportedKind, string> = {
  bam: 'BAM (alignments)',
  bigwig: 'BigWig (signal)',
  reference: 'Reference FASTA',
  vcf: 'VCF (variants)',
};

const PRIMARY_ACCEPT: Record<SupportedKind, string> = {
  bam: '.bam',
  bigwig: '.bw,.bigwig',
  reference: '.fa,.fasta,.fna',
  vcf: '.vcf.gz,.gz',
};

const SECONDARY_ACCEPT: Record<SupportedKind, string> = {
  bam: '.bai',
  bigwig: '', // no secondary file
  reference: '.fai',
  vcf: '.tbi,.csi',
};

function primaryFieldLabel(kind: SupportedKind): string {
  if (kind === 'bam') return 'BAM file';
  if (kind === 'bigwig') return 'BigWig file';
  if (kind === 'vcf') return 'VCF.gz file';
  return 'FASTA file';
}

function secondaryFieldLabel(kind: SupportedKind): string {
  if (kind === 'bam') return 'BAI index file (.bai)';
  if (kind === 'reference') return 'FAI index file (.fai)';
  if (kind === 'vcf') return 'Tabix index file (.tbi)';
  return '';
}

function genTrackId(kind: SupportedKind): string {
  const rand = Math.random().toString(36).slice(2, 7);
  return `local-${kind}-${Date.now()}-${rand}`;
}

export function AddTrackDialog(props: AddTrackDialogProps) {
  const [kind, setKind] = createSignal<SupportedKind>('bam');
  const [source, setSource] = createSignal<Source>('file');
  const [label, setLabel] = createSignal('');

  // URL fields
  const [primaryUrl, setPrimaryUrl] = createSignal('');
  const [secondaryUrl, setSecondaryUrl] = createSignal('');

  // File picker state
  let primaryFileInput: HTMLInputElement | undefined;
  let secondaryFileInput: HTMLInputElement | undefined;
  const [primaryFileName, setPrimaryFileName] = createSignal('');
  const [secondaryFileName, setSecondaryFileName] = createSignal('');

  // Chrom-name mapping: most public BAM / VCF distros (1000G, GIAB,
  // ClinVar GRCh37) use bare "20" naming, but the viewport canonicalises
  // to "chr20" (UCSC convention). This checkbox strips the chr-prefix
  // before sending the chrom to the worker.
  const [stripChr, setStripChr] = createSignal(false);

  const [error, setError] = createSignal('');

  const needsSecondary = createMemo(
    () => kind() === 'bam' || kind() === 'reference' || kind() === 'vcf',
  );

  function reset(): void {
    setKind('bam');
    setSource('file');
    setLabel('');
    setPrimaryUrl('');
    setSecondaryUrl('');
    setPrimaryFileName('');
    setSecondaryFileName('');
    setStripChr(false);
    setError('');
    if (primaryFileInput) primaryFileInput.value = '';
    if (secondaryFileInput) secondaryFileInput.value = '';
  }

  function close(): void {
    reset();
    props.onClose();
  }

  function buildConfig(
    chosenKind: SupportedKind,
    primary: string,
    secondary: string,
    fallbackLabel: string,
  ): TrackConfig {
    const id = genTrackId(chosenKind);
    const displayLabel = label().trim() || fallbackLabel;
    if (chosenKind === 'bam') {
      return {
        id,
        kind: 'bam',
        label: displayLabel,
        url: primary,
        indexUrl: secondary,
        visible: true,
        ...(stripChr() ? { chromMap: 'strip-chr' as const } : {}),
      } satisfies BamTrack;
    }
    if (chosenKind === 'bigwig') {
      return {
        id,
        kind: 'bigwig',
        label: displayLabel,
        url: primary,
        visible: true,
      } satisfies BigWigTrack;
    }
    if (chosenKind === 'vcf') {
      return {
        id,
        kind: 'vcf',
        label: displayLabel,
        url: primary,
        indexUrl: secondary,
        visible: true,
        ...(stripChr() ? { chromMap: 'strip-chr' as const } : {}),
      } satisfies VcfTrack;
    }
    return {
      id,
      kind: 'reference',
      label: displayLabel,
      url: primary,
      faiUrl: secondary,
      visible: true,
    } satisfies ReferenceTrack;
  }

  function handleAdd(): void {
    setError('');
    const k = kind();
    let primary = '';
    let secondary = '';
    let fallback = 'Untitled track';

    if (source() === 'url') {
      primary = primaryUrl().trim();
      if (primary.length === 0) {
        setError('Please paste a URL.');
        return;
      }
      try {
        new URL(primary);
      } catch {
        setError('That doesn’t look like a valid URL.');
        return;
      }
      if (needsSecondary()) {
        secondary = secondaryUrl().trim();
        if (secondary.length === 0) {
          setError(`${k === 'bam' ? 'BAI' : 'FAI'} index URL is required.`);
          return;
        }
        try {
          new URL(secondary);
        } catch {
          setError('Index URL is not valid.');
          return;
        }
      }
      // Derive a label from the last path segment of the URL.
      try {
        const u = new URL(primary);
        fallback = u.pathname.split('/').pop() || 'Untitled track';
      } catch {
        /* keep fallback */
      }
    } else {
      const pf = primaryFileInput?.files?.[0] ?? null;
      if (!pf) {
        setError('Please pick a file.');
        return;
      }
      primary = URL.createObjectURL(pf);
      fallback = pf.name;
      if (needsSecondary()) {
        const sf = secondaryFileInput?.files?.[0] ?? null;
        if (!sf) {
          // Roll back the primary blob URL we just created — otherwise it
          // leaks until the document goes away.
          URL.revokeObjectURL(primary);
          setError(
            k === 'bam'
              ? 'BAM tracks need a .bai index file too.'
              : 'Reference tracks need a .fai index file too.',
          );
          return;
        }
        secondary = URL.createObjectURL(sf);
      }
    }

    const cfg = buildConfig(k, primary, secondary, fallback);

    setTracks((prev) => {
      if (prev.some((t) => t.id === cfg.id)) {
        // ID collision is essentially impossible (timestamp + random)
        // but be defensive.
        return prev;
      }
      return [...prev, cfg];
    });
    close();
  }

  function handleKey(e: KeyboardEvent): void {
    if (!props.open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  onMount(() => {
    document.addEventListener('keydown', handleKey);
  });
  onCleanup(() => {
    document.removeEventListener('keydown', handleKey);
  });

  // Bare element handlers for inputs — keeps SolidJS event types loose.
  const onPrimaryFile = (e: Event): void => {
    const input = e.target as HTMLInputElement;
    setPrimaryFileName(input.files?.[0]?.name ?? '');
  };
  const onSecondaryFile = (e: Event): void => {
    const input = e.target as HTMLInputElement;
    setSecondaryFileName(input.files?.[0]?.name ?? '');
  };

  return (
    <Show when={props.open}>
      <Portal>
        <div
          class="chroma-modal-backdrop"
          onClick={close}
          role="presentation"
        >
          <div
            class="chroma-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-track-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 class="chroma-modal-title" id="add-track-title">
              Add track
            </h2>

            <div class="chroma-modal-field">
              <label>Track type</label>
              <select
                value={kind()}
                onChange={(e) =>
                  setKind((e.target as HTMLSelectElement).value as SupportedKind)
                }
              >
                <option value="bam">{KIND_LABELS.bam}</option>
                <option value="bigwig">{KIND_LABELS.bigwig}</option>
                <option value="reference">{KIND_LABELS.reference}</option>
                <option value="vcf">{KIND_LABELS.vcf}</option>
              </select>
            </div>

            <div class="chroma-modal-field">
              <label>Source</label>
              <div class="chroma-modal-segment">
                <button
                  type="button"
                  class="chroma-modal-segment-btn"
                  classList={{ 'chroma-modal-segment-btn--active': source() === 'file' }}
                  onClick={() => setSource('file')}
                >
                  Local file
                </button>
                <button
                  type="button"
                  class="chroma-modal-segment-btn"
                  classList={{ 'chroma-modal-segment-btn--active': source() === 'url' }}
                  onClick={() => setSource('url')}
                >
                  Remote URL
                </button>
              </div>
            </div>

            <Show when={source() === 'file'}>
              <div class="chroma-modal-field">
                <label>{primaryFieldLabel(kind())}</label>
                <input
                  type="file"
                  accept={PRIMARY_ACCEPT[kind()]}
                  ref={(el) => { primaryFileInput = el; }}
                  onChange={onPrimaryFile}
                />
                <Show when={primaryFileName()}>
                  <div class="chroma-modal-hint">{primaryFileName()}</div>
                </Show>
              </div>
              <Show when={needsSecondary()}>
                <div class="chroma-modal-field">
                  <label>{secondaryFieldLabel(kind())}</label>
                  <input
                    type="file"
                    accept={SECONDARY_ACCEPT[kind()]}
                    ref={(el) => { secondaryFileInput = el; }}
                    onChange={onSecondaryFile}
                  />
                  <Show when={secondaryFileName()}>
                    <div class="chroma-modal-hint">{secondaryFileName()}</div>
                  </Show>
                </div>
              </Show>
            </Show>

            <Show when={source() === 'url'}>
              <div class="chroma-modal-field">
                <label>{primaryFieldLabel(kind())} URL</label>
                <input
                  type="url"
                  placeholder="https://..."
                  value={primaryUrl()}
                  onInput={(e) => setPrimaryUrl((e.target as HTMLInputElement).value)}
                />
              </div>
              <Show when={needsSecondary()}>
                <div class="chroma-modal-field">
                  <label>{secondaryFieldLabel(kind())} URL</label>
                  <input
                    type="url"
                    placeholder="https://..."
                    value={secondaryUrl()}
                    onInput={(e) =>
                      setSecondaryUrl((e.target as HTMLInputElement).value)
                    }
                  />
                </div>
              </Show>
            </Show>

            <div class="chroma-modal-field">
              <label>Label (optional)</label>
              <input
                type="text"
                placeholder="Defaults to file name"
                value={label()}
                onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
              />
            </div>

            <Show when={kind() === 'bam' || kind() === 'vcf'}>
              <div class="chroma-modal-field chroma-modal-checkbox-field">
                <label class="chroma-modal-checkbox">
                  <input
                    type="checkbox"
                    checked={stripChr()}
                    onChange={(e) =>
                      setStripChr((e.target as HTMLInputElement).checked)
                    }
                  />
                  Strip "chr" prefix from chromosome names
                </label>
                <div class="chroma-modal-hint">
                  Check this if your file uses "20" instead of "chr20" — common for
                  1000G, GIAB GRCh37, ClinVar GRCh37 distributions.
                </div>
              </div>
            </Show>

            <Show when={error()}>
              <div class="chroma-modal-error" role="alert">{error()}</div>
            </Show>

            <div class="chroma-modal-actions">
              <button
                type="button"
                class="chroma-modal-btn"
                onClick={close}
              >
                Cancel
              </button>
              <button
                type="button"
                class="chroma-modal-btn chroma-modal-btn--primary"
                onClick={handleAdd}
              >
                Add
              </button>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

