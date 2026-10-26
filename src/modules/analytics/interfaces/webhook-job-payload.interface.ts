export interface WebhookJobPayload {
  deliveryId: string;
  subscriptionId: string;
  tenantId: string;
  url: string;
  secret: string;
  event: string;
  payload: Record<string, unknown>;
}
