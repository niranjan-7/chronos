# Chronos ⏱️

> **Production-Grade, Multi-Tenant, Event-Driven Routing and SLA Orchestration Engine**  
> Built with NestJS (TypeScript, Strict Mode), Next.js 15 (App Router, React 19, Tailwind CSS), PostgreSQL 16, Prisma ORM, Redis (BullMQ & Lua Scripts), Socket.io, Luxon, and Docker.

---

## 🏗️ System Architecture Overview

Chronos is an enterprise-grade ticket routing and SLA orchestration engine designed for high-concurrency, multi-tenant operations with zero cross-tenant data leakage, sub-millisecond CQRS read analytics, non-blocking ticket claiming, timezone-aware business calendar SLA tracking, transactional outbox zero-loss event publishing, automated SLA breach escalations, high-throughput skill-based auto-routing, enterprise outbound webhook dispatching with HMAC-SHA256 signatures, a **horizontally scalable real-time WebSocket War-Room Gateway backed by Redis Pub/Sub**, and an interactive mission-control frontend (`chronos-web`) equipped with a live Concurrency & Chaos Simulator.

```
                              ┌───────────────────────────────────┐
                              │    Client (HTTP / WebSocket)      │
                              │    chronos-web (Next.js 15 UI)    │
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
        │ • Burst Simulator    │    └──────────┬───────────┘               ▼
        └──────────┬───────────┘               │                ┌──────────────────────┐
                   │ (ACID Transaction)        │                │   WebhooksModule     │
                   ▼                           │                │ • AES-256-GCM Secret │
        ┌──────────────────────┐               │                │ • HMAC-SHA256 Sign   │
        │    PostgreSQL 16     │               │                │ • Redis Circuit Brk  │
        │ • Tickets & Audits   │               │                │ • 5s Hard Timeout    │
        │ • agent_skills       │               │                │ • Jitter Backoff     │
        │ • webhook_endpoints  │               │                │ • Dead Letter Queue  │
        │ • outbox_events      │               │                │ • DLQ Replay Engine  │
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
        │ • Deadline Calc API  │            │ • Business Schedules │
        └──────────────────────┘            └──────────────────────┘
```

---

## ⚡ Core Engineering Pillars

### 1. Frontend Mission-Control Dashboard (`chronos-web`) (Phases 10, 11 & 12)
- **Linear/Vercel-Inspired Dark Theme System**:
  - High-contrast operational shell built on Next.js 15 (App Router, React 19, TypeScript strict mode) and Tailwind CSS.
  - Deep `slate-950` canvas (`#020617`), subtle `slate-800` borders, and semantic status telemetry:
    - **Emerald** (`emerald-400`): Healthy queue status, active connections, and in-business-hours operation.
    - **Amber** (`amber-400`): SLA Warnings ($\ge 80\%$ duration limit) and half-open circuit probes.
    - **Rose with Pulsing Glow** (`rose-400` / `animate-pulse-glow`): SLA Breaches ($100\%$ limit) and tripped circuit breakers.
    - **Cyan** (`cyan-400`): Paused / `ON_HOLD` tickets and frozen business-schedule intervals.
- **4 Operational Hub Routes**:
  - **`/war-room`**: Real-time SLA Countdown Grid, live incident stream, pre-aggregated CQRS metric counters (`Active Open`, `At-Risk ≥80%`, `Breached 100%`, `Paused On-Hold`, `Agent Capacity`), and priority tabs.
  - **`/workspace`**: Agent Queue & Claiming Desk, live status toggle (`ONLINE`, `BUSY`, `OFFLINE`), registered skill proficiency badges (1–5 stars), live capacity meter ($3/5$ load), atomic claim CTA (`POST /tickets/claim-next`), and `<TicketDetailDrawer />` enforcing strict lifecycle transitions with an immutable `<AuditLogTimeline />`.
  - **`/admin/calendars`**: IANA Timezone selector with live local clock, real-time operating pill (`IN BUSINESS HOURS` vs `OUTSIDE BUSINESS HOURS (SLA FROZEN)`), 7-day visual weekly schedule matrix, Holiday Calendar manager, and interactive **"SLA Deadline Calculator Preview"** card with roll-over arithmetic traces.
  - **`/admin/webhooks`**: Enterprise outbound webhooks, HMAC-SHA256 signatures, Redis sliding-window circuit breaker monitors (`CLOSED - Healthy`, `HALF_OPEN - Probing`, `OPEN - Tripped`), delivery log inspection drawer, and Dead Letter Queue (DLQ) 1-click re-drives (`POST /webhooks/dlq/:id/replay`).
