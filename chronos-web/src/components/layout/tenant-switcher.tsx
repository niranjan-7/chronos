'use client';

import React, { useState, useRef, useEffect } from 'react';
import { useTenantStore } from '../../stores/tenant-store';
import { DEFAULT_TENANTS } from '../../lib/tokens';
import { ChevronDown, Building2, Check, Shield, Headphones } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Persona, Tenant } from '../../types/tenant';

export function TenantSwitcher() {
  const { activeTenant, activePersona, switchTenantAndPersona } = useTenantStore();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (tenant: Tenant, persona: Persona) => {
    switchTenantAndPersona(tenant, persona);
    setIsOpen(false);
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg border border-slate-800 bg-slate-900/80 hover:bg-slate-800/90 text-left transition-all duration-150 cursor-pointer shadow-sm group"
      >
        <div className="w-6 h-6 rounded-md bg-gradient-to-br from-indigo-500/20 to-purple-500/20 border border-indigo-500/30 flex items-center justify-center text-[10px] font-bold text-indigo-300 font-mono">
          {activeTenant.name.slice(0, 2).toUpperCase()}
        </div>

        <div className="flex flex-col">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-slate-100 group-hover:text-white">
              {activeTenant.name}
            </span>
            <span className="text-slate-600 font-mono text-[10px]">/</span>
            <span className="text-xs text-slate-300 font-medium">
              {activePersona.name.split(' ')[0]}
            </span>
          </div>
          <span className="text-[10px] text-slate-400 font-mono">
            {activePersona.role} • {activeTenant.slug}
          </span>
        </div>

        <ChevronDown
          className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-200 ml-1 ${
            isOpen ? 'rotate-180 text-slate-200' : ''
          }`}
        />
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-80 rounded-xl border border-slate-800 bg-slate-950/95 p-2 shadow-2xl backdrop-blur-xl z-50 animate-in fade-in-0 zoom-in-95">
          <div className="px-2.5 py-1.5 text-[11px] font-mono uppercase tracking-wider text-slate-400 border-b border-slate-900 mb-1 flex items-center justify-between">
            <span>Corporate Tenants & Personas</span>
            <Building2 className="w-3.5 h-3.5 text-slate-500" />
          </div>

          <div className="space-y-2 max-h-96 overflow-y-auto py-1">
            {DEFAULT_TENANTS.map((tenant) => {
              const isCurrentTenant = tenant.id === activeTenant.id;
              return (
                <div key={tenant.id} className="rounded-lg border border-slate-900 bg-slate-900/40 p-2">
                  <div className="flex items-center justify-between px-1.5 mb-1.5">
                    <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                      <Building2 className="w-3.5 h-3.5 text-indigo-400" />
                      {tenant.name}
                    </span>
                    <span className="text-[10px] font-mono text-slate-500">{tenant.slug}</span>
                  </div>

                  <div className="space-y-1">
                    {tenant.personas.map((persona) => {
                      const isSelected = isCurrentTenant && persona.id === activePersona.id;
                      return (
                        <button
                          key={persona.id}
                          onClick={() => handleSelect(tenant, persona)}
                          className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-left transition-colors cursor-pointer ${
                            isSelected
                              ? 'bg-slate-800/90 text-white border border-slate-700'
                              : 'hover:bg-slate-800/50 text-slate-300'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            {persona.role === 'ADMIN' ? (
                              <Shield className="w-3.5 h-3.5 text-purple-400" />
                            ) : (
                              <Headphones className="w-3.5 h-3.5 text-emerald-400" />
                            )}
                            <div className="flex flex-col">
                              <span className="text-xs font-medium">{persona.name}</span>
                              <span className="text-[10px] text-slate-400 font-mono">
                                {persona.email}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5">
                            <Badge
                              variant={persona.role === 'ADMIN' ? 'neutral' : 'healthy'}
                              className="text-[10px] py-0 px-1.5"
                            >
                              {persona.role}
                            </Badge>
                            {isSelected && <Check className="w-3.5 h-3.5 text-emerald-400" />}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
