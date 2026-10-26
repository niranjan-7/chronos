import type { Metadata } from 'next';
import './globals.css';
import { QueryProvider } from '../providers/query-provider';
import { TenantContextProvider } from '../providers/tenant-provider';
import { WarRoomSocketProvider } from '../providers/socket-provider';
import { AppShell } from '../components/layout/app-shell';

export const metadata: Metadata = {
  title: 'Chronos | Mission Control & SLA Telemetry',
  description:
    'Multi-Tenant, Event-Driven Routing and Real-Time SLA Orchestration Engine',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="bg-slate-950 text-slate-100 antialiased">
        <QueryProvider>
          <TenantContextProvider>
            <WarRoomSocketProvider>
              <AppShell>{children}</AppShell>
            </WarRoomSocketProvider>
          </TenantContextProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
