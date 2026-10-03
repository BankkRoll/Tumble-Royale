/**
 * First-launch screens: boot loader, click-to-start splash, welcome (name +
 * colour), tutorial prompt. docs/design/SCREENS.md §3.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { playCue } from '../audio-cues.ts';
import { Bar, Logo, Panel } from '../components/bits.tsx';
import { Button, Swatch } from '../components/controls.tsx';
import { TumblerAvatar } from '../components/TumblerAvatar.tsx';
import { randomTumblerName, validateDisplayName } from '../names.ts';
import { uiEvents } from '../store/events.ts';
import { useUI } from '../store/uiStore.ts';
import type { PatternId, TumblerColors } from '../store/types.ts';
import { shakeNo, squash } from '../theme/motion.ts';
import { tumblerSwatches } from '../theme/tokens.ts';
import { fireConfetti } from '../transitions/Confetti.tsx';

const BOOT_LINES = [
  'Inflating Tumblers…',
  'Waxing the slides…',
  'Teaching physics to behave…',
  'Polishing the Crown…',
  'Almost tumbling…',
];

/** Drifting cloud blobs used behind first-launch screens. */
function Clouds(): JSX.Element {
  return (
    <div className="tr-clouds" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="tr-cloud tr-loop"
          style={{
            top: `${8 + i * 17}%`,
            animationDuration: `${38 + i * 9}s`,
            animationDelay: `${-i * 11}s`,
            ['--s' as string]: String(0.6 + (i % 3) * 0.35),
          }}
        />
      ))}
    </div>
  );
}

/** Boot loader with real progress (`setBoot`). */
export function BootScreen(): JSX.Element {
  const boot = useUI((s) => s.boot);
  const line =
    boot.label || BOOT_LINES[Math.min(BOOT_LINES.length - 1, Math.floor(boot.progress * BOOT_LINES.length))];
  return (
    <div className="tr-screen tr-boot tr-sky-bg">
      <Clouds />
      <div className="tr-boot-inner">
        {boot.error ? (
          <Panel enter="pop" className="tr-boot-error">
            <TumblerAvatar
              colors={{ primary: '#ff4f9a', secondary: '#fff', pattern: 'plain' }}
              expression="dizzy"
              size="5em"
            />
            <div className="tr-title tr-h3">Something got stuck in the chute</div>
            <p className="tr-muted">{boot.error}</p>
            <Button autoFocusNav onClick={() => location.reload()}>
              Retry
            </Button>
          </Panel>
        ) : (
          <>
            <div className="tr-boot-hopper tr-loop">
              <TumblerAvatar
                colors={{ primary: '#ff6fb5', secondary: '#ffffff', pattern: 'dots' }}
                expression="grin"
                size="5em"
              />
            </div>
            <Bar value={boot.progress} large label="Loading" className="tr-boot-bar" />
            <div className="tr-boot-label">{line}</div>
          </>
        )}
      </div>
      <div className="tr-version">Tumble Royale · preview build</div>
    </div>
  );
}

/** "Press any button" splash; unlocks audio. */
export function SplashScreen(): JSX.Element {
  const fired = useRef(false);
  const logoRef = useRef<HTMLDivElement>(null);
  const start = (): void => {
    if (fired.current) return;
    fired.current = true;
    playCue('music.sting');
    playCue('ui.confirm');
    if (logoRef.current) squash(logoRef.current, 1.4);
    fireConfetti({ x: 0.5, y: 0.45, ring: true, count: 90, speed: 800 });
    uiEvents.emit('start');
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat) return;
      start();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="tr-screen tr-splash tr-sky-bg tr-interactive" onPointerDown={start}>
      <Clouds />
      <div className="tr-splash-center">
        <div ref={logoRef}>
          <Logo />
        </div>
        <div
          className="tr-chip tr-chip--lemon tr-splash-tag tr-enter-pop"
          style={{ animationDelay: '900ms' }}
        >
          40 Tumblers. 1 Crown. Zero dignity.
        </div>
      </div>
      <button
        type="button"
        className="tr-splash-prompt tr-loop"
        data-nav=""
        data-autofocus=""
        onClick={start}
      >
        Click, tap or press any button to start
      </button>
      <div className="tr-splash-footer">Original game — every Tumbler is hand-squished.</div>
    </div>
  );
}

const PATTERNS: { id: PatternId; label: string }[] = [
  { id: 'plain', label: 'Plain' },
  { id: 'stripes', label: 'Stripes' },
  { id: 'dots', label: 'Dots' },
  { id: 'checker', label: 'Checker' },
  { id: 'stars', label: 'Stars' },
];