- **Interactive Concurrency & Chaos Simulator Drawer (`<ChaosSimulatorDrawer />`)**:
  - Pinned floating DevTools drawer accessible from every page for live demos:
    - **"Simulate 20 Ticket Burst"**: Rapidly dispatches 20 tickets across randomized priorities and skill tags to light up the War-Room counters and auto-routing ZSETs.
    - **"Test SKIP LOCKED Race Condition (50 Concurrent Claims)"**: Fires 50 simultaneous `Promise.all` requests against `/tickets/claim-next` and renders a 50-cell visual claim matrix proving **0 duplicate collisions** under extreme concurrency.
    - **"Trip Webhook Circuit Breaker"**: Simulates 10 rapid 500-error webhook delivery callbacks to trip the Redis circuit breaker from `CLOSED` to `OPEN` in real time with an active cooldown countdown.

---

### 2. Live War-Room Countdown Matrix & 60fps Animation (Phase 11)
- **High-Performance Non-Thrashing Countdown (`<SlaCountdownTimer />`)**:
  - Employs a pure `requestAnimationFrame` loop updating text and progress bar widths via direct DOM references at 60fps. Eliminates React re-rendering thrashing across 20+ simultaneous countdown timers.
  - **Visual Threshold Tiers**:
    - **$< 80\%$ elapsed**: Emerald progress bar (`bg-emerald-500`).
    - **$80\% - 99\%$ elapsed (`WARNING`)**: Amber glowing border (`border-amber-500/40`) and warning badge.
    - **$100\%$ elapsed (`BREACHED`)**: Rose pulsing border (`border-rose-500/60`, `animate-pulse-glow`) and automatic corner `<BreachToastContainer />` alert.
    - **`ON_HOLD`**: Cyan `"FROZEN"` badge where the millisecond timer visibly locks in place until resumed.
- **Strict Ticket State Machine Desk & Audit Log Timeline**:
  - Enforces allowed transitions: `ASSIGNED` $\rightarrow$ `IN_PROGRESS` $\rightarrow$ `ON_HOLD` $\rightleftharpoons$ `IN_PROGRESS` $\rightarrow$ `RESOLVED` $\rightarrow$ `CLOSED`.
  - Prohibits illegal transitions (e.g. `OPEN` to `CLOSED`) with explanatory disabled tooltips.
  - Displays vertical immutable audit log entries with actor attribution, previous/new status badges, and timestamped SLA snapshots.

---

### 3. Timezone-Aware Business Hours & SLA Policy Calculator (Phase 5 & 12)
- **Tenant-Specific Business Calendars (`BusinessCalendars` & `TenantHolidays`)**:
  - Supports arbitrary IANA timezones (e.g., `America/New_York`, `Asia/Kolkata`, `Europe/London`), custom weekly active shifts (Mon–Fri 09:00–17:00), and holiday exclusions.
- **Deterministic Wall-Clock Calculator (`SlaCalendarCalculatorService` & Client Engine)**:
  - Takes `(startTimestamp, slaTargetMs, weeklySchedule, holidays, timezone)` and calculates exact wall-clock UTC and local timestamps for 80% (Warning) and 100% (Breach) deadlines counting **only active business operating milliseconds**.
  - **Friday 16:30 Roll-Over Proof**: A ticket with a 4-hour (14,400,000ms) SLA arriving on Friday at 16:30 uses 30 minutes before the 17:00 shift close, freezes across Saturday and Sunday, resumes Monday at 09:00, reaches Warning at 11:42 (80%), and breaches at 12:30 (100%).
