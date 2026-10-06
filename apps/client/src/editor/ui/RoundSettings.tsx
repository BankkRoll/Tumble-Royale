/**
 * Round settings: name, texts, type, theme, music, time limit, qualification
 * and falls.
 */
import type { JSX } from 'react';
import {
  CUSTOM_ROUND_LIMITS,
  CUSTOM_ROUND_TYPES,
  checkCustomText,
  customRoundMusic,
  type CustomRoundType,
} from '@tumble/content/custom';
import { RoundDefinitionSchema } from '@tumble/shared';
import { DraftInput, NumberInput, Row, Section, useActions, useEditor, useFieldId } from './kit.tsx';

const THEMES = RoundDefinitionSchema.shape.theme.options;
const TYPE_LABELS: Record<CustomRoundType, string> = {
  race: 'Race: reach the finish',
  survival: 'Survival: stay on until time runs out',
  hunt: 'Hunt: score points first',
  logic: 'Logic: pick the safe tiles',
};

const textError =
  (max: number, min = 0) =>
  (v: string) => {
    if ([...v.trim()].length < min) return `At least ${min} characters`;
    const c = checkCustomText(v, max);
    if (!c.ok && c.reason === 'profanity') return 'That text is not allowed';
    if (!c.ok && c.reason === 'length') return `Up to ${max} characters`;
    return null;
  };

/** The round settings panel. */
export function RoundSettings(): JSX.Element {
  const round = useEditor((s) => s.round);
  const description = useEditor((s) => s.description);
  const disabled = useEditor((s) => s.viewing !== null);
  const { edit, setType, setDescription } = useActions();
  const L = CUSTOM_ROUND_LIMITS;
  const ids = {
    name: useFieldId('name'),
    objective: useFieldId('objective'),
    desc: useFieldId('desc'),
    type: useFieldId('type'),
    theme: useFieldId('theme'),
    music: useFieldId('music'),
    fall: useFieldId('fall'),
  };
  const q = round.qualification;
  const tips = round.tips ?? [];
  return (
    <div className="ed-settings">
      <Section title="About">
        <Row label="Name" htmlFor={ids.name}>
          <DraftInput
            id={ids.name}
            value={round.name}
            maxLength={L.nameMax}
            disabled={disabled}
            validate={textError(L.nameMax, L.nameMin)}
            onCommit={(name) => edit((r) => ({ ...r, name: name.trim() }))}
          />
        </Row>
        <Row label="Objective" htmlFor={ids.objective}>
          <DraftInput
            id={ids.objective}
            value={round.objective}
            maxLength={L.objectiveMax}
            disabled={disabled}
            validate={textError(L.objectiveMax, 1)}
            onCommit={(objective) => edit((r) => ({ ...r, objective: objective.trim() }))}
          />
        </Row>
        <Row label="Share description" htmlFor={ids.desc}>
          <DraftInput
            id={ids.desc}
            value={description}
            maxLength={L.descriptionMax}
            disabled={disabled}
            validate={textError(L.descriptionMax)}
            onCommit={setDescription}
          />
        </Row>
        {[0, 1, 2].map((i) => (
          <Row key={i} label={`Tip ${i + 1}`}>
            <DraftInput
              value={tips[i] ?? ''}
              maxLength={L.tipMax}
              disabled={disabled}
              ariaLabel={`Tip ${i + 1}`}
              validate={textError(L.tipMax)}
              onCommit={(tip) =>
                edit((r) => {
                  const next = [...(r.tips ?? [])];
                  next[i] = tip.trim();
                  return { ...r, tips: next.filter((t) => t) };
                })
              }
            />
          </Row>
        ))}
      </Section>
      <Section title="Rules">
        <Row label="Round type" htmlFor={ids.type}>
          <select
            id={ids.type}
            className="ed-input"
            value={round.type}
            disabled={disabled}
            onChange={(e) => setType(e.target.value as CustomRoundType)}
          >
            {CUSTOM_ROUND_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Time limit (s)">
          <NumberInput
            value={round.duration.seconds}
            min={L.minSeconds}
            max={L.maxSeconds}
            disabled={disabled}
            onCommit={(seconds) =>
              edit((r) => ({ ...r, duration: { ...r.duration, seconds: Math.round(seconds) } }))
            }
          />
        </Row>
        <Row label="Players who qualify (%)">
          <NumberInput
            value={Math.round((q.ratio ?? 0.65) * 100)}
            min={10}
            max={90}
            disabled={disabled}
            onCommit={(pct) =>
              edit((r) => ({ ...r, qualification: { ...r.qualification, ratio: Math.round(pct) / 100 } }))
            }
          />
        </Row>
        {round.type === 'hunt' ? (
          <Row label="Points to qualify">
            <NumberInput
              value={q.scoreGoal ?? 5}
              min={1}
              max={L.maxScoreGoal}
              disabled={disabled}
              onCommit={(goal) =>
                edit((r) => ({ ...r, qualification: { ...r.qualification, scoreGoal: Math.round(goal) } }))
              }
            />
          </Row>
        ) : null}
        <Row label="Fall-out height (m)">
          <NumberInput
            value={round.killY ?? -20}
            min={-150}
            max={100}
            disabled={disabled}
            onCommit={(killY) => edit((r) => ({ ...r, killY }))}
          />
        </Row>
        {round.type === 'race' || round.type === 'hunt' ? (
          <Row label="After a fall" htmlFor={ids.fall}>
            <select
              id={ids.fall}
              className="ed-input"
              value={round.fallBehavior}
              disabled={disabled}
              onChange={(e) => edit((r) => ({ ...r, fallBehavior: e.target.value as typeof r.fallBehavior }))}
            >
              <option value="respawnCheckpoint">Respawn at the last checkpoint</option>
              <option value="eliminate">Eliminated</option>
            </select>
          </Row>
        ) : (
          <p className="ed-hint">Falling out eliminates the player in {round.type} rounds.</p>
        )}
      </Section>
      <Section title="Look and sound">
        <Row label="Theme" htmlFor={ids.theme}>
          <select
            id={ids.theme}
            className="ed-input"
            value={round.theme}
            disabled={disabled}
            onChange={(e) => edit((r) => ({ ...r, theme: e.target.value as typeof r.theme }))}
          >
            {THEMES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Music" htmlFor={ids.music}>
          <select
            id={ids.music}
            className="ed-input"
            value={round.music}
            disabled={disabled}
            onChange={(e) => edit((r) => ({ ...r, music: e.target.value }))}
          >
            {[...customRoundMusic()].map((m) => (
              <option key={m} value={m}>
                {m.replace(/^mus_/, '').replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </Row>
      </Section>
    </div>
  );
}
