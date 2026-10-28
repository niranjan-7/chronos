import axios, { AxiosInstance } from 'axios';
import { LiveDashboardMetrics, Ticket, TicketStatus } from '../types/telemetry';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export const apiClient: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

let currentTenantId: string = 'a03a3200-b6ed-4314-b1d5-a24099a62f9a';
let currentToken: string = '';

export function updateApiClientContext(tenantId: string, token: string): void {
  currentTenantId = tenantId;
  currentToken = token;
}

apiClient.interceptors.request.use((config) => {
  if (currentTenantId) {
    config.headers['x-tenant-id'] = currentTenantId;
  }
  if (currentToken) {
    config.headers['Authorization'] = `Bearer ${currentToken}`;
  }
  return config;
});

// Telemetry & Dashboard APIs
export async function fetchLiveDashboardMetrics(): Promise<LiveDashboardMetrics> {
  const { data } = await apiClient.get<LiveDashboardMetrics>('/analytics/dashboard');
  return data;
}

// Tickets & Routing APIs
export async function claimNextTicket(payload?: {
  agentId?: string;
  requiredSkills?: string[];
}): Promise<Ticket> {
  const { data } = await apiClient.post<{ claimed: boolean; ticket?: Ticket }>('/tickets/claim-next', payload || {});
  if (!data?.ticket) {
    throw new Error('No eligible tickets in queue for claiming.');
  }
  return data.ticket;
}

export async function fetchTickets(params?: {
  status?: string;
  priority?: string;
  limit?: number;
}): Promise<Ticket[]> {
  const { data } = await apiClient.get<Ticket[] | { items: Ticket[]; total: number }>('/tickets', { params });
  if (Array.isArray(data)) {
    return data;
  }
  return data?.items || [];
}

export async function fetchTicketById(id: string): Promise<Ticket> {
  const { data } = await apiClient.get<Ticket>(`/tickets/${id}`);
  return data;
}

export async function transitionTicket(
  id: string,
  newStatus: TicketStatus,
  reason?: string,
): Promise<Ticket> {
  const { data } = await apiClient.post<Ticket>(`/tickets/${id}/transition`, {
    status: newStatus,
    reason,
  });
  return data;
}

// Business Calendars & Holidays APIs
export async function fetchTenantCalendar(tenantId: string): Promise<Record<string, unknown>> {
  const { data } = await apiClient.get<Record<string, unknown>>(`/tenants/${tenantId}/calendar`);
  return data;
}

export async function updateTenantCalendar(
  tenantId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data } = await apiClient.put<Record<string, unknown>>(`/tenants/${tenantId}/calendar`, payload);
  return data;
}

export async function fetchTenantHolidays(tenantId: string): Promise<Array<Record<string, unknown>>> {
  const { data } = await apiClient.get<Array<Record<string, unknown>>>(`/tenants/${tenantId}/holidays`);
  return data;
}

// Enterprise Webhooks & DLQ APIs
export async function fetchWebhookEndpoints(): Promise<Array<Record<string, unknown>>> {
  const { data } = await apiClient.get<Array<Record<string, unknown>>>('/webhooks/endpoints');
  return data;
}

export async function createWebhookEndpoint(payload: {
  url: string;
  subscribedEvents: string[];
}): Promise<Record<string, unknown>> {
  const { data } = await apiClient.post<Record<string, unknown>>('/webhooks/endpoints', payload);
  return data;
}

export async function fetchDlqDeliveries(): Promise<Array<Record<string, unknown>>> {
  const { data } = await apiClient.get<Array<Record<string, unknown>>>('/webhooks/dlq');
  return data;
}

export async function replayDlqDelivery(deliveryId: string): Promise<Record<string, unknown>> {
  const { data } = await apiClient.post<Record<string, unknown>>(`/webhooks/dlq/${deliveryId}/replay`);
  return data;
}

export async function replayAllEndpointDlq(endpointId: string): Promise<Record<string, unknown>> {
  const { data } = await apiClient.post<Record<string, unknown>>(`/webhooks/endpoints/${endpointId}/replay-all`);
  return data;
}

export async function resetCircuitBreaker(endpointId: string): Promise<Record<string, unknown>> {
  const { data } = await apiClient.post<Record<string, unknown>>(`/webhooks/endpoints/${endpointId}/circuit/reset`);
  return data;
}
