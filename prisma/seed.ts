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

async function main() {
  console.log('Starting seed...')
  await seedMockData()
  await seedFromSplynx()
  console.log('Seed complete!')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