- **Interactive Server & Client Simulator**:
  - Available on the frontend preview card and via `POST /sla/policies/calculate-deadline`.

---

### 4. Enterprise Outbound Webhooks with Redis Circuit Breaker (Phase 8 & 12)
- **AES-256-GCM Secret Encryption at Rest**:
  - Signing secrets are never stored in plaintext. They are encrypted at rest with authenticated AES-256-GCM (`enc:v1:<iv>:<auth_tag>:<ciphertext>`).
- **Cryptographic Request Signing**:
  - Outbound HTTP requests carry `X-Chronos-Signature: t={unix_timestamp},v1={HMAC_SHA256(timestamp + "." + raw_json_body, signing_secret)}`.
  - Replay attack protection with strict 300-second timestamp tolerance and timing-safe equality checks.
  - Receiver idempotency guaranteed via unique `X-Chronos-Delivery-Id` UUID header.
- **Strict 5-Second Hard Timeout**:
  - Outbound HTTP dispatches utilize `AbortSignal.timeout(5000)` to terminate unresponsive external endpoints and prevent worker pool thread exhaustion.
- **Redis Sliding-Window Circuit Breaker (`CircuitBreakerService`)**:
  - **CLOSED**: Normal operation. Tracks failures in a 5-minute rolling Redis window. If failures reach 10 consecutive 5xx/timeout errors, the circuit trips to **OPEN** for 60 seconds and emits a tenant system alert.
  - **OPEN**: Fast-fails immediately with 0ms response latency without opening socket connections or dispatching HTTP requests.
  - **HALF_OPEN**: After the 60s cooldown expires, exactly 1 probe request is permitted through via atomic Redis `SET NX` lock. If the probe returns 2xx, the circuit resets to **CLOSED**; if it fails, the circuit re-trips for an extended 120s cooldown.
- **Dead Letter Queue (DLQ) & Admin Replay APIs**:
  - Failed deliveries exhaust after 5 attempts and transition to `DEAD_LETTER`.
  - Replay individual failures (`POST /webhooks/dlq/:deliveryId/replay`) or mass replay all failures (`POST /webhooks/endpoints/:id/replay-all`).

---

### 5. Horizontally Scalable WebSocket War-Room Gateway (Phase 9)
- **Redis Pub/Sub Adapter (`RedisIoAdapter`)**:
  - Enables multiple containerized Chronos API replicas to broadcast real-time telemetry across cluster nodes seamlessly without sticky sessions or message drops.
- **Multi-Tenant Handshake Authentication & Strict Room Isolation (`WarRoomGateway`)**:
  - Authenticates WebSocket clients at connection time via JWT tokens in `client.handshake.auth.token`.
  - Automatically partitions clients into isolated Socket.IO rooms:
    - `tenant:${tenantId}:war-room`: Broadcasts tenant-wide operational metrics, queue counts, and SLA warnings/breaches.
    - `tenant:${tenantId}:agent:${userId}`: Delivers personal push-routed ticket assignments directly to the matched agent.
- **Throttled / Debounced Metrics Broadcast (250ms Rate-Limit)**:
  - Merges rapid deltas into a consolidated payload broadcast at most once every 250ms per tenant, eliminating browser UI thrashing.

---

### 6. High-Throughput Skill-Based Auto-Routing Engine (Phase 7)
- **Redis Live Capacity Index & Composite Scoring**:
  - Maintains tenant-scoped Redis Sorted Sets: `tenant:{tenantId}:skill:{skillTag}:agents`.
  - Score is an atomic composite routing score combining specialization proficiency ($1 \text{ to } 5$) and real-time available capacity ratio:
    $$\text{score} = (\text{proficiency} \times 100) + \left(\frac{\text{max\_capacity} - \text{active\_load}}{\text{max\_capacity}}\right) \times 50$$
