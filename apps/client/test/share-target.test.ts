/**
 * Delivering a card or clip: Web Share with files where the browser can,
 * else a download, else (images only) the clipboard; a dismissed share sheet
 * is a cancel, not a reason to download behind the player's back; and the
 * share call happens before any await so the click's activation survives.
 */
import { describe, expect, it, vi } from 'vitest';
import { deliverFile, shareCapabilities, type ShareEnv } from '../src/game/share/shareTarget.ts';

const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'card.png', { type: 'image/png' });
const clip = new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], 'clip.webm', { type: 'video/webm' });

function env(over: Partial<ShareEnv> = {}): Required<ShareEnv> {
  return {
    canShare: vi.fn(() => true),
    share: vi.fn(async () => {}),
    download: vi.fn(() => true),
    copyImage: vi.fn(async () => {}),
    ...over,
  } as Required<ShareEnv>;
}

function domError(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

describe('deliverFile', () => {
  it('shares files through the Web Share API when the browser can', async () => {
    const e = env();
    expect(await deliverFile(png, 'share', e, { title: 'Crowned!' })).toBe('shared');
    expect(e.share).toHaveBeenCalledWith({ files: [png], title: 'Crowned!' });
    expect(e.download).not.toHaveBeenCalled();
  });

  it('calls share synchronously, before any await', () => {
    const e = env();
    void deliverFile(clip, 'share', e);
    expect(e.share).toHaveBeenCalledTimes(1);
  });

  it('treats a dismissed share sheet as a cancel', async () => {
    const e = env({ share: vi.fn(async () => Promise.reject(domError('AbortError'))) });
    expect(await deliverFile(png, 'share', e)).toBe('cancelled');
    expect(e.download).not.toHaveBeenCalled();
  });

  it('downloads when files cannot be shared or the share is refused', async () => {
    const noFiles = env({ canShare: vi.fn(() => false) });
    expect(await deliverFile(clip, 'share', noFiles)).toBe('downloaded');
    expect(noFiles.share).not.toHaveBeenCalled();
    expect(noFiles.download).toHaveBeenCalledWith(clip, 'clip.webm');

    const refused = env({ share: vi.fn(async () => Promise.reject(domError('NotAllowedError'))) });
    expect(await deliverFile(png, 'share', refused)).toBe('downloaded');

    const throwing = env({
      canShare: vi.fn(() => {
        throw new TypeError('files unsupported');
      }),
    });
    expect(await deliverFile(png, 'share', throwing)).toBe('downloaded');

    const noApi: ShareEnv = { download: vi.fn(() => true) };
    expect(await deliverFile(png, 'share', noApi)).toBe('downloaded');
  });

  it('copies images to the clipboard as the last resort', async () => {
    const e: ShareEnv = { copyImage: vi.fn(async () => {}) };
    expect(await deliverFile(png, 'share', e)).toBe('copied');
    expect(e.copyImage).toHaveBeenCalledWith(png);
    expect(await deliverFile(clip, 'share', e)).toBe('unsupported');
    expect(await deliverFile(png, 'share', {})).toBe('unsupported');
  });

  it('runs Save and Copy directly and reports failures', async () => {
    const e = env();
    expect(await deliverFile(png, 'download', e)).toBe('downloaded');
    expect(e.share).not.toHaveBeenCalled();
    expect(await deliverFile(png, 'copy', e)).toBe('copied');
    expect(await deliverFile(clip, 'copy', e)).toBe('unsupported');
    const broken = env({
      download: vi.fn(() => {
        throw new Error('blocked');
      }),
      copyImage: vi.fn(async () => Promise.reject(new Error('denied'))),
    });
    expect(await deliverFile(png, 'download', broken)).toBe('failed');
    expect(await deliverFile(png, 'copy', broken)).toBe('failed');
  });
});

describe('shareCapabilities', () => {
  it('offers only what the browser can do with this file', () => {
    expect(shareCapabilities(env(), png)).toEqual({ share: true, download: true, copy: true });
    expect(shareCapabilities(env(), clip)).toEqual({ share: true, download: true, copy: false });
    expect(shareCapabilities(env({ canShare: vi.fn(() => false) }), clip).share).toBe(false);
    expect(shareCapabilities({}, png)).toEqual({ share: false, download: false, copy: false });
  });
});
