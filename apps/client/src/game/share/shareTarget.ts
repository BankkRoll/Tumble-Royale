/**
 * Getting a finished card or clip off the device, entirely client side.
 *
 * Order for "Share": the Web Share API with files (level 2) where the
 * browser can share that file type, else a download, else (images only) a
 * clipboard copy. "Save" and "Copy" go straight to their own path. Nothing
 * is ever uploaded.
 *
 * The browser surface is injected ({@link ShareEnv}) so every fallback is
 * unit-tested without a browser.
 */

/** What happened to the file. */
export type ShareOutcome = 'shared' | 'downloaded' | 'copied' | 'cancelled' | 'failed' | 'unsupported';

/** What the player asked for. */
export type ShareAction = 'share' | 'download' | 'copy';

/** The browser features delivery uses; a missing member means "not supported". */
export interface ShareEnv {
  canShare?: (data: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
  /** Triggers a download; false when the browser cannot download files. */
  download?: (blob: Blob, name: string) => boolean;
  /** Puts an image on the clipboard. */
  copyImage?: (blob: Blob) => Promise<void>;
}

/** Which buttons the share sheet can offer for a file. */
export interface ShareCapabilities {
  share: boolean;
  download: boolean;
  copy: boolean;
}

/**
 * What the current browser can do with a file.
 *
 * @param env - Browser surface.
 * @param file - The card or clip.
 */
export function shareCapabilities(env: ShareEnv, file: File): ShareCapabilities {
  let share: boolean;
  try {
    share = !!env.share && !!env.canShare && env.canShare({ files: [file] });
  } catch {
    share = false;
  }
  return {
    share,
    download: !!env.download,
    copy: !!env.copyImage && file.type === 'image/png',
  };
}

function errorName(err: unknown): string {
  return err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
}

async function download(env: ShareEnv, file: File): Promise<ShareOutcome> {
  try {
    return env.download?.(file, file.name) ? 'downloaded' : 'unsupported';
  } catch {
    return 'failed';
  }
}

async function copy(env: ShareEnv, file: File): Promise<ShareOutcome> {
  if (!env.copyImage || file.type !== 'image/png') return 'unsupported';
  try {
    await env.copyImage(file);
    return 'copied';
  } catch {
    return 'failed';
  }
}

/**
 * Delivers a file.
 *
 * IMPORTANT: call this synchronously from the click handler. `navigator.share`
 * needs the click's user activation, and it is invoked before the first
 * `await` here so the activation is still live.
 *
 * @param file - The card PNG or the clip video.
 * @param action - Share (with fallbacks), download or copy.
 * @param env - Browser surface (see {@link browserShareEnv}).
 * @param text - Share sheet title/text.
 * @returns The outcome; a dismissed share sheet is `cancelled` and does not fall back.
 * @example
 * const outcome = await deliverFile(file, 'share', browserShareEnv(), { title: 'Crowned!' });
 */
export async function deliverFile(
  file: File,
  action: ShareAction,
  env: ShareEnv,
  text: { title?: string; text?: string } = {},
): Promise<ShareOutcome> {
  if (action === 'download') return download(env, file);
  if (action === 'copy') return copy(env, file);
  const caps = shareCapabilities(env, file);
  if (caps.share && env.share) {
    try {
      await env.share({ files: [file], ...text });
      return 'shared';
    } catch (err) {
      if (errorName(err) === 'AbortError') return 'cancelled';
      // NotAllowedError (activation expired, permission policy) or a failed share: fall through.
    }
  }
  const saved = await download(env, file);
  if (saved !== 'unsupported') return saved;
  return copy(env, file);
}

/**
 * The real browser's share surface.
 *
 * @param nav - Usually `navigator`.
 * @param doc - Usually `document`.
 */
export function browserShareEnv(nav: Navigator = navigator, doc: Document = document): ShareEnv {
  const env: ShareEnv = {};
  if (typeof nav.share === 'function' && typeof nav.canShare === 'function') {
    env.share = (data) => nav.share(data);
    env.canShare = (data) => nav.canShare(data);
  }
  // COMPAT: some in-app browsers drop the download attribute; there the clipboard is the last resort.
  if ('download' in HTMLAnchorElement.prototype) {
    env.download = (blob, name) => {
      const url = URL.createObjectURL(blob);
      const a = doc.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      doc.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return true;
    };
  }
  if (typeof ClipboardItem !== 'undefined' && typeof nav.clipboard?.write === 'function') {
    env.copyImage = (blob) => nav.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
  }
  return env;
}
