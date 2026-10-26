import * as jwt from 'jsonwebtoken';
import { DEFAULT_TENANTS, createClientJwt, CHRONOS_DEFAULT_JWT_SECRET } from '../chronos-web/src/lib/tokens';
import { apiClient, updateApiClientContext } from '../chronos-web/src/lib/api-client';
import { useTenantStore } from '../chronos-web/src/stores/tenant-store';
import { useTelemetryStore } from '../chronos-web/src/stores/telemetry-store';
import { SlaWarRoomAlert, TicketAssignmentEvent } from '../chronos-web/src/types/telemetry';

describe('Phase 10: Frontend Architecture, Tenant Context Switcher & Telemetry Sync (Integration)', () => {
  beforeEach(() => {
    useTelemetryStore.setState({
      connectionStatus: 'OFFLINE',
      latencyMs: 0,
      recentAlerts: [],
      recentAssignments: [],
      unreadAlertCount: 0,
    });
  });

  describe('Multi-Tenant Persona & JWT Cryptographic Handshake Helper', () => {
    it('should generate valid HS256 JWT verifiable by Chronos backend JWT secret', async () => {
      const tenant = DEFAULT_TENANTS[0]; // Acme Corp
      const persona = tenant.personas[1]; // Sarah Chen (Agent)

      const token = await createClientJwt(tenant.id, persona.id, persona.role);

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.').length).toBe(3);

      // Verify token signature against backend secret
      const decoded = jwt.verify(token, CHRONOS_DEFAULT_JWT_SECRET) as any;
      expect(decoded.tenantId).toBe(tenant.id);
      expect(decoded.sub).toBe(persona.id);
      expect(decoded.role).toBe(persona.role);
    });

    it('should include all 3 corporate tenants (Acme, Stark, Globex) with personas', () => {
      expect(DEFAULT_TENANTS.length).toBe(3);
      const names = DEFAULT_TENANTS.map((t) => t.name);
      expect(names).toContain('Acme Corp');
      expect(names).toContain('Stark Industries');
      expect(names).toContain('Globex Corp');

      for (const tenant of DEFAULT_TENANTS) {
        expect(tenant.personas.length).toBeGreaterThanOrEqual(2);
        const roles = tenant.personas.map((p) => p.role);
        expect(roles).toContain('ADMIN');
        expect(roles).toContain('AGENT');
      }
    });
  });

  describe('Centralized API Client Context Injection', () => {
    it('should dynamically inject active x-tenant-id and Bearer token into outgoing requests', async () => {
      const tenantId = 'test-tenant-1111-2222';
      const token = 'ey-test-token-jwt-value';

      updateApiClientContext(tenantId, token);

      // Run request interceptor handlers
      const mockConfig: any = { headers: {} };
      const interceptor = (apiClient.interceptors.request as any).handlers[0].fulfilled;
      const modifiedConfig = interceptor(mockConfig);

      expect(modifiedConfig.headers['x-tenant-id']).toBe(tenantId);
      expect(modifiedConfig.headers['Authorization']).toBe(`Bearer ${token}`);
    });
  });

  describe('Tenant & Persona Switcher Zustand Store', () => {
    it('should switch corporate tenant and generate updated token with API client context sync', async () => {
      const acmeTenant = DEFAULT_TENANTS[0];
      const starkTenant = DEFAULT_TENANTS[1];

      const store = useTenantStore.getState();

      // Switch to Stark Industries
      await store.setTenant(starkTenant);

      const updated = useTenantStore.getState();
      expect(updated.activeTenant.id).toBe(starkTenant.id);
      expect(updated.activeTenant.name).toBe('Stark Industries');
      expect(updated.token).toBeDefined();

      const decoded = jwt.verify(updated.token, CHRONOS_DEFAULT_JWT_SECRET) as any;
      expect(decoded.tenantId).toBe(starkTenant.id);
    });

    it('should switch persona within tenant and preserve active tenant boundary', async () => {
      const tenant = DEFAULT_TENANTS[0];
      const adminPersona = tenant.personas[0];
      const agentPersona = tenant.personas[1];

      const store = useTenantStore.getState();
      await store.switchTenantAndPersona(tenant, adminPersona);

      expect(useTenantStore.getState().activePersona.id).toBe(adminPersona.id);
      expect(useTenantStore.getState().activePersona.role).toBe('ADMIN');

      // Switch to Agent
      await store.setPersona(agentPersona);

      expect(useTenantStore.getState().activePersona.id).toBe(agentPersona.id);
      expect(useTenantStore.getState().activePersona.role).toBe('AGENT');
      expect(useTenantStore.getState().activeTenant.id).toBe(tenant.id);
    });
  });

  describe('Real-Time Telemetry Store', () => {
    it('should update connection status and latency pill measurements', () => {
      const store = useTelemetryStore.getState();

      expect(store.connectionStatus).toBe('OFFLINE');

      store.setConnectionStatus('LIVE');
      store.setLatencyMs(18);

      const updated = useTelemetryStore.getState();
      expect(updated.connectionStatus).toBe('LIVE');
      expect(updated.latencyMs).toBe(18);
    });

    it('should buffer incoming SLA alerts and manage unread notifications', () => {
      const store = useTelemetryStore.getState();

      const alert1: SlaWarRoomAlert = {
        ticketId: 'tck-1',
        ticketNumber: 'TCK-1001',
        priority: 'URGENT',
        status: 'IN_PROGRESS',
        type: 'WARNING',
        warningAt: new Date().toISOString(),
        timestamp: new Date().toISOString(),
      };

      const alert2: SlaWarRoomAlert = {
        ticketId: 'tck-2',
        ticketNumber: 'TCK-1002',
        priority: 'URGENT',
        status: 'IN_PROGRESS',
        type: 'BREACH',
        breachedAt: new Date().toISOString(),
        timestamp: new Date().toISOString(),
      };

      store.addAlert(alert1);
      store.addAlert(alert2);

      const state = useTelemetryStore.getState();
      expect(state.recentAlerts.length).toBe(2);
      expect(state.recentAlerts[0].type).toBe('BREACH'); // latest first
      expect(state.recentAlerts[1].type).toBe('WARNING');
      expect(state.unreadAlertCount).toBe(2);

      state.clearUnreadAlerts();
      expect(useTelemetryStore.getState().unreadAlertCount).toBe(0);
    });

    it('should buffer incoming ticket assignments to personal queue', () => {
      const store = useTelemetryStore.getState();

      const assignment: TicketAssignmentEvent = {
        ticketId: 'tck-99',
        ticketNumber: 'TCK-9900',
        priority: 'HIGH',
        requiredSkills: ['voice_webrtc'],
        assignedAt: new Date().toISOString(),
      };

      store.addAssignment(assignment);

      const state = useTelemetryStore.getState();
      expect(state.recentAssignments.length).toBe(1);
      expect(state.recentAssignments[0].ticketNumber).toBe('TCK-9900');
    });
  });
});