- **Atomic Lua Claim Script (`claim_best_agent.lua`)**:
  - Inspects candidate agents in required skill `ZSET` from highest score to lowest in a single Redis round-trip.
  - Atomically increments load and updates skill ZSETs.
- **Backpressure & Overflow Queue Fallback**:
  - Saturated tickets remain in `OPEN` status within the overflow pool. Automatically drained via `SELECT ... FOR UPDATE SKIP LOCKED` when capacity is freed.

---

### 7. Atomic Non-Blocking Ticket Claim Engine (`SKIP LOCKED`)
- High-concurrency claiming via PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED`.
- When 50 concurrent agents hit `POST /tickets/claim-next` at the exact same millisecond:
  - Each transaction acquires exactly one unassigned ticket.
  - Concurrent transactions encountering locked rows **skip them immediately** without queuing or blocking database connection pools.
  - Zero deadlocks, zero lock-wait timeouts, and zero race conditions.
  - Benchmarked under load: **20 concurrent claims resolved in 22–28ms**.

---

### 8. Transactional Outbox Pattern & Zero-Loss Dual-Write Protection (Phase 6)
- **Dual-Write Vulnerability Elimination**:
  - Writes the `Ticket`, `TicketAuditLog`, and `OutboxEvent` (status `PENDING`) atomically inside the **exact same PostgreSQL ACID transaction**.
- **Hybrid Push/Poll Outbox Relay (`OutboxRelayService`)**:
  - Sub-5ms wakeups via PostgreSQL `PERFORM pg_notify('chronos_outbox_channel', NEW.id::text)`.
  - Fallback polling sweeper at `@Interval(2000)` guarantees self-healing.
  - Atomic batch fetching via `SELECT ... FOR UPDATE SKIP LOCKED` and parallel `queue.addBulk()` dispatch.

---

### 9. CQRS Read Layer & Pre-Aggregated Redis Caching
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
│      ticket_audit_logs         │    │  │      ticket_audit_logs         │
├────────────────────────────────┤    │  └────────────────────────────────┘
│ id: uuid (PK)                  │    │
│ tenant_id: uuid (FK)           │    │
│ ticket_id: uuid (FK)           │    │
│ actor_id: uuid                 │    │
│ from_status: TicketStatus      │    │
│ to_status: TicketStatus        │    │
│ reason: text                   │    │
│ sla_remaining_ms: bigint       │    │
│ created_at: timestamptz        │    │
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

# Install Frontend dependencies
cd chronos-web && npm install && cd ..
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

### 5. Start Backend & Frontend Applications
```bash
# Terminal 1: Start Backend NestJS Server (Port 3000)
npm run start:dev

# Terminal 2: Start Frontend Next.js Mission Control (Port 3001)
cd chronos-web
npm run dev -- -p 3001
```

- Backend API: `http://localhost:3000`
- Frontend Mission Control: `http://localhost:3001`
  - `/war-room`: Live Telemetry & SLA Countdown Matrix
  - `/workspace`: Agent Queue & State Machine Desk
  - `/admin/calendars`: Timezone Business Hours & SLA Policy Calculator
  - `/admin/webhooks`: Outbound Webhooks & Circuit Breaker Console

---

## 🧪 Verification & Test Suites

Chronos includes comprehensive unit test suites and real-world concurrency integration tests:

```bash
# Run all NestJS backend unit tests (104 tests passing across 13 suites)
npm test

# Run high-concurrency, outbox, SLA lifecycle, skill-routing, and chaos integration tests (56 tests passing across 11 suites)
npm run test:integration

# Build production bundles
npm run build                      # Backend NestJS build
cd chronos-web && npm run build    # Frontend Next.js App Router build
```

