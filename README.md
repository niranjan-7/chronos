# Chronos ⏱️

> **Production-Grade, Multi-Tenant, Event-Driven Routing and SLA Orchestration Engine**  
> Built with NestJS (TypeScript, Strict Mode), PostgreSQL 16, Prisma ORM, Redis (BullMQ & Lua Scripts), Socket.io, Luxon, and Docker.

---

## 🏗️ System Architecture Overview

Chronos is an enterprise-grade ticket routing and SLA orchestration engine designed for high-concurrency, multi-tenant operations with zero cross-tenant data leakage, sub-millisecond CQRS read analytics, non-blocking ticket claiming, timezone-aware business calendar SLA tracking, transactional outbox zero-loss event publishing, automated SLA breach escalations, high-throughput skill-based auto-routing, and **enterprise outbound webhook dispatching with HMAC-SHA256 cryptographic signing, jittered exponential backoff, and a Redis sliding-window circuit breaker**.

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
        │ • State Machine DAG  │    │ • Lua Atomic Claim   │    │ • CQRS Live Hashes   │
        │ • SKIP LOCKED Claim  │    │ • Redis Skill ZSETs  │    │ • WebSockets Gateway │
        │ • Audit Logging      │    │ • Overflow SKIP LOCK │    └──────────┬───────────┘
        │ • Dual-Write Outbox  │    │ • Workload Matcher   │               │
        └──────────┬───────────┘    └──────────┬───────────┘               ▼
                   │ (ACID Transaction)        │                ┌──────────────────────┐
                   ▼                           │                │   WebhooksModule     │
        ┌──────────────────────┐               │                │ • AES-256-GCM Secret │
        │    PostgreSQL 16     │               │                │ • HMAC-SHA256 Sign   │
        │ • Tickets & Audits   │               │                │ • Redis Circuit Brk  │
        │ • agent_skills       │               │                │ • 5s Hard Timeout    │
        │ • webhook_endpoints  │               │                │ • Jitter Backoff     │
        │ • outbox_events      │               │                │ • Dead Letter Queue  │
        │ • pg_notify trigger  │               │                └──────────┬───────────┘
        └──────────┬───────────┘               │                           │
                   │                           │                           ▼
                   │ pg_notify + Sweeper       ▼ (claim_best_agent.lua)    │ (Outbound Dispatch)
                   ▼                ┌──────────────────────┐               │
        ┌──────────────────────┐    │    Redis 7/8 Alpine  │               ▼
        │  OutboxRelayService  │    │ • tenant:skill:ZSET  │    ┌──────────────────────┐
        │ • SKIP LOCKED Batch  │    │ • tenant:agent:load  │    │ External Endpoints   │
        │ • queue.addBulk()    │    │ • circuit:state/fail │    │ • Slack / PagerDuty  │
        │ • Idempotent Dispatch│    │ • BullMQ sla-monitor │    │ • Corporate CRMs     │
        └──────────┬───────────┘    │ • BullMQ webhook-dsp │    └──────────────────────┘
                   │                └──────────────────────┘
                   ├───────────────────────────────────┐
                   ▼ (queue.addBulk)                   ▼ (Domain Events)
        ┌──────────────────────┐            ┌──────────────────────┐
        │  BullMQ sla-monitor  │            │      SlaModule       │
        │ • sla.warning (80%)  │            │ • 80% Warning Job    │
        │ • sla.breach (100%)  │            │ • 100% Breach Bump   │
        │ • Deterministic IDs  │            │ • Freeze / Unfreeze  │
        └──────────────────────┘            └──────────────────────┘
