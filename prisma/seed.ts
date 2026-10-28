import { PrismaClient, UserRole, AgentStatus, TicketPriority, TicketStatus, RoutingMode } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding Chronos development database...');

  // 1. Tenants
  const acme = await prisma.tenant.upsert({
    where: { id: 'a03a3200-b6ed-4314-b1d5-a24099a62f9a' },
    update: {},
    create: {
      id: 'a03a3200-b6ed-4314-b1d5-a24099a62f9a',
      name: 'Acme Corp',
      slug: 'acme-corp',
    },
  });

  const stark = await prisma.tenant.upsert({
    where: { id: 'b12b4300-c7fe-4425-a2e6-b35100b73e0b' },
    update: {},
    create: {
      id: 'b12b4300-c7fe-4425-a2e6-b35100b73e0b',
      name: 'Stark Industries',
      slug: 'stark-industries',
    },
  });

  const globex = await prisma.tenant.upsert({
    where: { id: 'c23c5400-d8fe-4536-a3f7-c46211c84f1c' },
    update: {},
    create: {
      id: 'c23c5400-d8fe-4536-a3f7-c46211c84f1c',
      name: 'Globex Corp',
      slug: 'globex-corp',
    },
  });

  // 2. Clean up previous seed users for clean v4 UUID IDs
  await prisma.agentSkill.deleteMany({
    where: { tenantId: { in: [acme.id, stark.id, globex.id] } },
  });
  await prisma.ticket.updateMany({
    where: { tenantId: { in: [acme.id, stark.id, globex.id] } },
    data: { assignedAgentId: null },
  });
  await prisma.user.deleteMany({
    where: { tenantId: { in: [acme.id, stark.id, globex.id] } },
  });

  const users = [
    {
      id: '00000000-0000-4000-8000-000000000001',
      tenantId: acme.id,
      name: 'Alex Rivera (Admin)',
      email: 'alex.rivera@acme.corp',
      role: UserRole.TENANT_ADMIN,
      status: AgentStatus.ONLINE,
      maxConcurrentTickets: 10,
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      tenantId: acme.id,
      name: 'Sarah Chen (Tier-3 WebRTC)',
      email: 'sarah.chen@acme.corp',
      role: UserRole.AGENT,
      status: AgentStatus.ONLINE,
      maxConcurrentTickets: 5,
    },
    {
      id: '00000000-0000-4000-8000-000000000003',
      tenantId: acme.id,
      name: 'David Kim (Billing & API)',
      email: 'david.kim@acme.corp',
      role: UserRole.AGENT,
      status: AgentStatus.BUSY,
      maxConcurrentTickets: 4,
    },
    {
      id: '00000000-0000-4000-8000-000000000010',
      tenantId: stark.id,
      name: 'Tony Stark (Admin)',
      email: 'tony@stark.corp',
      role: UserRole.TENANT_ADMIN,
      status: AgentStatus.ONLINE,
      maxConcurrentTickets: 10,
    },
    {
      id: '00000000-0000-4000-8000-000000000011',
      tenantId: stark.id,
      name: 'Peter Parker (Support Specialist)',
      email: 'peter@stark.corp',
      role: UserRole.AGENT,
      status: AgentStatus.ONLINE,
      maxConcurrentTickets: 5,
    },
    {
      id: '00000000-0000-4000-8000-000000000020',
      tenantId: globex.id,
      name: 'Hank Scorpio (Executive)',
      email: 'hank@globex.corp',
      role: UserRole.TENANT_ADMIN,
      status: AgentStatus.ONLINE,
      maxConcurrentTickets: 10,
    },
    {
      id: '00000000-0000-4000-8000-000000000021',
      tenantId: globex.id,
      name: 'Homer Simpson (Nuclear Support)',
      email: 'homer@globex.corp',
      role: UserRole.AGENT,
      status: AgentStatus.ONLINE,
      maxConcurrentTickets: 3,
    },
  ];

  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: { status: u.status, maxConcurrentTickets: u.maxConcurrentTickets },
      create: u,
    });
  }

  // 3. Agent Skills
  const skills = [
    { agentId: '00000000-0000-4000-8000-000000000002', tenantId: acme.id, skill: 'voice_webrtc', proficiency: 5 },
    { agentId: '00000000-0000-4000-8000-000000000002', tenantId: acme.id, skill: 'messaging_a2p', proficiency: 4 },
    { agentId: '00000000-0000-4000-8000-000000000003', tenantId: acme.id, skill: 'rest_api', proficiency: 5 },
    { agentId: '00000000-0000-4000-8000-000000000003', tenantId: acme.id, skill: 'billing', proficiency: 4 },
    { agentId: '00000000-0000-4000-8000-000000000011', tenantId: stark.id, skill: 'voice_webrtc', proficiency: 4 },
    { agentId: '00000000-0000-4000-8000-000000000011', tenantId: stark.id, skill: 'rest_api', proficiency: 5 },
    { agentId: '00000000-0000-4000-8000-000000000021', tenantId: globex.id, skill: 'billing', proficiency: 5 },
  ];

  for (const s of skills) {
    await prisma.agentSkill.upsert({
      where: {
        uq_agent_skill: { agentId: s.agentId, skill: s.skill },
      },
      update: { proficiency: s.proficiency },
      create: s,
    });
  }

  // 4. Default Calendars
  for (const tenant of [acme, stark, globex]) {
    await prisma.businessCalendar.upsert({
      where: { tenantId: tenant.id },
      update: {},
      create: {
        tenantId: tenant.id,
        name: `${tenant.name} Standard Calendar`,
        timezone: 'America/New_York',
        weeklySchedule: {
          monday: [{ start: '09:00', end: '17:00' }],
          tuesday: [{ start: '09:00', end: '17:00' }],
          wednesday: [{ start: '09:00', end: '17:00' }],
          thursday: [{ start: '09:00', end: '17:00' }],
          friday: [{ start: '09:00', end: '17:00' }],
          saturday: [],
          sunday: [],
        },
        is24x7: false,
      },
    });
  }

  // 5. Seed Initial Tickets for Acme Corp
  const initialTickets = [
    {
      tenantId: acme.id,
      ticketNumber: 'TCK-001001',
      title: 'Global WebRTC Media Gateway Degradation',
      description: 'Audio packet loss exceeding 15% across European RTP relays',
      priority: TicketPriority.URGENT,
      status: TicketStatus.IN_PROGRESS,
      routingMode: RoutingMode.AUTO_PUSH,
      requiredSkills: ['voice_webrtc'],
      assignedAgentId: '00000000-0000-4000-8000-000000000002', // Sarah Chen
      resolutionDueAt: new Date(Date.now() + 42 * 60 * 1000), // 42 min left (~70% elapsed)
      remainingSlaMs: BigInt(42 * 60 * 1000),
    },
    {
      tenantId: acme.id,
      ticketNumber: 'TCK-001002',
      title: 'A2P SMS Deliverability Drop on Carrier 310-410',
      description: 'Carrier network throttle causing delivery delays on transactional OTP codes',
      priority: TicketPriority.HIGH,
      status: TicketStatus.IN_PROGRESS,
      routingMode: RoutingMode.AUTO_PUSH,
      requiredSkills: ['messaging_a2p'],
      assignedAgentId: '00000000-0000-4000-8000-000000000002', // Sarah Chen
      resolutionDueAt: new Date(Date.now() + 14 * 60 * 1000), // 14 min left (>80% WARNING)
      remainingSlaMs: BigInt(14 * 60 * 1000),
      isWarningSent: true,
    },
    {
      tenantId: acme.id,
      ticketNumber: 'TCK-001003',
      title: 'OAuth2 Refresh Token Expiry Issue on Billing Portal',
      description: 'Customer unable to renew subscription due to invalid grant error',
      priority: TicketPriority.MEDIUM,
      status: TicketStatus.ON_HOLD,
      routingMode: RoutingMode.PULL_QUEUE,
      requiredSkills: ['billing', 'rest_api'],
      remainingSlaMs: BigInt(3 * 60 * 60 * 1000),
      slaPausedAt: new Date(),
    },
    {
      tenantId: acme.id,
      ticketNumber: 'TCK-001004',
      title: 'API Rate Limiting false positives on Enterprise Tier',
      description: 'Headers show 429 Too Many Requests for whitelisted IP ranges',
      priority: TicketPriority.HIGH,
      status: TicketStatus.OPEN,
      routingMode: RoutingMode.AUTO_PUSH,
      requiredSkills: ['rest_api'],
      resolutionDueAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      remainingSlaMs: BigInt(2 * 60 * 60 * 1000),
    },
    {
      tenantId: acme.id,
      ticketNumber: 'TCK-001005',
      title: 'Invoicing tax calculation precision mismatch',
      description: 'Decimal precision difference between Stripe and Chronos ledger',
      priority: TicketPriority.LOW,
      status: TicketStatus.OPEN,
      routingMode: RoutingMode.PULL_QUEUE,
      requiredSkills: ['billing'],
      resolutionDueAt: new Date(Date.now() + 22 * 60 * 60 * 1000),
      remainingSlaMs: BigInt(22 * 60 * 60 * 1000),
    },
  ];

  for (const t of initialTickets) {
    const existing = await prisma.ticket.findFirst({
      where: { ticketNumber: t.ticketNumber, tenantId: t.tenantId },
    });
    if (!existing) {
      await prisma.ticket.create({ data: t });
    }
  }

  console.log('Database seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
