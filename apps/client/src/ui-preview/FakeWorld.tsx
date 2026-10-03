/**
 * Stand-in for the three.js canvas: an animated candy sky with floating
 * islands, plus a scene that roughly matches the screen (lobby platform with
 * your Tumbler, a scrolling course during rounds, a stadium for the wall).
 * Purely cosmetic; it lets the overlay be judged against something moving.
 */
import type { JSX } from 'react';
import { TumblerAvatar } from '@tumble/ui/components';
import { useUI } from '@tumble/ui';

const LOBBY = new Set([
  'menu',
  'matchmaking',
  'welcome',
  'tutorialPrompt',
  'customLobby',
  'matchHistory',
  'preShow',
  'splash',
]);
const COURSE = new Set(['round', 'roundIntro', 'rules']);

/** Fake 3D backdrop. */
export function FakeWorld(): JSX.Element {
  const screen = useUI((s) => s.screen);
  const colors = useUI((s) => s.profile?.colors) ?? {
    primary: '#ff4f9a',
    secondary: '#fff',
    pattern: 'dots' as const,
  };
  const members = useUI((s) => s.party?.members);
  const party = members?.filter((m) => !m.isSelf) ?? [];
  const tab = useUI((s) => s.menuTab);
  const crowd = useUI((s) => s.preShow?.playersJoined ?? 0);

  return (
    <div className={`fw fw--${screen}`}>
      <div className="fw-sky" />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className="fw-island"
          style={{
            left: `${(i * 23) % 100}%`,
            top: `${10 + ((i * 37) % 55)}%`,
            animationDelay: `${-i * 3}s`,
            transform: `scale(${0.5 + (i % 3) * 0.3})`,
          }}
        />
      ))}
      {LOBBY.has(screen) && (
        <div className={`fw-lobby fw-lobby--${tab}`}>
          <div className="fw-platform" />
          <div className="fw-me">
            <TumblerAvatar colors={colors} expression="happy" size="9em" />
          </div>
          {party.map((m, i) => (
            <div
              key={m.id}
              className="fw-mate"
              style={{ left: `${i === 0 ? 30 : 70}%`, animationDelay: `${i * 0.4}s` }}
            >
              <TumblerAvatar colors={m.colors} expression="grin" size="5.5em" />
            </div>
          ))}
          {screen === 'preShow' &&
            Array.from({ length: Math.min(30, crowd) }, (_, i) => (
              <div
                key={i}
                className="fw-crowd"
                style={{
                  left: `${8 + ((i * 29) % 84)}%`,
                  bottom: `${18 + ((i * 13) % 16)}%`,
                  animationDelay: `${(i % 7) * 0.13}s`,
                }}
              >
                <TumblerAvatar
                  colors={{
                    primary: ['#ffd23f', '#3ee6b4', '#8a5cff', '#ff8a3d', '#5aa9ff'][i % 5] ?? '#fff',
                    secondary: '#fff',
                    pattern: 'plain',
                  }}
                  size="2.6em"
                  blink={false}
                />
              </div>
            ))}
        </div>
      )}
      {COURSE.has(screen) && (
        <div className="fw-course">
          <div className="fw-floor" />
          <div className="fw-runner">
            <TumblerAvatar colors={colors} expression="determined" size="6em" />
          </div>
        </div>
      )}
    </div>
  );
}
