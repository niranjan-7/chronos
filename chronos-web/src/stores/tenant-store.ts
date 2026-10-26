import { create } from 'zustand';
import { DEFAULT_TENANTS, createClientJwt } from '../lib/tokens';
import { Persona, Tenant, TenantContextState } from '../types/tenant';
import { updateApiClientContext } from '../lib/api-client';

export const useTenantStore = create<TenantContextState>((set, get) => {
  const initialTenant = DEFAULT_TENANTS[0];
  const initialPersona = initialTenant.personas[0];

  return {
    activeTenant: initialTenant,
    activePersona: initialPersona,
    token: '',

    setTenant: async (tenant: Tenant) => {
      const currentPersona = get().activePersona;
      const persona =
        tenant.personas.find((p) => p.role === currentPersona.role) ||
        tenant.personas[0];

      const token = await createClientJwt(tenant.id, persona.id, persona.role);
      updateApiClientContext(tenant.id, token);

      set({
        activeTenant: tenant,
        activePersona: persona,
        token,
      });
    },

    setPersona: async (persona: Persona) => {
      const activeTenant = get().activeTenant;
      const token = await createClientJwt(activeTenant.id, persona.id, persona.role);
      updateApiClientContext(activeTenant.id, token);

      set({
        activePersona: persona,
        token,
      });
    },

    switchTenantAndPersona: async (tenant: Tenant, persona?: Persona) => {
      const targetPersona = persona || tenant.personas[0];
      const token = await createClientJwt(tenant.id, targetPersona.id, targetPersona.role);
      updateApiClientContext(tenant.id, token);

      set({
        activeTenant: tenant,
        activePersona: targetPersona,
        token,
      });
    },
  };
});
