/**
 * Settings sheet: Graphics, Controls (keyboard and controller rebinding), Audio,
 * Accessibility, Gameplay, Account. Every change applies live and emits
 * `settingsChange`. docs/design/SCREENS.md §5.10.
 */
import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { playCue } from '../../audio-cues.ts';
import { Button, Segmented, Slider, Toggle } from '../../components/controls.tsx';
import { BIND_ACTION_LABELS, DEFAULT_KEYBINDS } from '../../store/defaults.ts';
import { uiEvents } from '../../store/events.ts';
import { ui, useUI } from '../../store/uiStore.ts';
import type { BindAction, Keybinds, SettingsSection } from '../../store/types.ts';
import { Icon } from '../../components/icons/index.tsx';
import { AccountSection } from './AccountSheet.tsx';
import { PadRebinder } from './PadRebinder.tsx';
import { semanticColors } from '../../theme/tokens.ts';

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'graphics', label: 'Graphics' },
  { id: 'controls', label: 'Controls' },
  { id: 'audio', label: 'Audio' },
  { id: 'accessibility', label: 'Accessibility' },
  { id: 'gameplay', label: 'Gameplay' },
  { id: 'account', label: 'Account' },
];

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="tr-settings-row">
      <div className="tr-col" style={{ gap: '0.1em', minWidth: 0 }}>
        <span>{label}</span>
        {hint && <small className="tr-muted">{hint}</small>}
      </div>
      {children}
    </div>
  );
}

/** Human label for a `KeyboardEvent.code` / mouse binding. */
export function keyLabel(code: string): string {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow'))
    return { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }[code] ?? code;
  const map: Record<string, string> = {
    Space: 'Space',
    ControlLeft: 'L-Ctrl',
    ControlRight: 'R-Ctrl',
    ShiftLeft: 'L-Shift',
    ShiftRight: 'R-Shift',
    AltLeft: 'L-Alt',
    Escape: 'Esc',
    Mouse0: 'LMB',
    Mouse1: 'MMB',
    Mouse2: 'RMB',
    Mouse3: 'Mouse 4',
    Mouse4: 'Mouse 5',
    Tab: 'Tab',
    Enter: 'Enter',
  };
  return map[code] ?? code;
}

