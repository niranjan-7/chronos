'use client';

import React, { createContext, useContext, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTenantStore } from '../stores/tenant-store';
import { TenantContextState } from '../types/tenant';

const TenantContext = createContext<TenantContextState | null>(null);

export function TenantContextProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const store = useTenantStore();
  const prevTenantIdRef = useRef<string>(store.activeTenant.id);

  // Initialize client token on initial mount
  useEffect(() => {
    store.switchTenantAndPersona(store.activeTenant, store.activePersona);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When active tenant ID changes, reset query cache to prevent cross-tenant data bleed
  useEffect(() => {
    if (prevTenantIdRef.current !== store.activeTenant.id) {
      prevTenantIdRef.current = store.activeTenant.id;
      // Invalidate and reset all queries for previous tenant
      queryClient.resetQueries();
      queryClient.invalidateQueries();
    }
  }, [store.activeTenant.id, queryClient]);

  return (
    <TenantContext.Provider value={store}>
      {children}
    </TenantContext.Provider>
  );
}

export function useTenantContext(): TenantContextState {
  const context = useContext(TenantContext);
  if (!context) {
    throw new Error('useTenantContext must be used within a TenantContextProvider');
  }
  return context;
}
