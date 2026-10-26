# Chronos ⏱️

> **Production-Grade, Multi-Tenant, Event-Driven Routing and SLA Orchestration Engine**  
> Built with NestJS (TypeScript, Strict Mode), PostgreSQL 16, Prisma ORM, Redis (BullMQ), Socket.io, Luxon, and Docker.

---

## 🏗️ System Architecture Overview

Chronos is an enterprise-grade ticket routing and SLA orchestration engine designed for high-concurrency, multi-tenant operations with zero cross-tenant data leakage, sub-millisecond CQRS read analytics, non-blocking ticket claiming, timezone-aware business calendar SLA tracking, transactional outbox zero-loss event publishing, and automated SLA breach escalations.

```
                              ┌───────────────────────────────────┐
                              │    Client (HTTP / WebSocket)      │
                              └─────────────────┬─────────────────┘
                                                │
                          x-tenant-id / Bearer JWT / Correlation ID
                                                │
                                                ▼
                              ┌───────────────────────────────────┐
                              │  TenantContextGuard & Interceptor │
                              │    (nestjs-cls AsyncLocalStorage) │
                              └─────────────────┬─────────────────┘
                                                │
                   ┌────────────────────────────┼────────────────────────────┐
                   ▼                            ▼                            ▼
        ┌──────────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
        │    TicketsModule     │    │    RoutingModule     │    │   AnalyticsModule    │
        │ • State Machine DAG  │    │ • Workload Matching  │    │ • CQRS Live Hashes   │
        │ • SKIP LOCKED Claim  │    │ • Skill Routing      │    │ • WebSockets Gateway │
        │ • Audit Logging      │    └──────────────────────┘    │ • Webhook Dispatcher │
        │ • Dual-Write Outbox  │                                └──────────┬───────────┘
        └──────────┬───────────┘                                           │
                   │ (ACID Transaction)                                    ▼
                   ▼                                            ┌──────────────────────┐
        ┌──────────────────────┐                                │  Outbound Webhooks   │
        │    PostgreSQL 16     │                                │ • HMAC-SHA256 Sign   │
        │ • Tickets & Audits   │                                │ • Exp. Backoff (5x)  │
        │ • outbox_events      │                                │ • Dead Letter Queue  │
        │ • pg_notify trigger  │                                └──────────────────────┘
        └──────────┬───────────┘
                   │
                   │ pg_notify('chronos_outbox_channel') + Fallback Polling @Interval(2000)
                   ▼
        ┌──────────────────────┐
        │  OutboxRelayService  │
        │ • SKIP LOCKED Batch  │
        │ • Idempotent Dispatch│
        │ • Exponential Backoff│
        │ • Dead-Letter Queue  │
        └──────────┬───────────┘
                   │
                   ├───────────────────────────────────┐
                   ▼ (queue.addBulk)                   ▼ (Domain Events)
        ┌──────────────────────┐            ┌──────────────────────┐
        │    Redis 7/8 Alpine  │            │      SlaModule       │
        │ • BullMQ sla-monitor │            │ • 80% Warning Job    │
        │ • Pre-Aggregated HSET│            │ • 100% Breach Bump   │
        │ • Deterministic IDs  │            │ • Freeze / Unfreeze  │
        └──────────────────────┘            └──────────────────────┘
```

---

## ⚡ Core Engineering Pillars

### 1. Strict Multi-Tenant Isolation (`nestjs-cls`)
- **Thread-Safe Context**: Every HTTP request and background worker binds `tenantId` to Node's `AsyncLocalStorage` via `nestjs-cls`.
- **Tenant Context Guard**: Inspects incoming `x-tenant-id` headers and JWT token claims. If header and token tenant claims mismatch, the request is immediately rejected with HTTP 403 (`TenantAccessDeniedException`), preventing cross-tenant spoofing.
- **Tenant-Aware Base Repository**: [`TenantAwareRepository<T>`](src/common/database/tenant-aware.repository.ts) automatically merges `where: { tenantId }` into all reads, and injects `data: { tenantId }` into all mutations. Direct entity queries by ID execute `findFirst({ where: { id, tenantId } })`, preventing cross-tenant data disclosure via guessed entity UUIDs.