function Rebinder(): JSX.Element {
  const binds = useUI((s) => s.settings.controls.keybinds);
  const [capture, setCapture] = useState<{ action: BindAction; slot: 0 | 1 } | null>(null);

  useEffect(() => {
    if (!capture) return;
    const apply = (code: string): void => {
      const next: Keybinds = { ...binds };
      const prev = next[capture.action][capture.slot];
      for (const a of Object.keys(next) as BindAction[]) {
        const pair = next[a];
        const idx = pair.indexOf(code);
        if (idx >= 0 && !(a === capture.action && idx === capture.slot)) {
          // Swap rather than leave the other action unbound.
          const swapped: [string, string] = [...pair];
          swapped[idx] = prev;
          next[a] = swapped;
          ui.getState().pushToast({
            kind: 'warning',
            title: `${keyLabel(code)} was on “${BIND_ACTION_LABELS[a]}”`,
            body: 'Swapped the two bindings.',
          });
        }
      }
      const pair: [string, string] = [...next[capture.action]];
      pair[capture.slot] = code;
      next[capture.action] = pair;
      playCue('ui.confirm');
      ui.getState().updateSettings('controls', { keybinds: next });
      setCapture(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.code === 'Escape') {
        playCue('ui.back');
        setCapture(null);
        return;
      }
      apply(e.code);
    };
    const onMouse = (e: MouseEvent): void => {
      if ((e.target as HTMLElement | null)?.closest('.tr-bind-capture')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      apply(`Mouse${e.button}`);
    };
    const timeout = window.setTimeout(() => setCapture(null), 5000);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onMouse, true);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
    };
  }, [capture, binds]);

  return (
    <div className="tr-binds">
      <div className="tr-binds-title tr-label">Keyboard and mouse</div>
      <div className="tr-binds-head">
        <span>Action</span>
        <span>Primary</span>
        <span>Secondary</span>
      </div>
      {(Object.keys(BIND_ACTION_LABELS) as BindAction[]).map((a) => (
        <div key={a} className="tr-binds-row">
          <span>{BIND_ACTION_LABELS[a]}</span>
          {([0, 1] as const).map((slot) => {
            const active = capture?.action === a && capture.slot === slot;
            return (
              <button
                key={slot}
                type="button"
                className={`tr-bind${active ? ' tr-bind-capture' : ''}`}
                data-nav=""
                onClick={() => {
                  playCue('ui.click');
                  setCapture({ action: a, slot });
                }}
              >
                {active ? 'Press a key…' : keyLabel(binds[a][slot])}
              </button>
            );
          })}
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => ui.getState().updateSettings('controls', { keybinds: DEFAULT_KEYBINDS })}
      >
        Reset to defaults
      </Button>
    </div>
  );
}

function Section({ id }: { id: SettingsSection }): JSX.Element {
  const s = useUI((st) => st.settings);
  const up = ui.getState().updateSettings;
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  switch (id) {
    case 'graphics':
      return (
        <>
          <Row label="Quality preset">
            <Segmented
              label="Quality"
              value={s.graphics.quality}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Med' },
                { value: 'high', label: 'High' },
                { value: 'ultra', label: 'Ultra' },
              ]}
              onChange={(quality) => up('graphics', { quality })}
            />
          </Row>
          <Row label="Resolution scale">
            <Slider
              label="Resolution scale"
              value={s.graphics.resolutionScale}
              min={0.5}
              max={1}
              step={0.05}
              format={pct}
              onChange={(resolutionScale) => up('graphics', { resolutionScale })}
            />
          </Row>
          <Row label="FPS cap">
            <Segmented
              label="FPS cap"
              value={s.graphics.fpsCap}
              options={[
                { value: 30, label: '30' },
                { value: 60, label: '60' },
                { value: 120, label: '120' },
                { value: 0, label: 'Off' },
              ]}
              onChange={(fpsCap) => up('graphics', { fpsCap })}
            />
          </Row>
          <Row label="Shadows">
            <Toggle
              label="Shadows"
              checked={s.graphics.shadows}
              onChange={(shadows) => up('graphics', { shadows })}
            />
          </Row>
          <Row label="Post effects" hint="Bloom, outlines, colour grading">
            <Toggle
              label="Post effects"
              checked={s.graphics.postFx}
              onChange={(postFx) => up('graphics', { postFx })}
            />
          </Row>
          <Row label="Show FPS">
            <Toggle
              label="Show FPS"
              checked={s.graphics.showFps}
              onChange={(showFps) => up('graphics', { showFps })}
            />
          </Row>
        </>
      );
    case 'controls':
      return (
        <>
          <Row label="Camera sensitivity">
            <Slider
              label="Camera sensitivity"
              value={s.controls.mouseSensitivity}
              min={0.2}
              max={3}
              step={0.05}
              format={(v) => `×${v.toFixed(2)}`}
              onChange={(mouseSensitivity) => up('controls', { mouseSensitivity })}
            />
          </Row>
          <Row label="Lock mouse to camera" hint="Moving or clicking in a round grabs the mouse; Esc lets go">
            <Toggle
              label="Lock mouse to camera"
              checked={s.controls.mouseLock}
              onChange={(mouseLock) => up('controls', { mouseLock })}
            />
          </Row>
          <Row label="Invert camera Y">
            <Toggle
              label="Invert Y"
              checked={s.controls.invertY}
              onChange={(invertY) => up('controls', { invertY })}
            />
          </Row>
          <Row label="Toggle grab" hint="Press once instead of holding">
            <Toggle
              label="Toggle grab"
              checked={s.controls.toggleGrab}
              onChange={(toggleGrab) => up('controls', { toggleGrab })}
            />
          </Row>
          <Row label="Controller vibration">
            <Toggle
              label="Vibration"
              checked={s.controls.vibration}
              onChange={(vibration) => up('controls', { vibration })}
            />
          </Row>
          <Row label="Touch buttons side">
            <Segmented
              label="Touch layout"
              value={s.controls.touchLayout}
              options={[
                { value: 'right', label: 'Right' },
                { value: 'left', label: 'Left' },
              ]}
              onChange={(touchLayout) => up('controls', { touchLayout })}
            />
          </Row>
          <Row label="Touch button size">
            <Slider
              label="Touch button size"
              value={s.controls.touchButtonScale}
              min={0.7}
              max={1.5}
              step={0.05}
              format={pct}
              onChange={(touchButtonScale) => up('controls', { touchButtonScale })}
            />
          </Row>
          <Rebinder />
          <PadRebinder />
        </>
      );
    case 'audio':
      return (
        <>
          {(['master', 'music', 'sfx', 'ui', 'announcer'] as const).map((k) => (
            <Row
              key={k}
              label={
                {
                  master: 'Master',
                  music: 'Music',
                  sfx: 'Sound effects',
                  ui: 'Menu sounds',
                  announcer: 'Announcer',
                }[k]
              }
            >
              <Slider
                label={k}
                value={s.audio[k]}
                min={0}
                max={1}
                step={0.05}
                format={pct}
                onChange={(v) => up('audio', { [k]: v })}
              />
            </Row>
          ))}
          <Row label="Mute when unfocused">
            <Toggle
              label="Mute when unfocused"
              checked={s.audio.muteUnfocused}
              onChange={(muteUnfocused) => up('audio', { muteUnfocused })}
            />
          </Row>
        </>
      );
    case 'accessibility':
      return (
        <>
          <Row label="Colour-blind mode">
            <div className="tr-col" style={{ gap: '0.4em', alignItems: 'flex-end' }}>
              <Segmented
                label="Colour-blind mode"
                value={s.accessibility.colorBlind}
                options={[
                  { value: 'off', label: 'Off' },
                  { value: 'protanopia', label: 'Protan' },
                  { value: 'deuteranopia', label: 'Deutan' },
                  { value: 'tritanopia', label: 'Tritan' },
                ]}
                onChange={(colorBlind) => up('accessibility', { colorBlind })}
              />
              <div className="tr-row" aria-label="Palette preview">
                {(['good', 'bad', 'warn'] as const).map((k) => (
                  <span
                    key={k}
                    className="tr-cb-swatch"
                    style={{ background: semanticColors[s.accessibility.colorBlind][k] }}
                    title={k}
                  />
                ))}
                {semanticColors[s.accessibility.colorBlind].teams.map((c, i) => (
                  <span key={i} className="tr-cb-swatch is-team" style={{ background: c }} />
                ))}
              </div>
            </div>
          </Row>
          <Row label="Reduce motion" hint="No bouncing, spinning or screen wipes">
            <Toggle
              label="Reduce motion"
              checked={s.accessibility.reduceMotion}
              onChange={(reduceMotion) => up('accessibility', { reduceMotion })}
            />
          </Row>
          <Row label="Reduce flashing" hint="No strobes; calmer confetti">
            <Toggle
              label="Reduce flashing"
              checked={s.accessibility.reduceFlashing}
              onChange={(reduceFlashing) => up('accessibility', { reduceFlashing })}
            />
          </Row>
          <Row label="Reduce camera shake">
            <Toggle
              label="Reduce shake"
              checked={s.accessibility.reduceShake}
              onChange={(reduceShake) => up('accessibility', { reduceShake })}
            />
          </Row>
          <Row label="Captions" hint="Announcer lines as text">
            <Toggle
              label="Captions"
              checked={s.accessibility.captions}
              onChange={(captions) => up('accessibility', { captions })}
            />
          </Row>
          <Row label="Spoken announcer" hint="Read announcer lines aloud">
            <Toggle
              label="Spoken announcer"
              checked={s.accessibility.spokenAnnouncer}
              onChange={(spokenAnnouncer) => up('accessibility', { spokenAnnouncer })}
            />
          </Row>
          <Row label="UI scale">
            <Slider
              label="UI scale"
              value={s.accessibility.uiScale}
              min={0.8}
              max={1.4}
              step={0.05}
              format={pct}
              onChange={(uiScale) => up('accessibility', { uiScale })}
            />
          </Row>
          <Row label="High-contrast HUD">
            <Toggle
              label="High-contrast HUD"
              checked={s.accessibility.highContrastHud}
              onChange={(highContrastHud) => up('accessibility', { highContrastHud })}
            />
          </Row>
        </>
      );
    case 'gameplay':
      return (
        <>
          <Row label="Nameplates">
            <Toggle
              label="Nameplates"
              checked={s.gameplay.nameplates}
              onChange={(nameplates) => up('gameplay', { nameplates })}
            />
          </Row>
          <Row label="Streamer mode" hint="Hides other players' names and lobby codes">
            <Toggle
              label="Streamer mode"
              checked={s.gameplay.streamerMode}
              onChange={(streamerMode) => up('gameplay', { streamerMode })}
            />
          </Row>
          <Row label="Show ping">
            <Toggle
              label="Show ping"
              checked={s.gameplay.showPing}
              onChange={(showPing) => up('gameplay', { showPing })}
            />
          </Row>
          <Row label="Auto-spectate" hint="Keep watching the show after you qualify or get knocked out">
            <Toggle
              label="Auto-spectate"
              checked={s.gameplay.autoSpectate}
              onChange={(autoSpectate) => up('gameplay', { autoSpectate })}
            />
          </Row>
          <Row label="Show bot tags" hint="Marks computer-controlled players with a small BOT tag">
            <Toggle
              label="Show bot tags"
              checked={s.gameplay.botTags}
              onChange={(botTags) => up('gameplay', { botTags })}
            />
          </Row>
          <Row label="Show chat" hint="Off hides chat and quick pings from other players">
            <Toggle
              label="Show chat"
              checked={s.gameplay.showChat}
              onChange={(showChat) => up('gameplay', { showChat })}
            />
          </Row>
          <Row label="Chat filter" hint="Masks swearing. Slurs are always hidden">
            <Toggle
              label="Chat filter"
              checked={s.gameplay.chatFilter}
              onChange={(chatFilter) => up('gameplay', { chatFilter })}
            />
          </Row>
          <RegionRow />
        </>
      );
    case 'account':
      return <AccountSection />;
  }
}