```

---

## ⚡ Core Engineering Pillars

### 1. Strict Multi-Tenant Isolation (`nestjs-cls`)
- **Thread-Safe Context**: Every HTTP request and background worker binds `tenantId` to Node's `AsyncLocalStorage` via `nestjs-cls`.
- **Tenant Context Guard**: Inspects incoming `x-tenant-id` headers and JWT token claims. If header and token tenant claims mismatch, the request is immediately rejected with HTTP 403 (`TenantAccessDeniedException`), preventing cross-tenant spoofing.
- **Tenant-Aware Base Repository**: [`TenantAwareRepository<T>`](src/common/database/tenant-aware.repository.ts) automatically merges `where: { tenantId }` into all reads, and injects `data: { tenantId }` into all mutations. Direct entity queries by ID execute `findFirst({ where: { id, tenantId } })`, preventing cross-tenant data disclosure via guessed entity UUIDs.

### 2. Enterprise Outbound Webhooks with Circuit Breaker (Phase 8)
- **AES-256-GCM Secret Encryption at Rest**:
  - Signing secrets are never stored in plaintext. They are encrypted at rest with authenticated AES-256-GCM (`enc:v1:<iv>:<auth_tag>:<ciphertext>`), preventing secret leakage from database dumps.
- **Cryptographic Request Signing**:
  - Outbound HTTP requests carry `X-Chronos-Signature: t={unix_timestamp},v1={HMAC_SHA256(timestamp + "." + raw_json_body, signing_secret)}`.
  - Replay attack protection with strict 300-second timestamp tolerance and timing-safe equality checks.
  - Receiver idempotency guaranteed via unique `X-Chronos-Delivery-Id` UUID header.
- **Strict 5-Second Hard Timeout**:
  - Outbound HTTP dispatches utilize `AbortSignal.timeout(5000)` to terminate unresponsive external endpoints and prevent worker pool thread exhaustion.
- **Redis Sliding-Window Circuit Breaker (`CircuitBreakerService`)**:
  - **CLOSED**: Normal operation. Tracks failures in a 5-minute rolling Redis window (`tenant:{tenantId}:webhook:{endpointId}:circuit:failures`). If failures reach 10 consecutive 5xx/timeout errors, the circuit trips to **OPEN** for 60 seconds and emits a tenant system alert.
  - **OPEN**: Fast-fails immediately with 0ms response latency without opening socket connections or dispatching HTTP requests.
  - **HALF_OPEN**: After the 60s cooldown expires, exactly 1 probe request is permitted through via atomic Redis `SET NX` lock. If the probe returns 2xx, the circuit resets to **CLOSED**; if it fails, the circuit re-trips for an extended 120s cooldown.
- **Exponential Backoff with Full Jitter**:
  - Custom BullMQ backoff strategy prevents thundering herds on recovering endpoints:
    $$\text{delay} = \text{base} \times 2^{\text{attempt}} + \text{random\_jitter}$$
- **Dead Letter Queue (DLQ) & Admin Replay APIs**:
  - Failed deliveries exhaust after 5 attempts and transition to `DEAD_LETTER`.
  - Admin APIs allow re-driving individual failures (`POST /webhooks/dlq/:deliveryId/replay`) or mass replaying all failures for an endpoint (`POST /webhooks/endpoints/:id/replay-all`).

### 3. High-Throughput Skill-Based Auto-Routing Engine (Phase 7)
- **Redis Live Capacity Index & Composite Scoring**:
  - Maintains tenant-scoped Redis Sorted Sets: `tenant:{tenantId}:skill:{skillTag}:agents`.
  - Member is `agentId`; score is an atomic composite routing score combining specialization proficiency ($1 \text{ to } 5$) and real-time available capacity ratio:
    $$\text{score} = (\text{proficiency} \times 100) + \left(\frac{\text{max\_capacity} - \text{active\_load}}{\text{max\_capacity}}\right) \times 50$$
  - Top candidate scores reach up to 550 (Proficiency 5, 0 active load). As active load increments, the score scales downward linearly.
- **Atomic Lua Claim Script (`claim_best_agent.lua`)**:
  - Inspects candidate agents in required skill `ZSET` from highest score to lowest in a single Redis round-trip.
  - Validates candidate online status and capacity headroom (`active_load < max_capacity`).
  - Atomically increments load and updates skill ZSETs.
- **Backpressure & Overflow Queue Fallback**:
  - Saturated tickets remain in `OPEN` status within the overflow pool.
  - When capacity is freed (`agent.capacity_freed`), the engine automatically queries and locks the highest-priority waiting ticket using PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED`.

