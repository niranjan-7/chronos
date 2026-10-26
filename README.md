# Chronos ⏱️

> **Production-Grade, Multi-Tenant, Event-Driven Routing and SLA Orchestration Engine**  
> Built with NestJS (TypeScript, Strict Mode), PostgreSQL 16, Prisma ORM, Redis (BullMQ), Socket.io, and Docker.

---

## 🏗️ System Architecture Overview

Chronos is an enterprise-grade ticket routing and SLA orchestration engine designed for high-concurrency, multi-tenant operations with zero cross-tenant data leakage, sub-millisecond CQRS read analytics, non-blocking ticket claiming, and automated SLA breach escalations.

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
        └──────────┬───────────┘                                └──────────┬───────────┘
                   │                                                       │
                   ▼ (Domain Events)                                       ▼
        ┌──────────────────────┐                                ┌──────────────────────┐
        │      SlaModule       │                                │  Outbound Webhooks   │
        │ • 80% Warning Job    │                                │ • HMAC-SHA256 Sign   │
        │ • 100% Breach Bump   │                                │ • Exp. Backoff (5x)  │
        │ • Pause / Resume     │                                │ • Dead Letter Queue  │
        └──────────┬───────────┘                                └──────────────────────┘
                   │
                   ├───────────────────────────────────┐
                   ▼                                   ▼
        ┌──────────────────────┐            ┌──────────────────────┐
        │    PostgreSQL 16     │            │    Redis 7/8 Alpine  │
        │ • Multi-Tenant DB    │            │ • BullMQ Queues      │
        │ • B-Tree Indexes     │            │ • Pre-Aggregated HSET│
        │ • Row-Level Locks    │            │ • Deterministic IDs  │
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
  - Benchmarked under load: **20 concurrent claims resolved in 19–26ms**.

### 3. Strict Ticket Lifecycle State Machine
- Enforces an immutable Directed Acyclic Graph (DAG) of allowed lifecycle transitions:
  $$\text{OPEN} \longrightarrow \text{ASSIGNED} \longrightarrow \text{IN\_PROGRESS} \underset{\text{resume}}{\overset{\text{hold}}{\rightleftharpoons}} \text{ON\_HOLD} \longrightarrow \text{RESOLVED} \longrightarrow \text{CLOSED}$$
- Illegal state transitions throw a structured HTTP 400 [`InvalidStateTransitionException`](src/modules/tickets/exceptions/invalid-state-transition.exception.ts).
- Every state transition or agent assignment writes an immutable transactional record to `TicketAuditLogs` within the same ACID transaction.

### 4. Event-Driven SLA Orchestration (Redis & BullMQ)
- **Decoupled Architecture**: In-process domain events (`@nestjs/event-emitter`) publish notifications; distributed Redis BullMQ queues handle delayed executions.
- **Pre-Configured Policy Tiers**:
  - `P1 (URGENT)`: 15m Response / 60m Resolution SLA
  - `P2 (HIGH)`: 30m Response / 4h Resolution SLA
  - `P3 (MEDIUM)`: 60m Response / 8h Resolution SLA
  - `P4 (LOW)`: 120m Response / 24h Resolution SLA
- **Deterministic Job IDs for $O(1)$ Cancellation**:
  - `sla-warn-${tenantId}-${ticketId}` (at 80% of duration)
  - `sla-breach-${tenantId}-${ticketId}` (at 100% of duration)
- **SLA Pause & Resume**:
  - When ticket moves to `ON_HOLD`, pending Redis delayed jobs are cancelled, and `remaining_sla_ms` is persisted on the database row.
  - When ticket resumes to `IN_PROGRESS`, BullMQ delayed jobs are re-enqueued using the exact `remaining_sla_ms`.
  - When ticket moves to `RESOLVED`, pending SLA jobs are automatically removed.
- **SLA Worker Processor**:
  - Re-hydrates the `AsyncLocalStorage` store with the job's `tenantId` before performing database queries.
  - Automatically triggers priority escalation bumps upon breach (`LOW` $\to$ `MEDIUM` $\to$ `HIGH` $\to$ `URGENT`).

### 5. CQRS Read Layer & Pre-Aggregated Redis Caching
- Asynchronous CQRS projections maintain live tenant metric hashes: `tenant:${tenantId}:metrics:live`.
- Atomic `HINCRBY` pipelined operations track `open_count`, `on_hold_count`, `breached_count`, `at_risk_count`, and priority counts.
- `GET /analytics/dashboard` reads directly from Redis: **1ms response latency** (<50ms SLA).
- Automatic cache-rebuild fallback service re-aggregates from PostgreSQL on cache misses.

### 6. Real-Time WebSockets & Outbound Webhooks
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
               ├────────────────────────<│          sla_policies          │
               │ *                       ├────────────────────────────────┤
               │                         │ id: uuid (PK)                  │
               │                         │ tenant_id: uuid (FK)           │
               │                         │ priority: TicketPriority       │
               │                         │ response_time_minutes: int     │
               │                         │ resolution_time_minutes: int   │
               │                         │ INDEX (tenant_id, priority)    │
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
# Run all unit tests (41 tests passing)
npm test

# Run high-concurrency integration tests with live PostgreSQL & Redis
npm run test:integration
```

### Concurrency Benchmark Output
```
PASS test/atomic-ticket-claim.integration.spec.ts
  Atomic Ticket Claim Engine (SKIP LOCKED Concurrency Proof)
    ✓ proves that 20 concurrent agents claiming 10 tickets yields zero collisions, exactly 10 successes and 10 graceful skips (22ms)
    ✓ proves that 10 concurrent agents racing for the EXACT SAME ticket results in 1 winner and 9 rejected without race conditions (11ms)

  [CONCURRENCY PROOF] 20 concurrent claims completed in 22ms

PASS test/analytics-cqrs.integration.spec.ts
  [CQRS LATENCY] Cold start cache rebuild duration: 49ms
  [CQRS LATENCY] Pre-aggregated Redis dashboard read duration: 1ms

PASS test/sla-orchestration.integration.spec.ts
  ✓ orchestrates ticket creation -> BullMQ delayed scheduling -> Pause on HOLD -> Resume -> Clear on RESOLVED

Test Suites: 3 passed, 3 total
Tests:       6 passed, 6 total
Snapshots:   0 total
Time:        3.021 s
```

---

## 📡 API Reference

All requests to tenant-scoped endpoints require either:
- Header: `x-tenant-id: <uuid>`
- Or `Authorization: Bearer <jwt-token>` with `tenantId` claim.

### 1. Tenants (`/tenants`)
| Method | Endpoint | Description | Public |
|---|---|---|---|
| `POST` | `/tenants` | Onboards a new tenant | Yes |
| `GET` | `/tenants` | Lists all tenants | Yes |
| `GET` | `/tenants/me` | Returns calling tenant profile | No |
| `GET` | `/tenants/:id` | Returns tenant by ID | Yes |
| `PATCH` | `/tenants/:id` | Updates tenant configuration | Yes |

### 2. Tickets (`/tickets`)
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/tickets` | Creates a new tenant ticket; triggers SLA scheduling |
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