const REGION_LABELS: [string, string][] = [
  ['eu', 'EU'],
  ['na', 'NA'],
  ['sa', 'SA'],
  ['asia', 'Asia'],
  ['oce', 'OCE'],
];

/** Region picker with the measured ping next to each region; Auto shows what it picked. */
export function RegionRow(): JSX.Element {
  const region = useUI((s) => s.settings.gameplay.region);
  const status = useUI((s) => s.regionStatus);
  useEffect(() => uiEvents.emit('probeRegions'), []);
  const ms = (id: string): string => {
    const v = status.pings[id];
    return v === undefined ? '' : ` ${v} ms`;
  };
  const autoName = REGION_LABELS.find(([id]) => id === status.auto)?.[1] ?? status.auto?.toUpperCase();
  const autoLabel = autoName ? `Auto (${autoName})` : 'Auto';
  return (
    <Row
      label="Region"
      hint={status.probing ? 'Measuring ping…' : 'Auto picks the lowest ping, or guesses from your time zone'}
    >
      <Segmented
        label="Region"
        value={region}
        options={[
          { value: 'auto', label: autoLabel },
          ...REGION_LABELS.map(([value, label]) => ({ value, label: label + ms(value) })),
        ]}
        onChange={(next) => ui.getState().updateSettings('gameplay', { region: next })}
      />
    </Row>
  );
}

