/**
 * Photo mode controls. While photo mode is active the overlay hides every
 * other layer; this bar is the only UI left: FOV, filter, watermark, Take
 * photo and Exit, plus the camera controls for the last-used device. The game
 * owns the camera and does the capture (`photoCapture` / `photoExit`).
 */
import { type JSX } from 'react';
import { Button, Segmented, Slider, Toggle } from '../../components/controls.tsx';
import { Icon } from '../../components/icons/index.tsx';
import { uiEvents } from '../../store/events.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import type { HudState, PhotoFilter } from '../../store/types.ts';

const FILTERS: { value: PhotoFilter; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'warm', label: 'Warm' },
  { value: 'mono', label: 'Mono' },
  { value: 'vivid', label: 'Vivid' },
];

/** Camera help per device. */
export const PHOTO_HINTS: Record<HudState['device'], string> = {
  keyboard: 'Drag to orbit · Scroll to zoom · WASD move · Q/E down/up · Esc exits',
  gamepad: 'Right stick orbit · Left stick move · LT/RT down/up · LB/RB field of view · B exits',
  touch: 'Drag to orbit · Pinch to zoom · Two-finger drag to move',
};

/** The photo mode bar. */
export function PhotoModeBar(): JSX.Element {
  const photo = useUI((s) => s.photo);
  const device = useUI((s) => s.hud.device);
  const set = ui.getState().setPhoto;
  return (
    <div
      className="tr-photo tr-interactive"
      data-nav-scope="30"
      role="toolbar"
      aria-label="Photo mode"
      data-testid="photo-mode"
    >
      <div className="tr-panel tr-photo-bar">
        <label className="tr-photo-field">
          <span className="tr-label">Field of view</span>
          <Slider
            label="Field of view"
            value={photo.fov}
            min={20}
            max={100}
            step={1}
            format={(v) => `${Math.round(v)}°`}
            onChange={(fov) => set({ fov })}
          />
        </label>
        <div className="tr-photo-field">
          <span className="tr-label">Filter</span>
          <Segmented
            label="Filter"
            value={photo.filter}
            options={FILTERS}
            onChange={(filter) => set({ filter })}
          />
        </div>
        <div className="tr-photo-field tr-photo-field--toggle">
          <span className="tr-label">Logo</span>
          <Toggle
            label="Logo watermark"
            checked={photo.watermark}
            onChange={(watermark) => set({ watermark })}
          />
        </div>
        <div className="tr-row tr-photo-actions">
          <Button
            variant="go"
            size="lg"
            autoFocusNav
            cue="ui.confirm"
            onClick={() => uiEvents.emit('photoCapture')}
          >
            <Icon name="camera" size="1.1em" /> Take photo
          </Button>
          <Button
            variant="secondary"
            data-nav-back=""
            cue="ui.back"
            onClick={() => uiEvents.emit('photoExit')}
          >
            Exit
          </Button>
        </div>
      </div>
      <p className="tr-small tr-photo-hint">{PHOTO_HINTS[device]}</p>
    </div>
  );
}