/** Guest name + quick colour. */
export function WelcomeScreen(): JSX.Element {
  const profile = useUI((s) => s.profile);
  const placeholder = useMemo(() => randomTumblerName(), []);
  const [name, setName] = useState(profile?.isGuest === false ? profile.name : '');
  const [primary, setPrimary] = useState(profile?.colors.primary ?? tumblerSwatches[0] ?? '#ff4f9a');
  const [pattern, setPattern] = useState<PatternId>(profile?.colors.pattern ?? 'dots');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const colors: TumblerColors = {
    primary,
    secondary: primary === '#ffffff' ? '#ff4f9a' : '#ffffff',
    pattern,
  };

  useEffect(() => {
    uiEvents.emit('previewColors', { colors, pattern });
    if (previewRef.current) squash(previewRef.current, 1);
    // colors is derived from these two.
  }, [primary, pattern]);

  const submit = (): void => {
    const finalName = name.trim() || placeholder;
    const err = validateDisplayName(finalName);
    if (err) {
      setError(err);
      playCue('ui.error');
      if (formRef.current) shakeNo(formRef.current);
      return;
    }
    setBusy(true);
    playCue('ui.confirm');
    uiEvents.emit('welcomeDone', { name: finalName, colors });
  };

  return (
    <div className="tr-screen tr-welcome tr-sky-bg">
      <Clouds />
      <div className="tr-welcome-preview" ref={previewRef}>
        <div className="tr-welcome-plinth" />
        <div className="tr-welcome-avatar tr-loop">
          <TumblerAvatar colors={colors} expression="grin" size="11em" />
        </div>
      </div>
      <div className="tr-welcome-form" data-nav-scope="1">
        <Panel enter="right" tilt={1} className="tr-col" style={{ gap: '1em' }}>
          <div ref={formRef} className="tr-col" style={{ gap: '1em' }}>
            <h1 className="tr-title tr-h2">Who's tumbling?</h1>
            <label className="tr-col" style={{ gap: '0.35em' }}>
              <span className="tr-label">Your name</span>
              <span className="tr-row">
                <input
                  className="tr-input"
                  maxLength={16}
                  placeholder={placeholder}
                  value={name}
                  data-nav=""
                  data-autofocus=""
                  onChange={(e) => {
                    setName(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submit();
                  }}
                  aria-invalid={error !== null}
                />
                <Button
                  variant="secondary"
                  aria-label="Random name"
                  icon={<span>🎲</span>}
                  onClick={() => setName(randomTumblerName())}
                />
              </span>
              {error && <span className="tr-field-error">{error}</span>}
            </label>
            <div className="tr-col" style={{ gap: '0.5em' }}>
              <span className="tr-label">Pick your colour</span>
              <div className="tr-swatch-grid">
                {tumblerSwatches.slice(0, 12).map((c) => (
                  <Swatch key={c} color={c} selected={c === primary} onSelect={() => setPrimary(c)} />
                ))}
              </div>
            </div>
            <div className="tr-col" style={{ gap: '0.5em' }}>
              <span className="tr-label">Pattern</span>
              <div className="tr-row tr-wrap">
                {PATTERNS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`tr-pattern-tile${p.id === pattern ? ' is-on' : ''}`}
                    data-nav=""
                    aria-pressed={p.id === pattern}
                    onClick={() => setPattern(p.id)}
                  >
                    <TumblerAvatar
                      colors={{ ...colors, pattern: p.id }}
                      size="2.2em"
                      blink={false}
                      noShadow
                    />
                    <small>{p.label}</small>
                  </button>
                ))}
              </div>
            </div>
            <Button variant="go" size="lg" block cue={null} disabled={busy} onClick={submit}>
              {busy ? <span className="tr-gumball-spinner tr-gumball-spinner--sm" /> : "Let's go!"}
            </Button>
            <p className="tr-small tr-muted">
              You're a guest — link an account later to keep your stuff safe.
            </p>
          </div>
        </Panel>
      </div>
    </div>
  );
}

/** Optional tutorial offer. */
export function TutorialPromptScreen(): JSX.Element {
  const [dontAsk, setDontAsk] = useState(false);
  return (
    <div className="tr-screen tr-tutorial tr-center">
      <div className="tr-dim" />
      <div className="tr-tutorial-coach tr-enter-left" style={{ animationDelay: '200ms' }}>
        <TumblerAvatar
          colors={{ primary: '#3ee6b4', secondary: '#2b1a5e', pattern: 'stripes' }}
          hat="cap"
          expression="grin"
          size="9em"
        />
        <span className="tr-tutorial-whistle" aria-hidden>
          📣
        </span>
      </div>
      <Panel enter="drop" tilt={-1.5} className="tr-tutorial-card tr-col">
        <h1 className="tr-title tr-h2">Warm-up time?</h1>
        <p>
          Fancy a 2-minute warm-up on Practice Island? Coach Boing will show you the ropes — and the slides.
        </p>
        <div className="tr-row tr-wrap" style={{ justifyContent: 'center' }}>
          <Button
            variant="go"
            size="lg"
            autoFocusNav
            cue="ui.confirm"
            onClick={() => uiEvents.emit('tutorialChoice', { accept: true, dontAskAgain: dontAsk })}
          >
            Teach me!
          </Button>
          <Button
            variant="secondary"
            size="lg"
            data-nav-back=""
            cue="ui.back"
            onClick={() => uiEvents.emit('tutorialChoice', { accept: false, dontAskAgain: dontAsk })}
          >
            I'll wing it
          </Button>
        </div>
        <label className="tr-row tr-small" style={{ justifyContent: 'center', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={dontAsk}
            onChange={(e) => setDontAsk(e.target.checked)}
            data-nav=""
          />
          Don't ask again
        </label>
      </Panel>
    </div>
  );
}