### 2. Atomic Non-Blocking Ticket Claim Engine (`SKIP LOCKED`)
- High-concurrency claiming via PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED`.
- When 50 concurrent agents hit `POST /tickets/claim-next` at the exact same millisecond:
  - Each transaction acquires exactly one unassigned ticket.
  - Concurrent transactions encountering locked rows **skip them immediately** without queuing or blocking database connection pools.
  - Zero deadlocks, zero lock-wait timeouts, and zero race conditions.
  - Benchmarked under load: **20 concurrent claims resolved in 22–27ms**.

### 3. Strict Ticket Lifecycle State Machine
- Enforces an immutable Directed Acyclic Graph (DAG) of allowed lifecycle transitions:
  $$\text{OPEN} \longrightarrow \text{ASSIGNED} \longrightarrow \text{IN\_PROGRESS} \underset{\text{resume}}{\overset{\text{hold}}{\rightleftharpoons}} \text{ON\_HOLD} \longrightarrow \text{RESOLVED} \longrightarrow \text{CLOSED}$$
- Illegal state transitions throw a structured HTTP 400 [`InvalidStateTransitionException`](src/modules/tickets/exceptions/invalid-state-transition.exception.ts).
- Every state transition or agent assignment writes an immutable transactional record to `TicketAuditLogs` within the same ACID transaction.

### 4. Timezone-Aware Business Hours & Holiday SLA Orchestration (v2.0)
- **Tenant-Specific Business Calendars**: Supports arbitrary IANA timezones (e.g., `America/New_York`, `Europe/London`, `Asia/Kolkata`), custom weekly active shifts (e.g., Mon–Fri 09:00–17:00), and full or partial-day holiday exclusions (`TenantHolidays`).
- **Deterministic Wall-Clock Calculator (`SlaCalendarCalculatorService`)**:
  - Pure Luxon-based calendar algorithm calculates exact wall-clock UTC timestamps for 80% (Warning) and 100% (Breach) deadlines counting **only active business milliseconds**.
  - *Example*: A 4-hour (14,400,000ms) SLA arriving Friday at 15:00 local time (business hours 09:00–17:00, closed weekends) consumes 2 hours on Friday, automatically freezes over the weekend, and resumes Monday at 09:00, scheduling the BullMQ breach job for Monday at 11:00 local time.
  - Transparently handles Daylight Saving Time (DST) Fall-Back and Spring-Forward transitions without offset drift.
- **Dynamic SLA Freeze & Resume**:
  - When a ticket transitions to `ON_HOLD`, the system computes `elapsed_business_ms` since active resumption, subtracts it from `remaining_sla_ms`, stores `sla_paused_at` and `remaining_sla_ms` in PostgreSQL, and atomically removes active BullMQ delayed jobs (`sla-warn-...`, `sla-breach-...`) from Redis.
  - When returning from `ON_HOLD` to `IN_PROGRESS`, `SlaCalendarCalculatorService` recalculates fresh wall-clock deadlines using the remaining business duration, and re-enqueues fresh BullMQ delayed jobs.
  - When transitioning to `RESOLVED` or `CLOSED`, pending SLA jobs are automatically purged.

### 5. Transactional Outbox Pattern & Zero-Loss Dual-Write Protection (Phase 6)
- **Dual-Write Vulnerability Elimination**:
  - In traditional setups, committing ticket mutations to PostgreSQL while separately publishing delayed jobs to Redis/BullMQ creates a critical vulnerability: if Redis blips or network fails after database commit, the SLA timer is lost forever.
  - Chronos solves this by writing the `Ticket`, `TicketAuditLog`, and `OutboxEvent` (status `PENDING`) atomically inside the **exact same PostgreSQL ACID transaction**.
  - Direct synchronous calls to `bullQueue.add()` are completely eliminated from the HTTP request lifecycle, driving endpoint latency under 10ms with zero Redis uptime dependency.
- **Hybrid Push/Poll Outbox Relay (`OutboxRelayService`)**:
  - **Zero-Latency Push**: PostgreSQL trigger executes `PERFORM pg_notify('chronos_outbox_channel', NEW.id::text)` on `AFTER INSERT ON outbox_events`. A dedicated persistent `pg` client listener receives the notification for sub-5ms wakeups.
  - **Fallback Polling Sweeper**: An `@Interval(2000)` sweeper guarantees self-healing in case a notification is dropped during network reconnect or server reboot.
  - **Atomic High-Throughput Batching**: Batch-fetches up to 50 `PENDING` events via `SELECT ... FOR UPDATE SKIP LOCKED` and submits jobs in parallel via BullMQ `queue.addBulk()`.
  - **Guaranteed Idempotency**: Jobs use deterministic keys (`sla-warn-${tenantId}-${ticketId}`, `sla-breach-${tenantId}-${ticketId}`), guaranteeing duplicate relay sweeps never spawn duplicate timers.
  - **Exponential Backoff & DLQ**: On Redis connectivity failure, events remain safely persisted in PostgreSQL with exponential retry intervals ($2^n \times 1000\text{ms}$). Permanent failures move to `DEAD_LETTER` after 5 attempts.

### 6. CQRS Read Layer & Pre-Aggregated Redis Caching
- Asynchronous CQRS projections maintain live tenant metric hashes: `tenant:${tenantId}:metrics:live`.
- Atomic `HINCRBY` pipelined operations track `open_count`, `on_hold_count`, `breached_count`, `at_risk_count`, and priority counts.
- `GET /analytics/dashboard` reads directly from Redis: **<1ms response latency** (<50ms SLA).
- Automatic cache-rebuild fallback service re-aggregates from PostgreSQL on cache misses.

### 7. Real-Time WebSockets & Outbound Webhooks
- **Socket.io Gateway** (`/events`): Authenticates incoming handshakes via `x-tenant-id` and isolates broadcasting to `tenant:${tenantId}` rooms.
- **Webhook Dispatcher** (`webhook-dispatcher` queue):
  - Outbound HTTP POST with cryptographic HMAC-SHA256 payload signatures (`X-Chronos-Signature-256: t=${timestamp},v1=${signature}`).
  - Exponential backoff retries (max 5 attempts: 2s, 4s, 8s, 16s, 32s).
  - Terminal failures automatically route to a Dead Letter Queue (DLQ).
  - Admin DLQ inspection and replay endpoint: `POST /analytics/webhooks/dlq/:deliveryId/retry`.

---

## 🗄️ PostgreSQL Database Schema

```
┌────────────────────────────────┐       ┌────────────────────────────────┐
│            tenants             │       │             users              │
├────────────────────────────────┤       ├────────────────────────────────┤
│ id: uuid (PK)                  │ 1   * │ id: uuid (PK)                  │
│ slug: varchar(100) (UQ)        │──────<│ tenant_id: uuid (FK)           │
│ name: varchar(255)             │       │ email: varchar(255)            │
│ status: TenantStatus           │       │ role: UserRole                 │
│ config: jsonb                  │       │ status: AgentStatus            │
│ created_at / updated_at        │       │ INDEX (tenant_id, role, status)│
└──────────────┬─────────────────┘       └────────────────────────────────┘
               │
               │ 1                       ┌────────────────────────────────┐
               ├────────────────────────<│       business_calendars       │
               │ 1                       ├────────────────────────────────┤
               │                         │ id: uuid (PK)                  │
               │                         │ tenant_id: uuid (FK, UQ)       │
               │                         │ timezone: varchar(64)          │
               │                         │ weekly_schedule: jsonb         │
               │                         │ is_24x7: boolean               │
               │                         │ INDEX (tenant_id)              │
               │                         └────────────────────────────────┘
               │ 1                       ┌────────────────────────────────┐
               ├────────────────────────<│        tenant_holidays         │
               │ *                       ├────────────────────────────────┤
               │                         │ id: uuid (PK)                  │
               │                         │ tenant_id: uuid (FK)           │
               │                         │ name: varchar(255)             │
               │                         │ date: varchar(10) (YYYY-MM-DD) │
               │                         │ is_full_day: boolean           │
               │                         │ start_time / end_time: varchar │
               │                         │ INDEX (tenant_id, date)        │
               │                         └────────────────────────────────┘
               │ 1                       ┌────────────────────────────────┐
               ├────────────────────────<│          sla_policies          │
               │ *                       ├────────────────────────────────┤
               │                         │ id: uuid (PK)                  │
               │                         │ tenant_id: uuid (FK)           │
               │                         │ priority: TicketPriority       │
               │                         │ response_time_minutes: int     │
               │                         │ resolution_time_minutes: int   │
               │                         │ INDEX (tenant_id, priority)    │
               │                         └────────────────────────────────┘
               │ 1                       ┌────────────────────────────────┐
               ├────────────────────────<│         outbox_events          │
               │ *                       ├────────────────────────────────┤
               │                         │ id: uuid (PK)                  │
               │                         │ tenant_id: uuid (FK)           │
               │                         │ aggregate_type: varchar(64)    │
               │                         │ aggregate_id: uuid             │
               │                         │ event_type: varchar(128)       │
               │                         │ payload: jsonb                 │
               │                         │ status: OutboxStatus           │
               │                         │ retry_count: int               │
               │                         │ next_attempt_at: timestamptz   │
               │                         │ created_at / processed_at      │
               │                         │ INDEX (status, next_attempt_at)│
               │                         └────────────────────────────────┘
               │ 1
               ├────────────────────────<┌────────────────────────────────┐
               │ *                       │            tickets             │
               │                         ├────────────────────────────────┤
               │                         │ id: uuid (PK)                  │
               │                         │ tenant_id: uuid (FK)           │
               │                         │ ticket_number: varchar(64)     │
               │                         │ status: TicketStatus           │
               │                         │ priority: TicketPriority       │
               │                         │ assigned_agent_id: uuid (FK)   │
               │                         │ is_breached: boolean           │
               │                         │ is_warning_sent: boolean       │
               │                         │ remaining_sla_ms: bigint       │
               │                         │ resolution_due_at: timestamptz │
               │                         │ sla_paused_at: timestamptz     │
               │                         │ last_resumed_at: timestamptz   │
               │                         │ INDEX (tenant_id, status, prio)│
               │                         └──────────────┬─────────────────┘
               │                                        │
               │ 1                                      │ 1
               ├──────────────────────┐                 │ *
               │ *                    │                 ▼
