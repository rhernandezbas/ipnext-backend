-- Client module: Postgres-first replacement for the Splynx-backed clients adapter.

-- Enums
CREATE TYPE "ClientStatus" AS ENUM ('active', 'late', 'blocked', 'inactive');
CREATE TYPE "InvoiceStatus" AS ENUM ('pagada', 'pendiente', 'vencida');

-- Tables
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "splynxId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "status" "ClientStatus" NOT NULL DEFAULT 'active',
    "address" TEXT,
    "city" TEXT,
    "country" TEXT,
    "login" TEXT NOT NULL,
    "customAttributes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Client_splynxId_key" ON "Client"("splynxId");
CREATE UNIQUE INDEX "Client_login_key" ON "Client"("login");
CREATE INDEX "Client_status_idx" ON "Client"("status");
CREATE INDEX "Client_email_idx" ON "Client"("email");

CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "ip" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Service_clientId_idx" ON "Service"("clientId");
CREATE INDEX "Service_status_idx" ON "Service"("status");

ALTER TABLE "Service" ADD CONSTRAINT "Service_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ClientLog" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventType" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "ClientLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClientLog_clientId_idx" ON "ClientLog"("clientId");

ALTER TABLE "ClientLog" ADD CONSTRAINT "ClientLog_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "issueDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'pendiente',
    "lineItems" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");
CREATE INDEX "Invoice_clientId_idx" ON "Invoice"("clientId");
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");
CREATE INDEX "Invoice_dueDate_idx" ON "Invoice"("dueDate");

ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed: 8 demo clients with services, a few logs, sample invoices.
-- All ids are stable UUIDs so the seed is idempotent if rerun manually.

WITH c AS (
  INSERT INTO "Client" ("id","name","email","phone","status","address","city","country","login","updatedAt") VALUES
    ('c0000001-0000-0000-0000-000000000001','Juan García','juan.garcia@example.com','+54 911 5550-0001','active','Av. Corrientes 1234','Buenos Aires','Argentina','jgarcia',CURRENT_TIMESTAMP),
    ('c0000002-0000-0000-0000-000000000002','María López','maria.lopez@example.com','+54 911 5550-0002','active','San Martín 567','Córdoba','Argentina','mlopez',CURRENT_TIMESTAMP),
    ('c0000003-0000-0000-0000-000000000003','Carlos Pérez','carlos.perez@example.com','+54 911 5550-0003','late','Belgrano 789','Rosario','Argentina','cperez',CURRENT_TIMESTAMP),
    ('c0000004-0000-0000-0000-000000000004','Ana Martínez','ana.martinez@example.com','+54 911 5550-0004','active','Mitre 432','Mendoza','Argentina','amartinez',CURRENT_TIMESTAMP),
    ('c0000005-0000-0000-0000-000000000005','Roberto Silva','roberto.silva@example.com','+54 911 5550-0005','blocked','Rivadavia 2345','Buenos Aires','Argentina','rsilva',CURRENT_TIMESTAMP),
    ('c0000006-0000-0000-0000-000000000006','Lucía Fernández','lucia.fernandez@example.com','+54 911 5550-0006','active','Pellegrini 121','La Plata','Argentina','lfernandez',CURRENT_TIMESTAMP),
    ('c0000007-0000-0000-0000-000000000007','Diego Romero','diego.romero@example.com','+54 911 5550-0007','inactive','Sarmiento 980','Mar del Plata','Argentina','dromero',CURRENT_TIMESTAMP),
    ('c0000008-0000-0000-0000-000000000008','Empresa Norte SA','contacto@norte-sa.com.ar','+54 911 5550-0008','active','Av. del Libertador 5000','Buenos Aires','Argentina','norte-sa',CURRENT_TIMESTAMP)
  RETURNING "id"
)
SELECT 1 FROM c;

