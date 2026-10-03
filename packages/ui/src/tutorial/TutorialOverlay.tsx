/**
 * Practice Island overlay: intro title card, objective checklist, the
 * objective prompt with the player's real bindings, the coach's speech bubble
 * (text only — the coach never speaks aloud), success bursts, the skip
 * button + confirm, and the "You're ready!" card.
 */
import { memo, useEffect, useRef, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { playCue } from '../audio-cues.ts';
import { TumblerAvatar } from '../components/TumblerAvatar.tsx';
import { Button } from '../components/controls.tsx';
import { useUI } from '../store/uiStore.ts';
import { squash } from '../theme/motion.ts';
import { TutorialIcon } from './icons.tsx';
import { onCoachAnchor, tutorialEvents, tutorialUi, useTutorialUI, type PromptPart } from './store.ts';

/** Coach Boing's look (matches the tutorial prompt screen). */
const COACH_COLORS = { primary: '#3ee6b4', secondary: '#2b1a5e', pattern: 'stripes' } as const;

/** Input chips (`<kbd>`), joined with a slash. */
export function KeyChips({ keys }: { keys: readonly string[] }): JSX.Element {
  return (
    <span className="tt-keys">
      {keys.map((k, i) => (
        <span key={`${k}-${i}`} className="tt-keys-item">
          {i > 0 && <span className="tt-keys-or">/</span>}
          <kbd className="tt-key">{k}</kbd>
        </span>
      ))}
    </span>
  );
}

/** Prompt text with inline key chips. */
export function PromptText({ parts }: { parts: readonly PromptPart[] }): JSX.Element {
  return (
    <>
      {parts.map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span> : <KeyChips key={i} keys={p.keys} />))}
    </>
  );
}

const TitleCard = memo(function TitleCard(): JSX.Element | null {
  const title = useTutorialUI((s) => s.title);
  if (!title) return null;
  return (
    <div className="tt-title-card" aria-live="polite">
      <div className="tt-title-coach">
        <TumblerAvatar colors={COACH_COLORS} hat="cap" expression="grin" size="7em" />
      </div>
      <h1 className="tr-title tr-title--lemon tt-title-main">{title.title}</h1>
      <p className="tt-title-sub">{title.subtitle}</p>
      {title.skipKeys.length > 0 && (
        <p className="tt-title-skip">
          <KeyChips keys={title.skipKeys} /> skip intro
        </p>
      )}
    </div>
  );
});

const Checklist = memo(function Checklist(): JSX.Element | null {
  const { steps, phase } = useTutorialUI(useShallow((s) => ({ steps: s.steps, phase: s.phase })));
  if (steps.length === 0 || (phase !== 'practice' && phase !== 'intro')) return null;
  const done = steps.filter((s) => s.state === 'done').length;
  return (
    <div className="tt-checklist" aria-label={`Practice Island: ${done} of ${steps.length} done`}>
      <div className="tt-checklist-head">
        <span className="tr-label">Practice Island</span>
        <span className="tt-checklist-count">
          {done}/{steps.length}
        </span>
      </div>
      <ol className="tt-checklist-list">
        {steps.map((s) => (
          <li key={s.id} className={`tt-step is-${s.state}`}>
            <span className="tt-step-icon" aria-hidden>
              <TutorialIcon name={s.state === 'done' ? 'done' : s.icon} />
            </span>
            <span className="tt-step-label">{s.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
});

const PromptCard = memo(function PromptCard(): JSX.Element | null {
  const prompt = useTutorialUI((s) => s.prompt);
  const touch = useTutorialUI((s) => s.device === 'touch');
  if (!prompt) return null;
  return (
    <div key={prompt.id} className={`tt-prompt${touch ? ' is-touch' : ''}`} role="status" aria-live="polite">
      <span className="tt-prompt-icon" aria-hidden>
        <TutorialIcon name={prompt.icon} />
      </span>
      <div className="tt-prompt-body">
        <div className="tt-prompt-title">{prompt.title}</div>
        <div className="tt-prompt-text">
          <PromptText parts={prompt.parts} />
        </div>
        {prompt.hint && (
          <div className="tt-prompt-hint">
            <span className="tt-prompt-hint-tag">Tip</span>
            <PromptText parts={prompt.hint} />
          </div>
        )}
      </div>
    </div>
  );
});

const CoachBubble = memo(function CoachBubble(): JSX.Element | null {
  const coach = useTutorialUI((s) => s.coach);
  const phase = useTutorialUI((s) => s.phase);
  const docked = useTutorialUI((s) => s.coachDocked);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!coach) return;
    return onCoachAnchor((a) => {
      const el = ref.current;
      if (!el) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Off screen or behind the camera: dock the bubble beside the prompt with the coach's face.
      const onScreen = !docked && a.visible && a.x > -40 && a.x < vw + 40 && a.y > 0 && a.y < vh;
      el.classList.toggle('is-docked', !onScreen);
      if (!onScreen) {
        el.style.transform = '';
        return;
      }
      const x = Math.max(12, Math.min(vw - w - 12, a.x - w / 2));
      const y = Math.max(12, Math.min(vh * 0.62 - h, a.y - h - 14));
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      el.style.setProperty('--tail-x', `${Math.max(18, Math.min(w - 18, a.x - x)).toFixed(1)}px`);
    });
  }, [coach, docked]);
  if (!coach || phase === 'hidden' || phase === 'ready') return null;
  return (
    <div ref={ref} className={`tt-bubble is-${coach.mood}`} aria-live="polite">
      <div key={coach.seq} className="tt-bubble-inner">
        <span className="tt-bubble-face" aria-hidden>
          <TumblerAvatar colors={COACH_COLORS} hat="cap" expression={coach.mood === 'cheer' ? 'cheer' : 'grin'} size="2.4em" blink={false} noShadow />
        </span>
        <span className="tt-bubble-name">Coach Boing</span>
        <span className="tt-bubble-text">{coach.text}</span>
      </div>
    </div>
  );
});

const SuccessBurst = memo(function SuccessBurst(): JSX.Element | null {
  const success = useTutorialUI((s) => s.success);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (success && ref.current) squash(ref.current, 1.2);
  }, [success]);
  if (!success) return null;
  return (
    <div key={success.seq} ref={ref} className="tt-success" aria-hidden>
      <span className="tr-title tr-title--mint">{success.text}</span>
    </div>
  );
});

