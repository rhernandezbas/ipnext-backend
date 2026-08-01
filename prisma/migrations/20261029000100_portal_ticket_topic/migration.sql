-- portal-ticket-topic (BE) — el cliente del portal ELIGE un tópico al abrir un
-- reclamo, en vez de que el área salga siempre del config
-- (`config.portal.ticketAreaName`, hoy fijo en 'Soporte').
--
-- 4 columnas nuevas en TicketAreaCatalog, TODAS additive:
--   * portalVisible (default FALSE — EL LADO SEGURO): un área nueva NO se expone
--     a clientes hasta que alguien lo decida explícitamente desde el admin. Sin
--     este default, NOC/GigaRed (áreas INTERNAS) quedarían visibles por accidente.
--     `getPortalVisibleById`/`listPortalVisible` filtran por esta columna DENTRO
--     del WHERE — es la autoridad de seguridad de portal-ticket-topic.
--   * portalLabel / portalDescription (nullable): nombre y ayuda que ve el
--     CLIENTE — el área interna sigue llamándose `name` como hoy.
--     ListPortalTicketTopics cae a `name` cuando portalLabel es null.
--   * portalOrder (default 0): orden de presentación en el selector del portal.
--
-- No BEGIN/COMMIT explícito (Prisma envuelve cada migración en su propia
-- transacción).

-- AlterTable
ALTER TABLE "TicketAreaCatalog" ADD COLUMN     "portalVisible" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TicketAreaCatalog" ADD COLUMN     "portalLabel" TEXT;
ALTER TABLE "TicketAreaCatalog" ADD COLUMN     "portalDescription" TEXT;
ALTER TABLE "TicketAreaCatalog" ADD COLUMN     "portalOrder" INTEGER NOT NULL DEFAULT 0;

-- Data: marca las 3 áreas de CARA AL CLIENTE como visibles (Soporte/Facturación/
-- Administración). NOC y GigaRed son INTERNAS — quedan en el default (portalVisible
-- = false) a propósito: exponerlas sería un bug de seguridad/operación (un cliente
-- podría mandar un reclamo a una cola interna). Idempotente: filtra por `name`
-- (columna @unique) y por WHERE "portalVisible" = false, así un reintento del
-- deploy nunca pisa un label que un operador ya haya customizado a mano.
UPDATE "TicketAreaCatalog"
SET "portalVisible" = true,
    "portalLabel" = 'Problemas técnicos',
    "portalDescription" = 'No anda internet, anda lento, falla la TV',
    "portalOrder" = 1
WHERE "name" = 'Soporte' AND "portalVisible" = false;

UPDATE "TicketAreaCatalog"
SET "portalVisible" = true,
    "portalLabel" = 'Facturas y pagos',
    "portalDescription" = 'Dudas de tu factura, comprobantes, planes',
    "portalOrder" = 2
WHERE "name" = 'Facturación' AND "portalVisible" = false;

UPDATE "TicketAreaCatalog"
SET "portalVisible" = true,
    "portalLabel" = 'Mis datos y contrato',
    "portalDescription" = 'Titularidad, domicilio, datos personales',
    "portalOrder" = 3
WHERE "name" = 'Administración' AND "portalVisible" = false;
