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

  // T-28: canonical name→code map (mapa canónico, design.md)
  const stages = [
    { name: 'Nuevo',                code: 'nuevo',                category: 'nuevo',      order: 0 },
    { name: 'Confirmado',           code: 'confirmado',           category: 'nuevo',      order: 1 },
    { name: 'Pospuesta',            code: 'pospuesta',            category: 'nuevo',      order: 2 },
    { name: 'No Factible',          code: 'no_factible',          category: 'nuevo',      order: 3 },
    { name: 'Enviar a IClass',      code: 'send_to_iclass',       category: 'nuevo',      order: 4 },
    { name: 'Registrado en IClass', code: 'registered_in_iclass', category: 'nuevo',      order: 5 },
    { name: 'Notificado',           code: 'notificado',           category: 'nuevo',      order: 6 },
    { name: 'En progreso',          code: 'en_progreso',          category: 'enProgreso', order: 7 },
    { name: 'Instalado',            code: 'instalado',            category: 'hecho',      order: 8 },
    { name: 'Hecho',                code: 'hecho',                category: 'hecho',      order: 9 },
    { name: 'Anulado-Cancelado',    code: 'anulado_cancelado',    category: 'hecho',      order: 10 },
  ]

  for (const stage of stages) {
    // Upsert by workflowId + code (unique constraint @@unique([workflowId, code]))
    const existingByCode = await (prisma as any).stage.findFirst({
      where: { workflowId: defaultWf.id, code: stage.code },
    })
    if (existingByCode) {
      // Idempotent: update name/category/order in case they drifted
      await (prisma as any).stage.update({
        where: { id: existingByCode.id },
        data: { name: stage.name, category: stage.category, order: stage.order },
      })
    } else {
      // Also check by name in case stage exists without code (pre-migration row)
      const existingByName = await (prisma as any).stage.findFirst({
        where: {
          workflowId: defaultWf.id,
          name: { equals: stage.name, mode: 'insensitive' },
        },
      })
      if (existingByName) {
        await (prisma as any).stage.update({
          where: { id: existingByName.id },
          data: { code: stage.code, category: stage.category, order: stage.order },
        })
        console.log(`  Updated stage code: ${stage.name} → ${stage.code}`)
      } else {
        await (prisma as any).stage.create({
          data: {
            workflowId: defaultWf.id,
            name: stage.name,
            code: stage.code,
            category: stage.category,
            order: stage.order,
          },
        })
        console.log(`  Created stage: ${stage.name} (${stage.code})`)
      }
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

  // T-29: RBAC seed — assign scheduling.manage + scheduling.read to 'administrador' role.
  // super_admin already has all permissions via migration (ON CONFLICT DO NOTHING).
  // 'administrador' is the RBAC-system equivalent of "admin" (roles: administrador, noc, tecnico, etc.)
  //
  // T-28 (iclass_manual_resend): ensure the permission exists in the catalog so
  // the migration grant to super_admin can resolve it. Per REQ-RBAC-RESEND-5,
  // ONLY super_admin receives this permission — it is NOT granted to administrador here.
  try {
    const adminRole = await (prisma as any).rbacRole.findUnique({ where: { code: 'administrador' } })
    if (adminRole) {
      const schedulingModule = await (prisma as any).rbacModule.findUnique({ where: { code: 'scheduling' } })
      if (schedulingModule) {
        // Ensure iclass_manual_resend permission exists in catalog (no grant to administrador).
        const existingResendPerm = await (prisma as any).rbacPermission.findFirst({
          where: { moduleId: schedulingModule.id, action: 'iclass_manual_resend' },
        })
        if (!existingResendPerm) {
          await (prisma as any).rbacPermission.create({
            data: { moduleId: schedulingModule.id, action: 'iclass_manual_resend' },
          })
          console.log('  Created RBAC permission: scheduling.iclass_manual_resend (no role grant — super_admin only via migration)')
        }
        for (const action of ['manage', 'read']) {
          let perm = await (prisma as any).rbacPermission.findFirst({
            where: { moduleId: schedulingModule.id, action },
          })
          if (!perm) {
            perm = await (prisma as any).rbacPermission.create({
              data: { moduleId: schedulingModule.id, action },
            })
            console.log(`  Created RBAC permission: scheduling.${action}`)
          }
          await (prisma as any).rbacRolePermission.upsert({
            where: { roleId_permissionId: { roleId: adminRole.id, permissionId: perm.id } },
            update: {},
            create: { roleId: adminRole.id, permissionId: perm.id },
          })
          console.log(`  RBAC: administrador → scheduling.${action} (upserted)`)
        }
      } else {
        console.warn('  RBAC seed: scheduling module not found — skipping scheduling.manage assignment')
      }
    } else {
      console.warn('  RBAC seed: administrador role not found — skipping scheduling.manage assignment')
    }
  } catch (err) {
    console.warn('  RBAC seed: scheduling.manage assignment skipped (RBAC tables may not exist yet):', (err as any).message)
  }

  console.log('  Scheduling foundation seeded.')

  // equipment-catalog: ensure inventory.manage + inventory.read granted to 'administrador' role.
  // super_admin already has all permissions via migration (ON CONFLICT DO NOTHING).
  try {
    const adminRole = await (prisma as any).rbacRole.findUnique({ where: { code: 'administrador' } })
    const inventoryModule = await (prisma as any).rbacModule.findUnique({ where: { code: 'inventory' } })
    if (adminRole && inventoryModule) {
      for (const action of ['manage', 'read']) {
        let perm = await (prisma as any).rbacPermission.findFirst({
          where: { moduleId: inventoryModule.id, action },
        })
        if (!perm) {
          perm = await (prisma as any).rbacPermission.create({
            data: { moduleId: inventoryModule.id, action },
          })
          console.log(`  Created RBAC permission: inventory.${action}`)
        }
        await (prisma as any).rbacRolePermission.upsert({
          where: { roleId_permissionId: { roleId: adminRole.id, permissionId: perm.id } },
          update: {},
          create: { roleId: adminRole.id, permissionId: perm.id },
        })
        console.log(`  RBAC: administrador → inventory.${action} (upserted)`)
      }
    } else {
      console.warn('  RBAC seed: administrador role or inventory module not found — skipping inventory.manage assignment')
    }
  } catch (err) {
    console.warn('  RBAC seed: inventory.manage assignment skipped (RBAC tables may not exist yet):', (err as any).message)
  }

  // contract-services (#43): ensure clients.manage granted to 'administrador' role.
  // Dev parity with migration 20260627000000_grant_clients_manage. The catalog ABM
  // (POST/PATCH/DELETE /api/service-catalog) is gated by clients.manage; without this
  // grant a normal administrador would get 403. super_admin already has it via migration.
  try {
    const adminRole = await (prisma as any).rbacRole.findUnique({ where: { code: 'administrador' } })
    const clientsModule = await (prisma as any).rbacModule.findUnique({ where: { code: 'clients' } })
    if (adminRole && clientsModule) {
      let perm = await (prisma as any).rbacPermission.findFirst({
        where: { moduleId: clientsModule.id, action: 'manage' },
      })
      if (!perm) {
        perm = await (prisma as any).rbacPermission.create({
          data: { moduleId: clientsModule.id, action: 'manage' },
        })
        console.log('  Created RBAC permission: clients.manage')
      }
      await (prisma as any).rbacRolePermission.upsert({
        where: { roleId_permissionId: { roleId: adminRole.id, permissionId: perm.id } },
        update: {},
        create: { roleId: adminRole.id, permissionId: perm.id },
      })
      console.log('  RBAC: administrador → clients.manage (upserted)')
    } else {
      console.warn('  RBAC seed: administrador role or clients module not found — skipping clients.manage assignment')
    }
  } catch (err) {
    console.warn('  RBAC seed: clients.manage assignment skipped (RBAC tables may not exist yet):', (err as any).message)
  }
}

/**
 * EPIC #38 W4 — flag the 2 confirmed removal result codes so a completed (Sucesso)
 * RETIRO SO closing with one of them stages equipment-return suggestions. Idempotent:
 * a plain UPDATE on existing rows (the codes are synced from IClass; we only flip the
 * flag, never create them). Re-running just re-sets true on the same rows.
 */
async function seedRemovalResultCodes() {
  const REMOVAL_CODES = ['Retiro completo Servicio Fibra', 'Retiro completo Servicio Wireless']
  try {
    const { count } = await (prisma as any).iClassResultCode.updateMany({
      where: { code: { in: REMOVAL_CODES } },
      data: { isRemovalCode: true },
    })
    console.log(`  RETURNS seed: isRemovalCode=true on ${count} result code(s)`)
  } catch (err) {
    console.warn('  RETURNS seed: removal-code flag skipped (migration may not be applied yet):', (err as any).message)
  }
}

async function main() {
  console.log('Starting seed...')
  await seedMockData()
  try {
    await seedSchedulingFoundation()
  } catch (err) {
    console.warn('  Could not seed scheduling foundation (migration may not be applied yet):', (err as any).message)
  }
  await seedRemovalResultCodes()
  await seedFromSplynx()
  console.log('Seed complete!')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