### 4. Atomic Non-Blocking Ticket Claim Engine (`SKIP LOCKED`)
- High-concurrency claiming via PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED`.
- When 50 concurrent agents hit `POST /tickets/claim-next` at the exact same millisecond:
  - Each transaction acquires exactly one unassigned ticket.
  - Concurrent transactions encountering locked rows **skip them immediately** without queuing or blocking database connection pools.
  - Zero deadlocks, zero lock-wait timeouts, and zero race conditions.
  - Benchmarked under load: **20 concurrent claims resolved in 22–27ms**.

### 5. Strict Ticket Lifecycle State Machine
- Enforces an immutable Directed Acyclic Graph (DAG) of allowed lifecycle transitions:
  $$\text{OPEN} \longrightarrow \text{ASSIGNED} \longrightarrow \text{IN\_PROGRESS} \underset{\text{resume}}{\overset{\text{hold}}{\rightleftharpoons}} \text{ON\_HOLD} \longrightarrow \text{RESOLVED} \longrightarrow \text{CLOSED}$$
- Illegal state transitions throw a structured HTTP 400 [`InvalidStateTransitionException`](src/modules/tickets/exceptions/invalid-state-transition.exception.ts).
- Every state transition or agent assignment writes an immutable transactional record to `TicketAuditLogs` within the same ACID transaction.

### 6. Timezone-Aware Business Hours & Holiday SLA Orchestration (v2.0)
- **Tenant-Specific Business Calendars**: Supports arbitrary IANA timezones (e.g., `America/New_York`, `Europe/London`, `Asia/Kolkata`), custom weekly active shifts (e.g., Mon–Fri 09:00–17:00), and holiday exclusions (`TenantHolidays`).
- **Deterministic Wall-Clock Calculator (`SlaCalendarCalculatorService`)**:
  - Pure Luxon-based calendar algorithm calculates exact wall-clock UTC timestamps for 80% (Warning) and 100% (Breach) deadlines counting **only active business milliseconds**.
  - Transparently handles Daylight Saving Time (DST) Fall-Back and Spring-Forward transitions without offset drift.
- **Dynamic SLA Freeze & Resume**:
  - Automatically freezes SLA duration when moving to `ON_HOLD`, purges pending BullMQ delayed jobs, and recalculates exact deadlines on resumption to `IN_PROGRESS`.

### 7. Transactional Outbox Pattern & Zero-Loss Dual-Write Protection (Phase 6)
- **Dual-Write Vulnerability Elimination**:
  - Writes the `Ticket`, `TicketAuditLog`, and `OutboxEvent` (status `PENDING`) atomically inside the **exact same PostgreSQL ACID transaction**.
- **Hybrid Push/Poll Outbox Relay (`OutboxRelayService`)**:
  - Sub-5ms wakeups via PostgreSQL `PERFORM pg_notify('chronos_outbox_channel', NEW.id::text)`.
  - Fallback polling sweeper at `@Interval(2000)` guarantees self-healing.
  - Atomic batch fetching via `SELECT ... FOR UPDATE SKIP LOCKED` and parallel `queue.addBulk()` dispatch.

### 8. CQRS Read Layer & Pre-Aggregated Redis Caching
- Asynchronous CQRS projections maintain live tenant metric hashes: `tenant:${tenantId}:metrics:live`.
- Atomic `HINCRBY` pipelined operations track `open_count`, `on_hold_count`, `breached_count`, `at_risk_count`, and priority counts.
- `GET /analytics/dashboard` reads directly from Redis: **<1ms response latency** (<50ms SLA).

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
│ created_at / updated_at        │       │ max_concurrent_tickets: int    │
└──────────────┬─────────────────┘       │ INDEX (tenant_id, role, status)│
               │                         └──────────────┬─────────────────┘
               │ 1                                      │ 1
               ├────────────────────────<               │ *
               │ *                       ┌──────────────┴─────────────────┐
               │                         │          agent_skills          │
               │                         ├────────────────────────────────┤
               │                         │ id: uuid (PK)                  │
               │                         │ tenant_id: uuid (FK)           │
               │                         │ agent_id: uuid (FK)            │
               │                         │ skill: varchar(64)             │
               │                         │ proficiency: int (1..5)        │
               │                         │ UQ (agent_id, skill)           │
               │                         │ INDEX (tenant_id, skill)       │
               │                         └────────────────────────────────┘
               │ 1                       ┌────────────────────────────────┐
               ├────────────────────────<│       webhook_endpoints        │
               │ *                       ├────────────────────────────────┤
               │                         │ id: uuid (PK)                  │
               │                         │ tenant_id: uuid (FK)           │
               │                         │ url: varchar(1024)             │
               │                         │ signing_secret: varchar(512)   │ (AES-256-GCM Encrypted)
               │                         │ subscribed_events: text[]      │
               │                         │ is_active: boolean             │
               │                         │ circuit_state: CircuitState    │ (CLOSED, OPEN, HALF_OPEN)
               │                         │ INDEX (tenant_id, circuit_state│
               │                         └──────────────┬─────────────────┘
               │                                        │ 1
               │                                        │ *
               │                         ┌──────────────┴─────────────────┐
               │                         │    webhook_delivery_attempts   │
               │                         ├────────────────────────────────┤
               │                         │ id: uuid (PK)                  │
               │                         │ tenant_id: uuid (FK)           │
               │                         │ endpoint_id: uuid (FK)         │
               │                         │ event: varchar(100)            │
               │                         │ payload: jsonb                 │
               │                         │ attempt_number: int            │
               │                         │ status_code: int               │
               │                         │ response_latency_ms: int       │
               │                         │ response_body: text            │
               │                         │ status: WebhookDeliveryStatus  │
               │                         │ circuit_state_at_dispatch: enum│
               │                         │ INDEX (endpoint_id, status)    │
               │                         └────────────────────────────────┘
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
               │                         │ routing_mode: RoutingMode      │
               │                         │ required_skills: text[]        │
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
│      ticket_audit_logs         │    │  │     ticket_audit_logs          │
├────────────────────────────────┤    │  └────────────────────────────────┘
│ id: uuid (PK)                  │    │
│ tenant_id: uuid (FK)           │    │
│ ticket_id: uuid (FK)           │    │
│ actor_id: uuid                 │    │
│ action: varchar(100)           │    │
│ changes: jsonb                 │    │
│ INDEX (tenant_id, ticket_id)   │    │
└────────────────────────────────┘    │
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
# Run all unit tests (87 tests passing across 11 suites)
npm test

# Run high-concurrency, outbox, SLA lifecycle, skill-routing, and enterprise webhook integration tests
npm run test:integration
```