-- Services per client
INSERT INTO "Service" ("id","clientId","type","plan","ip","status","startDate") VALUES
  (gen_random_uuid(),'c0000001-0000-0000-0000-000000000001','internet','Fibra 300 Mbps','192.168.1.101','active','2024-01-15'),
  (gen_random_uuid(),'c0000002-0000-0000-0000-000000000002','internet','Fibra 500 Mbps','192.168.1.102','active','2024-03-20'),
  (gen_random_uuid(),'c0000002-0000-0000-0000-000000000002','voip','Plan voz hogar',NULL,'active','2024-03-20'),
  (gen_random_uuid(),'c0000003-0000-0000-0000-000000000003','internet','Fibra 100 Mbps','192.168.1.103','suspended','2023-11-10'),
  (gen_random_uuid(),'c0000004-0000-0000-0000-000000000004','internet','Fibra 1 Gbps','192.168.1.104','active','2024-06-01'),
  (gen_random_uuid(),'c0000006-0000-0000-0000-000000000006','internet','Fibra 300 Mbps','192.168.1.106','active','2024-08-12'),
  (gen_random_uuid(),'c0000008-0000-0000-0000-000000000008','internet','Empresa 10 Gbps','192.168.1.108','active','2024-02-01'),
  (gen_random_uuid(),'c0000008-0000-0000-0000-000000000008','voip','Centralita 20 internos',NULL,'active','2024-02-01');

-- Logs (a couple per client)
INSERT INTO "ClientLog" ("id","clientId","eventType","description","timestamp") VALUES
  (gen_random_uuid(),'c0000001-0000-0000-0000-000000000001','signup','Cliente dado de alta',CURRENT_TIMESTAMP - INTERVAL '60 days'),
  (gen_random_uuid(),'c0000001-0000-0000-0000-000000000001','payment','Pago factura #FAC-001 - $4500',CURRENT_TIMESTAMP - INTERVAL '15 days'),
  (gen_random_uuid(),'c0000003-0000-0000-0000-000000000003','suspended','Servicio suspendido por mora',CURRENT_TIMESTAMP - INTERVAL '8 days'),
  (gen_random_uuid(),'c0000005-0000-0000-0000-000000000005','blocked','Cliente bloqueado a pedido',CURRENT_TIMESTAMP - INTERVAL '20 days'),
  (gen_random_uuid(),'c0000008-0000-0000-0000-000000000008','signup','Alta cliente corporativo',CURRENT_TIMESTAMP - INTERVAL '90 days'),
  (gen_random_uuid(),'c0000008-0000-0000-0000-000000000008','upgrade','Upgrade a plan 10 Gbps',CURRENT_TIMESTAMP - INTERVAL '30 days');

-- Invoices (a handful)
INSERT INTO "Invoice" ("id","number","clientId","customerName","issueDate","dueDate","amount","status","lineItems") VALUES
  (gen_random_uuid(),'FAC-2026-0001','c0000001-0000-0000-0000-000000000001','Juan García','2026-04-01','2026-04-15',4500.00,'pagada','[{"description":"Fibra 300 Mbps","quantity":1,"unitPrice":4500,"total":4500}]'),
  (gen_random_uuid(),'FAC-2026-0002','c0000002-0000-0000-0000-000000000002','María López','2026-04-01','2026-04-15',7800.00,'pagada','[{"description":"Fibra 500 Mbps","quantity":1,"unitPrice":6500,"total":6500},{"description":"Plan voz hogar","quantity":1,"unitPrice":1300,"total":1300}]'),
  (gen_random_uuid(),'FAC-2026-0003','c0000003-0000-0000-0000-000000000003','Carlos Pérez','2026-04-01','2026-04-15',3200.00,'vencida','[{"description":"Fibra 100 Mbps","quantity":1,"unitPrice":3200,"total":3200}]'),
  (gen_random_uuid(),'FAC-2026-0004','c0000004-0000-0000-0000-000000000004','Ana Martínez','2026-05-01','2026-05-15',12500.00,'pendiente','[{"description":"Fibra 1 Gbps","quantity":1,"unitPrice":12500,"total":12500}]'),
  (gen_random_uuid(),'FAC-2026-0005','c0000008-0000-0000-0000-000000000008','Empresa Norte SA','2026-05-01','2026-05-15',85000.00,'pendiente','[{"description":"Empresa 10 Gbps","quantity":1,"unitPrice":75000,"total":75000},{"description":"Centralita 20 internos","quantity":1,"unitPrice":10000,"total":10000}]');
