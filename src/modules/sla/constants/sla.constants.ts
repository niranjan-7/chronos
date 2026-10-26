export const SLA_MONITOR_QUEUE = 'sla-monitor';

export const SLA_JOB_WARNING = 'sla.warning';
export const SLA_JOB_BREACH = 'sla.breach';

/**
 * Deterministic BullMQ job ID generators for O(1) lookup and cancellation.
 * Uses hyphen separators to comply with BullMQ v5 ID character constraints (no colons).
 */
export const getSlaWarningJobId = (tenantId: string, ticketId: string): string =>
  `sla-warn-${tenantId}-${ticketId}`;

export const getSlaBreachJobId = (tenantId: string, ticketId: string): string =>
  `sla-breach-${tenantId}-${ticketId}`;
