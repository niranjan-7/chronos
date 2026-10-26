'use client';

import React from 'react';
import { Sidebar } from './sidebar';
import { Header } from './header';
import { ChaosSimulatorDrawer } from '../chaos/chaos-simulator-drawer';

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-950 text-slate-100 font-sans antialiased selection:bg-indigo-500/30 selection:text-indigo-200 relative">
      {/* Sidebar Navigation */}
      <Sidebar />

      {/* Main View Area */}
      <div className="flex flex-col flex-1 min-w-0 h-full overflow-hidden">
        {/* Top Header */}
        <Header />

        {/* Scrollable Dashboard Page Content */}
        <main className="flex-1 overflow-y-auto p-6 bg-gradient-to-b from-slate-950 via-slate-950 to-slate-900/50">
          <div className="max-w-7xl mx-auto space-y-6">
            {children}
          </div>
        </main>
      </div>

      {/* Floating Concurrency & Chaos Simulator DevTools Drawer */}
      <ChaosSimulatorDrawer />
    </div>
  );
}
