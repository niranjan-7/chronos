export interface WebhookJobPayload {
  deliveryId: string;
  endpointId: string;
  tenantId: string;
  url: string;
  secret: string;
  event: string;
  payload: Record<string, unknown>;
}