/** Opened from the in-round menu, Settings closes back to it. */
function closeSettings(): void {
  ui.getState().setOverlay(ui.getState().screen === 'round' ? 'inGameMenu' : 'none');
}

let requestedSection: SettingsSection | null = null;

/**
 * Opens Settings on the Account section, where guests link a sign-in method
 * (e.g. when Gem checkout answers `account_required`).
 */
export function openAccountSettings(): void {
  requestedSection = 'account';
  ui.getState().setOverlay('settings');
}

/** Settings overlay sheet. */
export function SettingsSheet(): JSX.Element {
  const [section, setSection] = useState<SettingsSection>(() => requestedSection ?? 'graphics');
  // Cleared after mount, not in the initializer, which StrictMode runs twice.
  useEffect(() => {
    requestedSection = null;
  }, []);
  return (
    <div
      className="tr-sheet-wrap tr-interactive"
      data-nav-scope="10"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      <div className="tr-dim" onClick={() => closeSettings()} />
      <aside className="tr-sheet tr-settings">
        <div className="tr-sheet-head">
          <h2 className="tr-title tr-h2 tr-grow">Settings</h2>
          <button
            type="button"
            className="tr-close"
            data-nav=""
            data-nav-back=""
            aria-label="Close settings"
            onClick={() => {
              playCue('ui.back');
              closeSettings();
            }}
          >
            <Icon name="close" size="1em" />
          </button>
        </div>
        <div className="tr-settings-tabs" role="tablist" data-nav-tabs="">
          {SECTIONS.map((sec) => (
            <button
              key={sec.id}
              type="button"
              role="tab"
              aria-selected={sec.id === section}
              className={`tr-settings-tab${sec.id === section ? ' is-active' : ''}`}
              data-nav=""
              data-autofocus={sec.id === section ? '' : undefined}
              onClick={() => {
                playCue('ui.tab');
                setSection(sec.id);
              }}
            >
              <span className="tr-settings-tab-label">{sec.label}</span>
            </button>
          ))}
        </div>
        <div key={section} className="tr-settings-body tr-scroll tr-enter-fade">
          <Section id={section} />
        </div>
      </aside>
    </div>
  );
}