### Integration Test Results
```
PASS test/phase12-admin-chaos-simulator.integration.spec.ts
  Phase 12: Tenant Admin Control Plane & Concurrency Chaos Simulator (Integration)
    Timezone-Aware Business Hours & Calendar Arithmetic
      ✓ should detect when tenant is IN BUSINESS HOURS on standard weekday shift
      ✓ should detect when tenant is OUTSIDE BUSINESS HOURS (SLA FROZEN) on evening and weekend
      ✓ should detect when tenant is OUTSIDE BUSINESS HOURS on tenant holiday
      ✓ should accurately calculate Friday 16:30 SLA roll-over through weekend to Monday
      ✓ should accurately calculate SlaCalendarCalculatorService deadlines matching frontend
    Outbound Webhooks Circuit Breaker & DLQ Replay
      ✓ should trip circuit breaker to OPEN when 10 consecutive failures are recorded
      ✓ should allow manually resetting the circuit breaker to CLOSED
    Concurrency & Chaos Simulator Engine
      ✓ should simulate rapid burst of tickets with random priorities and skills
      ✓ should guarantee zero race conditions on concurrent claims (SKIP LOCKED)

PASS test/war-room-workspace-phase11.integration.spec.ts
  Phase 11: War-Room Telemetry Matrix & Workspace Agent Lifecycle (Integration)
    ✓ determines HEALTHY phase when SLA elapsed is < 80%
    ✓ determines WARNING phase when SLA elapsed is between 80% and 99%
    ✓ determines BREACHED phase when 100% SLA elapsed or ticket is flagged breached
    ✓ determines FROZEN phase when ticket is ON_HOLD and preserves remaining SLA
    ✓ enforces valid state machine lifecycle: OPEN -> ASSIGNED -> IN_PROGRESS -> ON_HOLD -> RESOLVED -> CLOSED
    ✓ rejects illegal transitions with structured exception

PASS test/war-room-telemetry.integration.spec.ts
PASS test/transactional-outbox.integration.spec.ts
PASS test/analytics-cqrs.integration.spec.ts
PASS test/sla-orchestration.integration.spec.ts
PASS test/enterprise-webhooks.integration.spec.ts
PASS test/atomic-ticket-claim.integration.spec.ts
PASS test/skill-based-routing.integration.spec.ts
PASS test/frontend-telemetry-sync.integration.spec.ts

Test Suites: 11 passed, 11 total
Tests:       56 passed, 56 total
Snapshots:   0 total
Time:        10.203 s
```

---

## 📡 API Reference

All requests to tenant-scoped endpoints require either:
- Header: `x-tenant-id: <uuid>`
- Or `Authorization: Bearer <jwt-token>` with `tenantId` claim.

### 1. Enterprise Webhooks, Circuit Breakers & DLQ (`/webhooks`)
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/webhooks/endpoints` | **Registers endpoint with AES-256-GCM secret encryption** |
| `GET` | `/webhooks/endpoints` | Lists endpoints with live Redis circuit status |
| `GET` | `/webhooks/endpoints/:id` | Returns single endpoint with circuit metrics |
| `PATCH` | `/webhooks/endpoints/:id` | Updates URL, subscribed events, or active status |
| `DELETE` | `/webhooks/endpoints/:id` | Removes endpoint and flushes circuit breaker state |
| `GET` | `/webhooks/deliveries` | **Audit log of outbound HTTP delivery attempts with latency** |
| `GET` | `/webhooks/dlq` | **Lists Dead Letter Queue delivery failures** |
| `POST` | `/webhooks/dlq/:deliveryId/replay` | **Manually re-drives a single failed delivery** |
| `POST` | `/webhooks/endpoints/:id/replay-all` | **Bulk re-drives all DLQ deliveries for an endpoint** |
| `POST` | `/webhooks/endpoints/:id/circuit/reset`| Admin override to reset circuit breaker to `CLOSED` |
| `POST` | `/webhooks/endpoints/:id/circuit/trip` | **Chaos test: Trips circuit breaker to `OPEN` for 60s** |
| `POST` | `/webhooks/endpoints/:id/circuit/simulate-failures` | **Chaos test: Injects 10 rapid 500 errors to trip circuit** |

### 2. SLA Policies & Deadline Calculator (`/sla/policies`)
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/sla/policies` | Creates an SLA policy (P1–P4) |
| `GET` | `/sla/policies` | Lists active SLA policies |
| `GET` | `/sla/policies/:id` | Returns policy by ID |
| `PATCH` | `/sla/policies/:id` | Updates response/resolution minutes |
| `POST` | `/sla/policies/calculate-deadline` | **Calculates exact Warning & Breach deadlines across working hours & holidays** |