┌──────────────┴─────────────────┐    │  ┌────────────────────────────────┐
│      ticket_audit_logs         │    │  │     webhook_subscriptions      │
├────────────────────────────────┤    │  ├────────────────────────────────┤
│ id: uuid (PK)                  │    └─<│ id: uuid (PK)                  │
│ tenant_id: uuid (FK)           │       │ tenant_id: uuid (FK)           │
│ ticket_id: uuid (FK)           │       │ url: varchar(1024)             │
│ actor_id: uuid                 │       │ secret: varchar(255)           │
│ action: varchar(100)           │       │ events: text[]                 │
│ changes: jsonb                 │       └──────────────┬─────────────────┘
│ INDEX (tenant_id, ticket_id)   │                      │ 1
└────────────────────────────────┘                      ▼ *
                                         ┌────────────────────────────────┐
                                         │      webhook_delivery_logs     │
                                         ├────────────────────────────────┤
                                         │ id: uuid (PK)                  │
                                         │ tenant_id: uuid (FK)           │
                                         │ subscription_id: uuid (FK)     │
                                         │ status: WebhookDeliveryStatus  │
                                         │ attempts: int                  │
                                         │ INDEX (tenant_id, status)      │
                                         └────────────────────────────────┘
```

---

## 🚀 Quickstart

### Prerequisites
- Node.js >= 20.x
- Docker & Docker Compose (or local PostgreSQL 16 & Redis 7)

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/niranjan-7/chronos.git
cd chronos
npm install
```

