-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('superadmin', 'admin', 'viewer', 'engineer', 'financial_manager', 'support_agent');

-- CreateEnum
CREATE TYPE "AdminStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('new', 'contacted', 'qualified', 'proposal_sent', 'won', 'lost');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('website', 'referral', 'cold_call', 'social_media', 'other');

-- CreateTable
CREATE TABLE "Admin" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL,
    "status" "AdminStatus" NOT NULL DEFAULT 'active',
    "twoFaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "twoFaSecret" TEXT,
    "lastLogin" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Admin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminActivityLog" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "details" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminSession" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "userAgent" TEXT,
    "city" TEXT,
    "country" TEXT,
    "loginAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_role_definitions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "permissions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_role_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "city" TEXT,
    "source" "LeadSource" NOT NULL DEFAULT 'other',
    "status" "LeadStatus" NOT NULL DEFAULT 'new',
    "assignedTo" TEXT,
    "assignedToId" TEXT,
    "interestedIn" TEXT,
    "notes" TEXT,
    "followUpDate" TIMESTAMP(3),
    "convertedAt" TIMESTAMP(3),
    "convertedClientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Partner" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "primaryEmail" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "city" TEXT,
    "country" TEXT,
    "timezone" TEXT,
    "currency" TEXT,
    "logoUrl" TEXT,
    "clientCount" INTEGER NOT NULL DEFAULT 0,
    "adminCount" INTEGER NOT NULL DEFAULT 0,
    "comision" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Partner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "fromName" TEXT NOT NULL,
    "toId" TEXT,
    "toName" TEXT,
    "clientId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'internal',
    "status" TEXT NOT NULL DEFAULT 'unread',
    "threadId" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientComment" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "read" BOOLEAN NOT NULL DEFAULT false,
    "link" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditNote" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "taxAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "relatedInvoiceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProformaInvoice" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "subtotal" DOUBLE PRECISION NOT NULL,
    "taxAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3),
    "convertedToInvoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProformaInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceHistoryEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "amount" DOUBLE PRECISION,
    "referenceId" TEXT,
    "adminId" TEXT NOT NULL,
    "adminName" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceHistoryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "companyName" TEXT NOT NULL DEFAULT 'IPNEXT',
    "timezone" TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
    "currency" TEXT NOT NULL DEFAULT 'ARS',
    "language" TEXT NOT NULL DEFAULT 'es',
    "dateFormat" TEXT NOT NULL DEFAULT 'DD/MM/YYYY',
    "invoicePrefix" TEXT NOT NULL DEFAULT 'FAC',
    "supportEmail" TEXT,
    "website" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "smtpHost" TEXT,
    "smtpPort" INTEGER NOT NULL DEFAULT 587,
    "smtpUser" TEXT,
    "smtpPassword" TEXT,
    "fromName" TEXT,
    "fromEmail" TEXT,
    "useTls" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "variables" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiToken" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "permissions" JSONB NOT NULL,
    "lastUsed" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentMethod" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB,

    CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" JSONB NOT NULL,
    "secret" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastTriggered" TIMESTAMP(3),
    "lastStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupRecord" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'completed',
    "downloadUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackupRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientPortalSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "portalUrl" TEXT,
    "allowSelfRegistration" BOOLEAN NOT NULL DEFAULT false,
    "requireEmailVerification" BOOLEAN NOT NULL DEFAULT true,
    "allowPaymentOnline" BOOLEAN NOT NULL DEFAULT false,
    "allowTicketCreation" BOOLEAN NOT NULL DEFAULT true,
    "allowServiceManagement" BOOLEAN NOT NULL DEFAULT false,
    "welcomeMessage" TEXT,
    "logoUrl" TEXT,
    "primaryColor" TEXT NOT NULL DEFAULT '#3B82F6',
    "customCss" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientPortalSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledTask" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "assignedTo" TEXT,
    "assignedToId" TEXT,
    "clientId" TEXT,
    "clientName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "scheduledDate" TEXT NOT NULL,
    "scheduledTime" TEXT NOT NULL,
    "estimatedHours" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "address" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "category" TEXT NOT NULL DEFAULT 'installation',
    "notes" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoipCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "pricePerMinute" DOUBLE PRECISION NOT NULL,
    "freeMinutes" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "VoipCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoipCdr" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "callerNumber" TEXT NOT NULL,
    "calledNumber" TEXT NOT NULL,
    "duration" INTEGER NOT NULL,
    "categoryId" TEXT,
    "categoryName" TEXT,
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'answered',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoipCdr_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoipPlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "monthlyPrice" DOUBLE PRECISION NOT NULL,
    "includedMinutes" INTEGER NOT NULL DEFAULT 0,
    "categories" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "VoipPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServicePlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "planSubtype" TEXT,
    "downloadSpeed" INTEGER,
    "uploadSpeed" INTEGER,
    "price" DOUBLE PRECISION NOT NULL,
    "billingCycle" TEXT NOT NULL DEFAULT 'monthly',
    "status" TEXT NOT NULL DEFAULT 'active',
    "description" TEXT,
    "subscriberCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ServicePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetworkDevice" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "ipAddress" TEXT,
    "macAddress" TEXT,
    "location" TEXT,
    "status" TEXT NOT NULL DEFAULT 'online',
    "model" TEXT,
    "lastSeen" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NetworkDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "minStock" INTEGER NOT NULL DEFAULT 0,
    "unitPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "supplier" TEXT,
    "location" TEXT,
    "status" TEXT NOT NULL DEFAULT 'in_stock',

    CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryProduct" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "sku" TEXT,
    "description" TEXT,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "supplier" TEXT,
    "totalStock" INTEGER NOT NULL DEFAULT 0,
    "minStock" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'in_stock',

    CONSTRAINT "InventoryProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryUnit" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "serialNumber" TEXT,
    "barcode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'available',
    "location" TEXT,
    "purchaseDate" TIMESTAMP(3),
    "purchasePrice" DOUBLE PRECISION,
    "assignedToClientId" TEXT,
    "assignedAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "InventoryUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IpNetwork" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "description" TEXT,
    "gateway" TEXT,
    "dns1" TEXT,
    "dns2" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IpNetwork_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IpPool" (
    "id" TEXT NOT NULL,
    "networkId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rangeStart" TEXT NOT NULL,
    "rangeEnd" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "IpPool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IpAssignment" (
    "id" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "clientId" TEXT,
    "clientName" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "IpAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetworkSite" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "type" TEXT NOT NULL DEFAULT 'nodo',
    "status" TEXT NOT NULL DEFAULT 'active',
    "deviceCount" INTEGER NOT NULL DEFAULT 0,
    "clientCount" INTEGER NOT NULL DEFAULT 0,
    "uplink" TEXT,
    "parentSiteId" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NetworkSite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NasServer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "radiusSecret" TEXT,
    "nasIpAddress" TEXT,
    "apiPort" INTEGER,
    "apiLogin" TEXT,
    "apiPassword" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastSeen" TIMESTAMP(3),
    "clientCount" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NasServer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RadiusConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "authPort" INTEGER NOT NULL DEFAULT 1812,
    "acctPort" INTEGER NOT NULL DEFAULT 1813,
    "coaPort" INTEGER NOT NULL DEFAULT 3799,
    "sessionTimeout" INTEGER NOT NULL DEFAULT 86400,
    "idleTimeout" INTEGER NOT NULL DEFAULT 3600,
    "interimUpdateInterval" INTEGER NOT NULL DEFAULT 300,
    "nasType" TEXT NOT NULL DEFAULT 'other',
    "enableCoa" BOOLEAN NOT NULL DEFAULT true,
    "enableAccounting" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "RadiusConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RadiusSession" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "nasId" TEXT,
    "nasName" TEXT,
    "ipAddress" TEXT,
    "macAddress" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "duration" INTEGER NOT NULL DEFAULT 0,
    "downloadBytes" BIGINT NOT NULL DEFAULT 0,
    "uploadBytes" BIGINT NOT NULL DEFAULT 0,
    "downloadMbps" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "uploadMbps" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "username" TEXT,

    CONSTRAINT "RadiusSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CpeDevice" (
    "id" TEXT NOT NULL,
    "serialNumber" TEXT,
    "model" TEXT,
    "manufacturer" TEXT,
    "type" TEXT NOT NULL,
    "macAddress" TEXT,
    "ipAddress" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unconfigured',
    "clientId" TEXT,
    "clientName" TEXT,
    "nasId" TEXT,
    "networkSiteId" TEXT,
    "firmwareVersion" TEXT,
    "lastSeen" TIMESTAMP(3),
    "signal" DOUBLE PRECISION,
    "connectedAt" TIMESTAMP(3),
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CpeDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OltDevice" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ipAddress" TEXT,
    "model" TEXT,
    "manufacturer" TEXT,
    "uplink" TEXT,
    "ponPorts" INTEGER NOT NULL DEFAULT 0,
    "totalOnus" INTEGER NOT NULL DEFAULT 0,
    "onlineOnus" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'online',
    "lastSeen" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OltDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnuDevice" (
    "id" TEXT NOT NULL,
    "serialNumber" TEXT,
    "model" TEXT,
    "oltId" TEXT NOT NULL,
    "ponPort" INTEGER,
    "onuId" INTEGER,
    "clientId" TEXT,
    "clientName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unconfigured',
    "rxPower" DOUBLE PRECISION,
    "txPower" DOUBLE PRECISION,
    "distance" DOUBLE PRECISION,
    "firmwareVersion" TEXT,
    "lastSeen" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OnuDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tr069Profile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "manufacturerModel" TEXT,
    "description" TEXT,
    "config" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "Tr069Profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tr069Device" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "clientId" TEXT,
    "clientName" TEXT,
    "profileId" TEXT,
    "lastProvisioned" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'unconfigured',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tr069Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HardwareAsset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "manufacturer" TEXT,
    "model" TEXT,
    "serialNumber" TEXT,
    "purchaseDate" TIMESTAMP(3),
    "purchasePrice" DOUBLE PRECISION,
    "location" TEXT,
    "status" TEXT NOT NULL DEFAULT 'in_use',
    "warranty" TEXT,
    "assignedTo" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HardwareAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ubicacion" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT,
    "address" TEXT,
    "province" TEXT,
    "country" TEXT NOT NULL DEFAULT 'Argentina',
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "type" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "managerName" TEXT,
    "clientCount" INTEGER NOT NULL DEFAULT 0,
    "timezone" TEXT,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ubicacion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DashboardStat" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "newClientsThisMonth" INTEGER NOT NULL DEFAULT 0,
    "activeClients" INTEGER NOT NULL DEFAULT 0,
    "openTickets" INTEGER NOT NULL DEFAULT 0,
    "pendingTickets" INTEGER NOT NULL DEFAULT 0,
    "unresponsiveDevices" INTEGER NOT NULL DEFAULT 0,
    "onlineDevices" INTEGER NOT NULL DEFAULT 0,
    "revenueThisMonth" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unpaidInvoices" INTEGER NOT NULL DEFAULT 0,
    "overdueInvoices" INTEGER NOT NULL DEFAULT 0,
    "cpuUsage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ramUsage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "diskUsage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "uptime" TEXT NOT NULL DEFAULT '0d 0h',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DashboardStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ipv6Network" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'global',
    "status" TEXT NOT NULL DEFAULT 'active',
    "description" TEXT,
    "assignedTo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ipv6Network_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "invoiceDueDays" INTEGER NOT NULL DEFAULT 10,
    "taxName" TEXT NOT NULL DEFAULT 'IVA',
    "taxRate" DOUBLE PRECISION NOT NULL DEFAULT 21,
    "taxIncluded" BOOLEAN NOT NULL DEFAULT false,
    "autoGenerateInvoices" BOOLEAN NOT NULL DEFAULT true,
    "invoiceDay" INTEGER NOT NULL DEFAULT 1,
    "lateFeeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lateFeeAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lateFeeDays" INTEGER NOT NULL DEFAULT 30,
    "reminderDays" JSONB NOT NULL DEFAULT '[7, 3, 1]',
    "currency" TEXT NOT NULL DEFAULT 'ARS',
    "currencySymbol" TEXT NOT NULL DEFAULT '$',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitoringDevice" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ipAddress" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'online',
    "lastSeen" TIMESTAMP(3),
    "uptimePercent" DOUBLE PRECISION,
    "location" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonitoringDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitoringAlert" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "message" TEXT NOT NULL,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonitoringAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Admin_email_key" ON "Admin"("email");

-- CreateIndex
CREATE INDEX "AdminActivityLog_adminId_idx" ON "AdminActivityLog"("adminId");

-- CreateIndex
CREATE INDEX "AdminActivityLog_createdAt_idx" ON "AdminActivityLog"("createdAt");

-- CreateIndex
CREATE INDEX "AdminSession_adminId_idx" ON "AdminSession"("adminId");

-- CreateIndex
CREATE UNIQUE INDEX "admin_role_definitions_name_key" ON "admin_role_definitions"("name");

-- CreateIndex
CREATE INDEX "Lead_status_idx" ON "Lead"("status");

-- CreateIndex
CREATE INDEX "Message_clientId_idx" ON "Message"("clientId");

-- CreateIndex
CREATE INDEX "Message_status_idx" ON "Message"("status");

-- CreateIndex
CREATE INDEX "ClientComment_clientId_idx" ON "ClientComment"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_number_key" ON "CreditNote"("number");

-- CreateIndex
CREATE INDEX "CreditNote_clientId_idx" ON "CreditNote"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "ProformaInvoice_number_key" ON "ProformaInvoice"("number");

-- CreateIndex
CREATE INDEX "ProformaInvoice_clientId_idx" ON "ProformaInvoice"("clientId");

-- CreateIndex
CREATE INDEX "FinanceHistoryEvent_clientId_idx" ON "FinanceHistoryEvent"("clientId");

-- CreateIndex
CREATE INDEX "FinanceHistoryEvent_occurredAt_idx" ON "FinanceHistoryEvent"("occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_token_key" ON "ApiToken"("token");

-- CreateIndex
CREATE INDEX "ScheduledTask_status_idx" ON "ScheduledTask"("status");

-- CreateIndex
CREATE INDEX "ScheduledTask_scheduledDate_idx" ON "ScheduledTask"("scheduledDate");

-- CreateIndex
CREATE INDEX "VoipCdr_clientId_idx" ON "VoipCdr"("clientId");

-- CreateIndex
CREATE INDEX "VoipCdr_startedAt_idx" ON "VoipCdr"("startedAt");

-- CreateIndex
CREATE INDEX "InventoryUnit_productId_idx" ON "InventoryUnit"("productId");

-- CreateIndex
CREATE INDEX "IpPool_networkId_idx" ON "IpPool"("networkId");

-- CreateIndex
CREATE INDEX "IpAssignment_poolId_idx" ON "IpAssignment"("poolId");

-- CreateIndex
CREATE INDEX "IpAssignment_clientId_idx" ON "IpAssignment"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "RadiusSession_sessionId_key" ON "RadiusSession"("sessionId");

-- CreateIndex
CREATE INDEX "RadiusSession_clientId_idx" ON "RadiusSession"("clientId");

-- CreateIndex
CREATE INDEX "CpeDevice_clientId_idx" ON "CpeDevice"("clientId");

-- CreateIndex
CREATE INDEX "OnuDevice_oltId_idx" ON "OnuDevice"("oltId");

-- CreateIndex
CREATE INDEX "OnuDevice_clientId_idx" ON "OnuDevice"("clientId");

-- CreateIndex
CREATE INDEX "Tr069Device_clientId_idx" ON "Tr069Device"("clientId");

-- CreateIndex
CREATE INDEX "MonitoringAlert_acknowledged_idx" ON "MonitoringAlert"("acknowledged");

-- AddForeignKey
ALTER TABLE "AdminActivityLog" ADD CONSTRAINT "AdminActivityLog_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryUnit" ADD CONSTRAINT "InventoryUnit_productId_fkey" FOREIGN KEY ("productId") REFERENCES "InventoryProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IpPool" ADD CONSTRAINT "IpPool_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "IpNetwork"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IpAssignment" ADD CONSTRAINT "IpAssignment_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "IpPool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NetworkSite" ADD CONSTRAINT "NetworkSite_parentSiteId_fkey" FOREIGN KEY ("parentSiteId") REFERENCES "NetworkSite"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnuDevice" ADD CONSTRAINT "OnuDevice_oltId_fkey" FOREIGN KEY ("oltId") REFERENCES "OltDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tr069Device" ADD CONSTRAINT "Tr069Device_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Tr069Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ubicacion" ADD CONSTRAINT "Ubicacion_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Ubicacion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