### Integration Test Results
```
PASS test/atomic-ticket-claim.integration.spec.ts
  Atomic Ticket Claim Engine (SKIP LOCKED Concurrency Proof)
    ✓ proves that 20 concurrent agents claiming 10 tickets yields zero collisions (25ms)

PASS test/skill-based-routing.integration.spec.ts
  Phase 7: High-Throughput Skill-Based & Capacity-Aware Auto-Routing Integration
    ✓ verifies initial Redis composite scores based on proficiency and capacity
    ✓ prioritizes highest score agent and updates live composite scores linearly
    ✓ routes to next highest proficiency agent when top agent hits max capacity
    ✓ activates backpressure overflow pool when all skilled agents hit max capacity
    ✓ automatically drains overflow pool using SKIP LOCKED when agent frees capacity

PASS test/enterprise-webhooks.integration.spec.ts
  Phase 8: Enterprise Outbound Webhooks Integration (HMAC-SHA256, Jitter, Circuit Breaker & DLQ)
    ✓ provisions WebhookEndpoint with AES-256-GCM secret encryption at rest
    ✓ cryptographically signs outbound HTTP request with X-Chronos-Signature & Idempotency Delivery ID
    ✓ trips sliding-window circuit breaker after 10 consecutive failures and fast-fails without HTTP calls
    ✓ allows probe request in HALF_OPEN after cooldown expires and resets circuit on 2xx
    ✓ dead-letters permanently failed deliveries and supports single & bulk replay APIs

PASS test/analytics-cqrs.integration.spec.ts
  [CQRS LATENCY] Cold start cache rebuild duration: 45ms
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

Test Suites: 7 passed, 7 total
Tests:       20 passed, 20 total
Snapshots:   0 total
Time:        7.542 s
```

---

## 📡 API Reference

All requests to tenant-scoped endpoints require either:
- Header: `x-tenant-id: <uuid>`
- Or `Authorization: Bearer <jwt-token>` with `tenantId` claim.

