import type { RoundDefinition } from '@tumble/shared';

/**
 * Number of players a round lets through.
 *
 * - Finals (`lastStanding`, `crownGrab`, or a round of type `final`): exactly 1.
 * - Team rounds: everyone on the surviving teams, assuming balanced teams.
 * - Everything else: `ceil(entrants × ratio)`, clamped so at least one player
 *   qualifies and, with two or more entrants, at least one is eliminated.
 *
 * @param round - The round definition.
 * @param entrants - Players starting the round.
 * @param override - Explicit target from the show director, clamped the same way.
 * @returns The qualification target.
 * @example
 * computeQualifyTarget(race, 40); // 26 with the default 0.65 ratio
 */
export function computeQualifyTarget(round: RoundDefinition, entrants: number, override?: number): number {
  if (entrants <= 0) return 0;
  const mode = round.qualification.mode;
  if (mode === 'lastStanding' || mode === 'crownGrab' || round.type === 'final') return 1;
  if (override !== undefined) return clampTarget(Math.round(override), entrants);
  if (mode === 'teamScore') {
    const teams = Math.max(2, round.qualification.teams || 2);
    const surviving = Math.max(1, teams - round.qualification.teamsEliminated);
    return clampTarget(Math.round((entrants * surviving) / teams), entrants);
  }
  return clampTarget(Math.ceil(entrants * round.qualification.ratio), entrants);
}

function clampTarget(n: number, entrants: number): number {
  const max = entrants >= 2 ? entrants - 1 : 1;
  return Math.max(1, Math.min(max, n));
}
