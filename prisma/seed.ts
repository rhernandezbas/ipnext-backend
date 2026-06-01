import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'
import axios from 'axios'
import bcrypt from 'bcryptjs'

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://ipnext:ipnext_secret@localhost:5432/ipnext'
const pool = new pg.Pool({ connectionString })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

const SPLYNX_URL = process.env.SPLYNX_API_URL || 'https://splynx.ipnext.com.ar'
const API_KEY = process.env.SPLYNX_API_KEY || 'a69232229bf7a86e1a4acab4ac4700a2'
const API_SECRET = process.env.SPLYNX_API_SECRET || '725a72d2368530ee73c079a54d43c6e3'

const splynxHeaders = {
  Authorization: `Splynx-EA key=${API_KEY},secret=${API_SECRET}`,
  'Content-Type': 'application/json',
}

async function fetchSplynx(path: string) {
  try {
    const res = await axios.get(`${SPLYNX_URL}/api/2.0/${path}`, {
      headers: splynxHeaders,
      timeout: 10000,
    })
    return res.data
  } catch (err) {
    console.warn(`  Could not fetch ${path} from Splynx:`, (err as any).message)
    return null
  }
}

async function seedMockData() {
  console.log('Seeding mock data...')

  const DEFAULT_PASSWORD_HASH = await bcrypt.hash('admin123', 10)

  // Admins
  await prisma.admin.upsert({
    where: { email: 'admin@ipnext.com.ar' },
    update: { passwordHash: DEFAULT_PASSWORD_HASH },
    create: {
      name: 'Super Admin',
      email: 'admin@ipnext.com.ar',
      role: 'superadmin',
      status: 'active',
      passwordHash: DEFAULT_PASSWORD_HASH,
    },
  })

  await prisma.admin.upsert({
    where: { email: 'carlos@ipnext.com.ar' },
    update: { passwordHash: DEFAULT_PASSWORD_HASH },
    create: {
      name: 'Carlos López',
      email: 'carlos@ipnext.com.ar',
      role: 'admin',
      status: 'active',
      passwordHash: DEFAULT_PASSWORD_HASH,
    },
  })

  // System settings singleton
  await prisma.systemSettings.upsert({
    where: { id: 'singleton' },
    update: {},
    create: {
      id: 'singleton',
      companyName: 'IPNEXT',
      timezone: 'America/Argentina/Buenos_Aires',
      currency: 'ARS',
      language: 'es',
    },
  })

  await prisma.emailSettings.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton' },
  })

  await prisma.clientPortalSettings.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton' },
  })

  await prisma.radiusConfig.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton' },
  })

  await prisma.dashboardStat.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton' },
  })

  // Service plans
  await prisma.servicePlan.createMany({
    skipDuplicates: true,
    data: [
      { name: 'Básico 10MB', type: 'internet', downloadSpeed: 10, uploadSpeed: 2, price: 2500 },
      { name: 'Estándar 30MB', type: 'internet', downloadSpeed: 30, uploadSpeed: 5, price: 4000 },
      { name: 'Premium 100MB', type: 'internet', downloadSpeed: 100, uploadSpeed: 20, price: 7500 },
      { name: 'Empresarial 200MB', type: 'internet', downloadSpeed: 200, uploadSpeed: 50, price: 15000 },
    ],
  })

  // Partners
  await prisma.partner.createMany({
    skipDuplicates: true,
    data: [
      { name: 'Zona Norte', primaryEmail: 'norte@ipnext.com.ar', city: 'Buenos Aires', country: 'Argentina', comision: 10 },
      { name: 'Zona Sur', primaryEmail: 'sur@ipnext.com.ar', city: 'La Plata', country: 'Argentina', comision: 8 },
    ],
  })

  // VoIP categories
  await prisma.voipCategory.createMany({
    skipDuplicates: true,
    data: [
      { name: 'Locales', prefix: '0', pricePerMinute: 0.5 },
      { name: 'Larga distancia', prefix: '0810', pricePerMinute: 1.2 },
      { name: 'Celulares', prefix: '15', pricePerMinute: 2.5 },
      { name: 'Internacional', prefix: '00', pricePerMinute: 8.0 },
    ],
  })

  // Admin role definitions
  await prisma.adminRoleDefinition.createMany({
    skipDuplicates: true,
    data: [
      {
        name: 'superadmin',
        description: 'Acceso total al sistema',
        isSystem: true,
        permissions: ['clients', 'tickets', 'billing', 'network', 'scheduling', 'reports', 'settings', 'admins'].map(m => ({
          module: m, actions: ['read', 'write', 'delete'],
        })),
      },
      {
        name: 'admin',
        description: 'Administrador con acceso a la mayoría de módulos',
        isSystem: true,
        permissions: [
          { module: 'clients', actions: ['read', 'write'] },
          { module: 'tickets', actions: ['read', 'write'] },
          { module: 'billing', actions: ['read', 'write'] },
          { module: 'network', actions: ['read', 'write'] },
          { module: 'scheduling', actions: ['read', 'write'] },
          { module: 'settings', actions: ['read'] },
        ],
      },
      {
        name: 'viewer',
        description: 'Solo lectura',
        isSystem: true,
        permissions: [
          { module: 'clients', actions: ['read'] },
          { module: 'tickets', actions: ['read'] },
          { module: 'billing', actions: ['read'] },
        ],
      },
    ],
  })

  // Message templates
  await prisma.messageTemplate.createMany({
    skipDuplicates: true,
    data: [
      {
        name: 'Bienvenida',
        type: 'welcome',
        subject: 'Bienvenido a {{empresa.nombre}}',
        body: 'Estimado {{cliente.nombre}},\n\nBienvenido a {{empresa.nombre}}.',
        variables: [
          { key: 'cliente.nombre', description: 'Nombre del cliente', example: 'Juan Pérez' },
          { key: 'empresa.nombre', description: 'Nombre de la empresa', example: 'IPNEXT' },
        ],
      },
      {
        name: 'Factura',
        type: 'invoice',
        subject: 'Factura {{factura.numero}} disponible',
        body: 'Estimado {{cliente.nombre}},\n\nSu factura {{factura.numero}} por ${{factura.monto}} está disponible.',
        variables: [
          { key: 'cliente.nombre', description: 'Nombre del cliente', example: 'Juan Pérez' },
          { key: 'factura.numero', description: 'Número de factura', example: 'FAC-001234' },
          { key: 'factura.monto', description: 'Monto total', example: '6500.00' },
        ],
      },
    ],
  })

  console.log('  Mock data seeded.')
}

