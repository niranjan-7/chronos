export interface SlaJobPayload {
  tenantId: string;
  ticketId: string;
  policyVersion: number;
  targetDeadline: string; // ISO timestamp
  stage: 'WARNING' | 'BREACH';
}
