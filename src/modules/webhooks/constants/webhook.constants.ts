export const WEBHOOK_DISPATCHER_QUEUE = 'webhook-dispatcher';
export const WEBHOOK_JOB_DISPATCH = 'webhook.dispatch';

export const WEBHOOK_CIRCUIT_TRIPPED_EVENT = 'webhook.circuit_tripped';
export const WEBHOOK_CIRCUIT_CLOSED_EVENT = 'webhook.circuit_closed';
export const WEBHOOK_SYSTEM_ALERT_EVENT = 'webhook.system_alert';

export const CIRCUIT_FAILURE_THRESHOLD = 10; // 10 consecutive 5xx/timeout errors
export const CIRCUIT_WINDOW_SECONDS = 300; // 5-minute rolling window (in seconds)
export const CIRCUIT_COOLDOWN_INITIAL_SECONDS = 60; // 60s cooldown when initially tripped
export const CIRCUIT_COOLDOWN_REOPEN_SECONDS = 120; // 120s cooldown if half-open probe fails
export const CIRCUIT_PROBE_LOCK_SECONDS = 30; // 30s probe execution lock
export const HTTP_HARD_TIMEOUT_MS = 5000; // 5-second hard timeout

export function getCircuitPrefix(tenantId: string, endpointId: string): string {
  return `tenant:${tenantId}:webhook:${endpointId}:circuit`;
}

export function getCircuitStateKey(tenantId: string, endpointId: string): string {
  return `${getCircuitPrefix(tenantId, endpointId)}:state`;
}

export function getCircuitFailuresKey(tenantId: string, endpointId: string): string {
  return `${getCircuitPrefix(tenantId, endpointId)}:failures`;
}

export function getCircuitOpenUntilKey(tenantId: string, endpointId: string): string {
  return `${getCircuitPrefix(tenantId, endpointId)}:open_until`;
}

export function getCircuitCooldownKey(tenantId: string, endpointId: string): string {
  return `${getCircuitPrefix(tenantId, endpointId)}:cooldown_seconds`;
}

export function getCircuitProbeLockKey(tenantId: string, endpointId: string): string {
  return `${getCircuitPrefix(tenantId, endpointId)}:probe_lock`;
}