async function seedFromSplynx() {
  console.log('Fetching real data from Splynx API...')

  const customers = await fetchSplynx('customers/customers')
  if (customers && Array.isArray(customers)) {
    console.log(`  Fetched ${customers.length} customers from Splynx`)
    await prisma.dashboardStat.update({
      where: { id: 'singleton' },
      data: {
        activeClients: customers.filter((c: any) => c.status === 'active').length,
      },
    })
  }

  const tickets = await fetchSplynx('support/tickets')
  if (tickets && Array.isArray(tickets)) {
    console.log(`  Fetched ${tickets.length} tickets from Splynx`)
    await prisma.dashboardStat.update({
      where: { id: 'singleton' },
      data: {
        openTickets: tickets.filter((t: any) => t.status === 'opened').length,
      },
    })
  }
}

async function seedSchedulingFoundation() {
  console.log('Seeding scheduling foundation (Default workflow + stages)...')

  // Upsert Default workflow
  const defaultWf = await (prisma as any).workflow.upsert({
    where: { id: 'wf-default-00000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: 'wf-default-00000000-0000-0000-0000-000000000001',
      name: 'Default',
      description: 'Default workflow seeded by scheduling-foundation-stage-model',
    },
  })

  const stages = [
    { name: 'Nuevo',                category: 'nuevo',      order: 0 },
    { name: 'Confirmado',           category: 'nuevo',      order: 1 },
    { name: 'Pospuesta',            category: 'nuevo',      order: 2 },
    { name: 'No Factible',          category: 'nuevo',      order: 3 },
    { name: 'Enviar a IClass',      category: 'nuevo',      order: 4 },
    { name: 'Registrado en IClass', category: 'nuevo',      order: 5 },
    { name: 'Notificado',           category: 'nuevo',      order: 6 },
    { name: 'En progreso',          category: 'enProgreso', order: 7 },
    { name: 'Instalado',            category: 'hecho',      order: 8 },
    { name: 'Hecho',                category: 'hecho',      order: 9 },
    { name: 'Anulado-Cancelado',    category: 'hecho',      order: 10 },
  ]

  for (const stage of stages) {
    // Upsert by workflowId + name (case-insensitive via findFirst)
    const existing = await (prisma as any).stage.findFirst({
      where: {
        workflowId: defaultWf.id,
        name: { equals: stage.name, mode: 'insensitive' },
      },
    })
    if (!existing) {
      await (prisma as any).stage.create({
        data: {
          workflowId: defaultWf.id,
          name: stage.name,
          category: stage.category,
          order: stage.order,
        },
      })
      console.log(`  Created stage: ${stage.name}`)
    }
  }

  // Upsert Default ProjectCategory and Instalacion ProjectType
  const existingCat = await (prisma as any).projectCategory.findFirst({ where: { name: { equals: 'Default Category', mode: 'insensitive' } } })
  if (!existingCat) {
    await (prisma as any).projectCategory.create({ data: { name: 'Default Category', description: 'Default project category' } })
    console.log('  Created ProjectCategory: Default Category')
  }

  const existingType = await (prisma as any).projectType.findFirst({ where: { name: { equals: 'Instalacion', mode: 'insensitive' } } })
  if (!existingType) {
    await (prisma as any).projectType.create({ data: { name: 'Instalacion', description: 'Instalacion de servicio' } })
    console.log('  Created ProjectType: Instalacion')
  }

  // Feature flags — idempotent upsert by key. Default OFF until validated in prod.
  await (prisma as any).featureFlag.upsert({
    where: { key: 'iclass-integration' },
    update: {},
    create: { key: 'iclass-integration', enabled: false },
  })
  console.log('  Feature flag seeded: iclass-integration (enabled: false)')

  // Master switch for the Gestión Real installation-order ingest. Default OFF
  // until validated in prod; flip via /feature-flags (effective next tick).
  await (prisma as any).featureFlag.upsert({
    where: { key: 'gestion-real-ingest' },
    update: {},
    create: { key: 'gestion-real-ingest', enabled: false },
  })
  console.log('  Feature flag seeded: gestion-real-ingest (enabled: false)')

  // ServiceTechnology catalog — canonical values (idempotent via skipDuplicates on unique name).
  await (prisma as any).serviceTechnology.createMany({
    data: [
      { name: 'Fiber',    description: 'Fibra óptica' },
      { name: 'DOCSIS',   description: 'Cable / HFC DOCSIS' },
      { name: 'Wireless', description: 'Enlace inalámbrico' },
      { name: 'FTTH',     description: 'Fiber to the home' },
      { name: 'HFC',      description: 'Híbrido fibra-coaxial' },
      { name: 'Radio',    description: 'Radioenlace' },
    ],
    skipDuplicates: true,
  })
  console.log('  ServiceTechnology catalog seeded (6 entries).')

  // TicketStatus catalog — canonical values (idempotent by name).
  const ticketStatuses = [
    { name: 'open',    color: '#22c55e', weight: 1 },
    { name: 'pending', color: '#f59e0b', weight: 2 },
    { name: 'closed',  color: '#94a3b8', weight: 3 },
  ]
  for (const ts of ticketStatuses) {
    await (prisma as any).ticketStatusCatalog.upsert({
      where: { name: ts.name },
      update: {},
      create: ts,
    })
    console.log(`  TicketStatus seeded: ${ts.name}`)
  }

  console.log('  Scheduling foundation seeded.')
}

async function main() {
  console.log('Starting seed...')
  await seedMockData()
  try {
    await seedSchedulingFoundation()
  } catch (err) {
    console.warn('  Could not seed scheduling foundation (migration may not be applied yet):', (err as any).message)
  }
  await seedFromSplynx()
  console.log('Seed complete!')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