const SkipControls = memo(function SkipControls(): JSX.Element | null {
  const { phase, confirm, keys } = useTutorialUI(useShallow((s) => ({ phase: s.phase, confirm: s.skipConfirm, keys: s.skipKeys })));
  if (phase === 'hidden' || phase === 'ready') return null;
  return (
    <>
      <div className="tt-skip">
        <Button variant="ghost" size="sm" hint={keys.join(' / ')} cue="ui.back" onClick={() => tutorialUi.setState({ skipConfirm: true })}>
          Skip tutorial
        </Button>
      </div>
      {confirm && (
        <div className="tt-modal" role="dialog" aria-modal="true" aria-label="Skip Practice Island?">
          <div className="tr-panel tt-modal-card tr-enter-pop tr-interactive">
            <h2 className="tr-title tr-h3">Skip Practice Island?</h2>
            <p>No worries: your first show is extra gentle, and plenty of the bots are clumsy too!</p>
            <div className="tt-modal-actions">
              <Button variant="go" cue="ui.confirm" hint={keys[0]} onClick={() => tutorialEvents.emit('skip', {})}>
                Skip
              </Button>
              <Button variant="secondary" cue="ui.back" onClick={() => tutorialUi.setState({ skipConfirm: false })}>
                Keep practising
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
});

const ReadyCard = memo(function ReadyCard(): JSX.Element | null {
  const ready = useTutorialUI((s) => s.ready);
  const pad = useTutorialUI((s) => s.device === 'gamepad');
  const colors = useUI((s) => s.profile?.colors);
  useEffect(() => {
    if (ready) playCue('ui.reward');
  }, [ready]);
  if (!ready) return null;
  return (
    <div className="tt-modal tt-ready" role="dialog" aria-modal="true" aria-label="You're ready!">
      <div className="tr-panel tt-ready-card tr-enter-drop tr-interactive">
        <div className="tt-ready-avatars" aria-hidden>
          <TumblerAvatar colors={COACH_COLORS} hat="cap" expression="cheer" size="5.5em" />
          {colors && <TumblerAvatar colors={colors} expression="cheer" size="5.5em" />}
        </div>
        <h1 className="tr-title tr-title--lemon tr-h1 tt-ready-title">You're ready!</h1>
        <p className="tt-ready-line">{ready.raceLine}</p>
        <div className="tt-ready-rewards">
          {ready.xp > 0 && <span className="tr-chip tr-chip--lemon">+{ready.xp} XP</span>}
          {ready.unlock && (
            <span className="tr-chip tr-chip--mint">
              <TutorialIcon name={ready.unlock.icon} /> {ready.unlock.name} {ready.unlock.kind}
            </span>
          )}
          {ready.repeat && <span className="tr-chip">Practice makes perfect!</span>}
        </div>
        <div className="tt-modal-actions">
          <Button variant="go" size="lg" autoFocusNav cue="ui.confirm" hint={pad ? 'Ⓐ' : 'Enter'} onClick={() => tutorialEvents.emit('readyChoice', { next: 'show' })}>
            Play a show!
          </Button>
          <Button variant="secondary" size="lg" cue="ui.back" hint={pad ? 'Ⓑ' : 'Esc'} onClick={() => tutorialEvents.emit('readyChoice', { next: 'menu' })}>
            Main menu
          </Button>
        </div>
      </div>
    </div>
  );
});

/**
 * The whole tutorial overlay. Rendered by {@link mountTutorialOverlay}.
 */
export function TutorialOverlay(): JSX.Element | null {
  const phase = useTutorialUI((s) => s.phase);
  const a = useUI((s) => s.settings.accessibility);
  if (phase === 'hidden') return null;
  return (
    <div
      className={`tr-root tt-root is-${phase}`}
      data-reduce-motion={String(a.reduceMotion)}
      style={{ ['--ui-scale' as string]: String(a.uiScale) }}
    >
      <TitleCard />
      <Checklist />
      <CoachBubble />
      <PromptCard />
      <SuccessBurst />
      <SkipControls />
      <ReadyCard />
    </div>
  );
}
