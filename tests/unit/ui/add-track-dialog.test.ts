/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { revokeBlobUrlsFor } from '~ui/components/blob-url-helpers';
import type { BamTrack, BigWigTrack, ReferenceTrack } from '~state/types';

describe('revokeBlobUrlsFor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('revokes a BAM track\'s blob primary AND blob index URLs', () => {
    const spy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const t: BamTrack = {
      id: 'x',
      kind: 'bam',
      label: 'x',
      url: 'blob:http://localhost/abc',
      indexUrl: 'blob:http://localhost/def',
      visible: true,
    };
    revokeBlobUrlsFor(t);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith('blob:http://localhost/abc');
    expect(spy).toHaveBeenCalledWith('blob:http://localhost/def');
  });

  it('revokes a Reference track\'s blob primary AND blob fai URLs', () => {
    const spy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const t: ReferenceTrack = {
      id: 'x',
      kind: 'reference',
      label: 'x',
      url: 'blob:http://localhost/fa',
      faiUrl: 'blob:http://localhost/fai',
      visible: true,
    };
    revokeBlobUrlsFor(t);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('revokes a BigWig track\'s blob primary URL (no index)', () => {
    const spy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const t: BigWigTrack = {
      id: 'x',
      kind: 'bigwig',
      label: 'x',
      url: 'blob:http://localhost/bw',
      visible: true,
    };
    revokeBlobUrlsFor(t);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('leaves https:// URLs untouched', () => {
    const spy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const t: BamTrack = {
      id: 'x',
      kind: 'bam',
      label: 'x',
      url: 'https://example.com/x.bam',
      indexUrl: 'https://example.com/x.bam.bai',
      visible: true,
    };
    revokeBlobUrlsFor(t);
    expect(spy).not.toHaveBeenCalled();
  });

  it('handles mixed URLs (one blob, one https) — only revokes the blob', () => {
    const spy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const t: BamTrack = {
      id: 'x',
      kind: 'bam',
      label: 'x',
      url: 'blob:http://localhost/local-bam',
      indexUrl: 'https://example.com/x.bam.bai',
      visible: true,
    };
    revokeBlobUrlsFor(t);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('blob:http://localhost/local-bam');
  });

  it('swallows revokeObjectURL throwing (defensive)', () => {
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
      throw new Error('boom');
    });
    const t: BigWigTrack = {
      id: 'x',
      kind: 'bigwig',
      label: 'x',
      url: 'blob:http://localhost/bw',
      visible: true,
    };
    expect(() => revokeBlobUrlsFor(t)).not.toThrow();
  });
});
