import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createPrismaClient(): PrismaClient {
  const connectionString =
    process.env.DATABASE_URL ?? 'postgresql://ipnext:ipnext_secret@localhost:5432/ipnext'
  const pool = new pg.Pool({ connectionString })
  const adapter = new PrismaPg(pool)
  const logQueryLevel = process.env.PRISMA_LOG_QUERIES === 'true';
  return new PrismaClient({
    adapter,
    log: logQueryLevel ? ['query', 'warn', 'error'] : ['warn', 'error'],
  })
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