### 2. Start Infrastructure via Docker Compose
```bash
docker compose up -d
```
Starts:
- **PostgreSQL 16 Alpine** on port `5432` with healthcheck
- **Redis 7 Alpine** on port `6379` with healthcheck

### 3. Configure Environment
```bash
cp .env.example .env
```
Default connection strings:
```ini
DATABASE_URL=postgresql://chronos:chronos_secret@localhost:5432/chronos_db?schema=public
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=redis_secret
PORT=3000
JWT_SECRET=chronos-super-secret-jwt-key-32-chars-min!
```

### 4. Apply Database Migrations & Generate Prisma Client
```bash
npm run prisma:generate
npx prisma db push
```

### 5. Start Application
```bash
# Development watch mode
npm run start:dev

# Production build & run
npm run build
npm run start:prod
```

Server starts at: `http://localhost:3000`

---

## 🧪 Verification & Test Suites

Chronos includes comprehensive unit test suites and real-world concurrency integration tests:

```bash
# Run all unit tests (54 tests passing across 7 suites)
npm test

# Run high-concurrency, outbox, and SLA lifecycle integration tests with live PostgreSQL & Redis
npm run test:integration
```

### Integration Test Results
```
PASS test/atomic-ticket-claim.integration.spec.ts
  Atomic Ticket Claim Engine (SKIP LOCKED Concurrency Proof)
    ✓ proves that 20 concurrent agents claiming 10 tickets yields zero collisions, exactly 10 successes and 10 graceful skips (25ms)
    ✓ proves that 10 concurrent agents racing for the EXACT SAME ticket results in 1 winner and 9 rejected without race conditions (12ms)

PASS test/analytics-cqrs.integration.spec.ts
  [CQRS LATENCY] Cold start cache rebuild duration: 50ms
  [CQRS LATENCY] Pre-aggregated Redis dashboard read duration: 0ms

PASS test/sla-orchestration.integration.spec.ts
  ✓ orchestrates ticket creation -> BullMQ delayed scheduling -> Pause on HOLD -> Resume -> Clear on RESOLVED

PASS test/business-calendar-sla.integration.spec.ts
  Phase 5: Timezone-Aware Business Calendar SLA Integration
    ✓ correctly calculates business deadlines and dynamically pauses/resumes SLA on calendar boundaries

PASS test/transactional-outbox.integration.spec.ts
  Phase 6: Transactional Outbox Pattern Integration (Zero-Loss Event Publishing)
    ✓ guarantees atomic dual-write: writes Ticket, AuditLog, and OutboxEvent in one transaction
    ✓ enforces idempotency: duplicate relay sweeps never create duplicate BullMQ jobs
    ✓ relays state machine transitions: freezes SLA on ON_HOLD and resumes on IN_PROGRESS

Test Suites: 5 passed, 5 total
Tests:       10 passed, 10 total
Snapshots:   0 total
Time:        5.191 s
```

