import type { NextHopCandidate } from './types';

export type RoutingStrategy = 'ble_first' | 'random_online';

export function pickNextHop(
  _candidates: NextHopCandidate[],
  _strategy: RoutingStrategy = 'ble_first'
): NextHopCandidate | null {
  return null;
}

export function scoreCandidates(candidates: NextHopCandidate[]): NextHopCandidate[] {
  return [...candidates].sort((a, b) => b.score - a.score);
}