### 3. Skill-Based Routing & Agent Capacity (`/routing`)
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/routing/agents/:id/skills` | Registers skills, proficiency (1..5), max capacity & syncs Redis ZSETs |
| `PATCH` | `/routing/agents/:id/status` | Updates agent live status (ONLINE, BUSY, OFFLINE) and syncs Redis |
| `POST` | `/routing/auto-route` | Executes atomic Redis Lua claim or places ticket in overflow pool |
| `POST` | `/routing/match` | Workload-based route matcher (FIFO pull queue) |

### 4. Tenants & Business Calendars (`/tenants`)
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

### 5. Tickets & Chaos Simulation (`/tickets`)
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/tickets` | Atomically writes Ticket, AuditLog & OutboxEvent in single transaction |
| `POST` | `/tickets/claim-next` | Atomic non-blocking claim using `FOR UPDATE SKIP LOCKED` |
| `POST` | `/tickets/:id/claim` | Claims specific ticket by UUID |
| `POST` | `/tickets/:id/transition` | State Machine transition (`ASSIGNED`, `IN_PROGRESS`, `ON_HOLD`, `RESOLVED`, `CLOSED`) |
| `POST` | `/tickets/simulate/burst` | **Chaos test: Dispatches N tickets across random priorities & skills** |
| `GET` | `/tickets` | Filtered list with composite index execution |
| `GET` | `/tickets/:id` | Returns single ticket with audit trail |
| `GET` | `/tickets/:id/audit-logs` | Immutable audit log history |

### 6. Analytics & CQRS Dashboard (`/analytics`)
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/analytics/dashboard` | Sub-5ms Pre-aggregated Redis live metrics (fallback on miss) |
| `GET` | `/analytics/overview` | Tenant ticket counts and workload distribution |

### 7. Real-Time War-Room Gateway (`ws://localhost:3000/war-room`)
Horizontally scalable, multi-replica telemetry stream authenticated via JWT:

```javascript
import { io } from 'socket.io-client';

const warRoomSocket = io('http://localhost:3000/war-room', {
  transports: ['websocket'],
  auth: {
    token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...', // JWT containing tenantId & userId
  },
});

// Acknowledged and joined to isolated tenant & agent rooms
warRoomSocket.on('authenticated', (data) => {
  console.log('Connected to War Room:', data.rooms);
});

// 80% SLA Warning Alert
warRoomSocket.on('sla.warning', (alert) => {
  console.warn(`[SLA WARNING] Ticket ${alert.ticketNumber} at risk!`, alert);
});

// 100% SLA Breach Alert with Priority Escalation
warRoomSocket.on('sla.breach', (alert) => {
  console.error(`[SLA BREACH] Ticket ${alert.ticketNumber} escalated to ${alert.priority}!`, alert);
});

// Personal Push-Routed Ticket Assignment (Delivered only to matched agent)
warRoomSocket.on('ticket.assigned', (assignment) => {
  console.log(`[ASSIGNMENT] New ticket ${assignment.ticketNumber} assigned to you!`, assignment);
});

// Debounced Metrics Telemetry (at most 1 broadcast per 250ms per tenant)
warRoomSocket.on('metrics.updated', (metrics) => {
  console.log('[METRICS DELTA]', metrics.delta);
});
```

---

## 🛡️ License

UNLICENSED. Chronos Core Team.