---

## 📡 API Reference

All requests to tenant-scoped endpoints require either:
- Header: `x-tenant-id: <uuid>`
- Or `Authorization: Bearer <jwt-token>` with `tenantId` claim.

### 1. Tenants & Business Calendars (`/tenants`)
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/tenants` | Onboards a new tenant |
| `GET` | `/tenants` | Lists all tenants |
| `GET` | `/tenants/me` | Returns calling tenant profile |
| `GET` | `/tenants/:id` | Returns tenant by ID |
| `PATCH` | `/tenants/:id` | Updates tenant configuration |
| `GET` | `/tenants/:id/calendar` | **Retrieves business calendar & weekly schedule** |
| `PUT` | `/tenants/:id/calendar` | **Configures timezone, weekly schedule, or 24x7 mode** |
| `GET` | `/tenants/:id/holidays` | **Lists configured holidays for tenant** |
| `POST` | `/tenants/:id/holidays` | **Adds full or partial-day holiday exclusion** |
| `DELETE` | `/tenants/:id/holidays/:holidayId` | **Removes holiday exclusion** |

#### Example: Configure Business Hours (Mon–Fri 09:00–17:00 America/New_York)
```bash
curl -X PUT http://localhost:3000/tenants/a03a3200-b6ed-4314-b1d5-a24099a62f9a/calendar \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: a03a3200-b6ed-4314-b1d5-a24099a62f9a" \
  -d '{
    "timezone": "America/New_York",
    "is24x7": false,
    "weeklySchedule": {
      "monday": [{ "start": "09:00", "end": "17:00" }],
      "tuesday": [{ "start": "09:00", "end": "17:00" }],
      "wednesday": [{ "start": "09:00", "end": "17:00" }],
      "thursday": [{ "start": "09:00", "end": "17:00" }],
      "friday": [{ "start": "09:00", "end": "17:00" }],
      "saturday": [],
      "sunday": []
    }
  }'
