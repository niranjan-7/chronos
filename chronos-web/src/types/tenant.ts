export type UserRole = 'ADMIN' | 'AGENT' | 'DISPATCHER';

export interface Persona {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  avatar?: string;
  skills?: string[];
  maxCapacity?: number;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  personas: Persona[];
}

export interface TenantContextState {
  activeTenant: Tenant;
  activePersona: Persona;
  token: string;
  setTenant: (tenant: Tenant) => void;
  setPersona: (persona: Persona) => void;
  switchTenantAndPersona: (tenant: Tenant, persona?: Persona) => void;
}
