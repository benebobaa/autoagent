const BAD_EXIT_REASONS = new Set([
  'apy_drop',
  'stop_loss',
  'time_stop',
  'out_of_range',
  'rug_detected',
  'fee_yield_low',
  'oor_timeout',
  'pumped_past_range',
  'circuit_breaker',
]);

export function shouldStartPoolCooldown(reason: string | null | undefined): boolean {
  return reason !== null && reason !== undefined && BAD_EXIT_REASONS.has(reason);
}

export function buildCooldownUntil(nowIso: string, hours: number): string {
  return new Date(new Date(nowIso).getTime() + hours * 60 * 60 * 1000).toISOString();
}