```

#### Example: Add Holiday Exclusion
```bash
curl -X POST http://localhost:3000/tenants/a03a3200-b6ed-4314-b1d5-a24099a62f9a/holidays \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: a03a3200-b6ed-4314-b1d5-a24099a62f9a" \
  -d '{
    "name": "Thanksgiving Day",
    "date": "2026-11-26",
    "isFullDay": true
  }'
```

### 2. Tickets (`/tickets`)
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/tickets` | **Atomically writes Ticket, AuditLog & OutboxEvent** in single transaction |
| `POST` | `/tickets/claim-next` | **Atomic non-blocking claim** using `FOR UPDATE SKIP LOCKED` |
| `POST` | `/tickets/:id/claim` | Claims specific ticket by UUID |
| `POST` | `/tickets/:id/transition` | State Machine transition (`ASSIGNED`, `IN_PROGRESS`, `ON_HOLD`, `RESOLVED`, `CLOSED`) |
| `GET` | `/tickets` | Filtered list with composite index execution |
| `GET` | `/tickets/:id` | Returns single ticket with audit trail |
| `GET` | `/tickets/:id/audit-logs` | Immutable audit log history |

#### Example: Claim Next Available Ticket
```bash
curl -X POST http://localhost:3000/tickets/claim-next \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: a03a3200-b6ed-4314-b1d5-a24099a62f9a" \
  -d '{ "agentId": "550e8400-e29b-41d4-a716-446655440000" }'
```

### 3. Analytics & CQRS Dashboard (`/analytics`)
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/analytics/dashboard` | **Sub-5ms Pre-aggregated Redis live metrics** (fallback on miss) |
| `POST` | `/analytics/webhooks/subscriptions` | Registers an outbound webhook URL & secret |
| `GET` | `/analytics/webhooks/subscriptions` | Lists active webhook subscriptions |
| `GET` | `/analytics/webhooks/dlq` | Inspects Dead Letter Queue deliveries |
| `POST` | `/analytics/webhooks/dlq/:id/retry` | Re-queues a failed webhook delivery |

#### Example: Live Pre-Aggregated Dashboard
```bash
curl -X GET http://localhost:3000/analytics/dashboard \
  -H "x-tenant-id: a03a3200-b6ed-4314-b1d5-a24099a62f9a"
```
Response:
```json
{
  "tenantId": "a03a3200-b6ed-4314-b1d5-a24099a62f9a",
  "source": "REDIS_PRE_AGGREGATED",
  "cachedAt": "2026-10-27T02:00:00.000Z",
  "summary": {
    "totalTickets": 142,
    "openCount": 18,
    "assignedCount": 24,
    "inProgressCount": 45,
    "onHoldCount": 8,
    "resolvedCount": 42,
    "closedCount": 5,
    "breachedCount": 2,
    "atRiskCount": 4
  },
  "priorities": {
    "urgent": 6,
    "high": 22,
    "medium": 74,
    "low": 40
  }
}
```

### 4. Real-Time WebSockets (`ws://localhost:3000/events`)
Connect via Socket.io with tenant handshake:
```javascript
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000/events', {
  extraHeaders: {
    'x-tenant-id': 'a03a3200-b6ed-4314-b1d5-a24099a62f9a',
  },
});

socket.on('ticket.claimed', (data) => console.log('Ticket Claimed:', data));
socket.on('sla.warning', (data) => console.log('80% SLA Warning:', data));
socket.on('sla.breached', (data) => console.log('SLA Breached & Escalated:', data));
```

---

## 🛡️ License

UNLICENSED. Chronos Core Team.
