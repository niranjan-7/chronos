export type UserRole = 'ADMIN' | 'AGENT' | 'DISPATCHER';

export type AgentStatus = 'ONLINE' | 'BUSY' | 'OFFLINE';

export interface PersonaSkill {
  name: string;
  proficiency: number; // 1 to 5
}

export interface Persona {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  avatar?: string;
  status?: AgentStatus;
  skills?: string[];
  skillsDetailed?: PersonaSkill[];
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
  setAgentStatus: (status: AgentStatus) => void;
  switchTenantAndPersona: (tenant: Tenant, persona?: Persona) => void;
}