### 1. Enterprise Webhooks & DLQ (`/webhooks`)
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/webhooks/endpoints` | **Registers endpoint with AES-256-GCM secret encryption** |
| `GET` | `/webhooks/endpoints` | Lists endpoints with live Redis circuit status |
| `GET` | `/webhooks/endpoints/:id` | Returns single endpoint with circuit metrics |
| `PATCH` | `/webhooks/endpoints/:id` | Updates URL, subscribed events, or active status |
| `DELETE` | `/webhooks/endpoints/:id` | Removes endpoint and flushes circuit breaker state |
| `GET` | `/webhooks/dlq` | **Lists Dead Letter Queue delivery failures** |
| `POST` | `/webhooks/dlq/:deliveryId/replay` | **Manually re-drives a single failed delivery** |
| `POST` | `/webhooks/endpoints/:id/replay-all` | **Bulk re-drives all DLQ deliveries for an endpoint** |
| `POST` | `/webhooks/endpoints/:id/circuit/reset`| Admin override to reset circuit breaker to `CLOSED` |

#### Example: Register Outbound Webhook Endpoint
```bash
curl -X POST http://localhost:3000/webhooks/endpoints \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: a03a3200-b6ed-4314-b1d5-a24099a62f9a" \
  -d '{
    "url": "https://hooks.slack.com/services/T00/B00/XXXXX",
    "subscribedEvents": ["sla.warning", "sla.breach", "ticket.escalated"]
  }'
```

#### Example: Bulk Replay DLQ Deliveries for Recovered Endpoint
```bash
curl -X POST http://localhost:3000/webhooks/endpoints/11111111-1111-1111-1111-111111111111/replay-all \
  -H "x-tenant-id: a03a3200-b6ed-4314-b1d5-a24099a62f9a"
```

### 2. Skill-Based Routing & Agent Capacity (`/routing`)
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/routing/agents/:id/skills` | Registers skills, proficiency (1..5), max capacity & syncs Redis ZSETs |
| `PATCH` | `/routing/agents/:id/status` | Updates agent live status (ONLINE, BUSY, OFFLINE) and syncs Redis |
| `POST` | `/routing/auto-route` | Executes atomic Redis Lua claim or places ticket in overflow pool |
| `POST` | `/routing/match` | Workload-based route matcher (FIFO pull queue) |

### 3. Tenants & Business Calendars (`/tenants`)
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/tenants` | Onboards a new tenant |
| `GET` | `/tenants` | Lists all tenants |
| `GET` | `/tenants/me` | Returns calling tenant profile |
| `GET` | `/tenants/:id` | Returns tenant by ID |
| `PATCH` | `/tenants/:id` | Updates tenant configuration |
| `GET` | `/tenants/:id/calendar` | Retrieves business calendar & weekly schedule |
| `PUT` | `/tenants/:id/calendar` | Configures timezone, weekly schedule, or 24x7 mode |
| `GET` | `/tenants/:id/holidays` | Lists configured holidays for tenant |
| `POST` | `/tenants/:id/holidays` | Adds full or partial-day holiday exclusion |
| `DELETE` | `/tenants/:id/holidays/:holidayId` | Removes holiday exclusion |

### 4. Tickets (`/tickets`)
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/tickets` | Atomically writes Ticket, AuditLog & OutboxEvent in single transaction |
| `POST` | `/tickets/claim-next` | Atomic non-blocking claim using `FOR UPDATE SKIP LOCKED` |
| `POST` | `/tickets/:id/claim` | Claims specific ticket by UUID |
| `POST` | `/tickets/:id/transition` | State Machine transition (`ASSIGNED`, `IN_PROGRESS`, `ON_HOLD`, `RESOLVED`, `CLOSED`) |
| `GET` | `/tickets` | Filtered list with composite index execution |
| `GET` | `/tickets/:id` | Returns single ticket with audit trail |
| `GET` | `/tickets/:id/audit-logs` | Immutable audit log history |

### 5. Analytics & CQRS Dashboard (`/analytics`)
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/analytics/dashboard` | Sub-5ms Pre-aggregated Redis live metrics (fallback on miss) |
| `GET` | `/analytics/overview` | Tenant ticket counts and workload distribution |

### 6. Real-Time WebSockets (`ws://localhost:3000/events`)
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
