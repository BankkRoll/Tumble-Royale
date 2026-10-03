import type { RoundDefinitionInput } from '@tumble/shared';
import cannonballCanyon from './cannonball-canyon/index.ts';
import hammerHighway from './hammer-highway/index.ts';
import spinCycleFinale from './spin-cycle-finale/index.ts';
import spinCycle from './spin-cycle/index.ts';
import windTunnelPeaks from './wind-tunnel-peaks/index.ts';

/**
 * Rounds authored by level-builder group 2: R5 Hammer Highway, R6 Wind Tunnel
 * Peaks, R7 Cannonball Canyon, S1 Spin Cycle and F3 Spin Cycle Finale.
 */
export const ROUNDS_GROUP_2: RoundDefinitionInput[] = [
  hammerHighway,
  windTunnelPeaks,
  cannonballCanyon,
  spinCycle,
  spinCycleFinale,
];
