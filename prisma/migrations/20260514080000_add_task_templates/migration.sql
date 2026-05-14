-- Add TaskTemplate model to provide reusable presets for scheduled tasks
CREATE TABLE "TaskTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'other',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TaskTemplate_name_key" ON "TaskTemplate"("name");

-- Seed initial templates so the dropdown is non-empty after deploy
INSERT INTO "TaskTemplate" ("id", "name", "description", "category", "updatedAt") VALUES
  (gen_random_uuid(), 'Instalación fibra óptica', 'Instalación de servicio de fibra óptica residencial. Llevar ONT, cable UTP cat6 y herramientas básicas.', 'installation', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Reparación de señal', 'Cliente reporta pérdida de señal. Verificar empalme en caja de distribución y conectores.', 'repair', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Mantenimiento preventivo', 'Revisión y limpieza de nodo de distribución. Llevar kit de limpieza de conectores.', 'maintenance', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Inspección de infraestructura', 'Verificación del estado de la instalación aérea o subterránea. Documentar con fotos.', 'inspection', CURRENT_TIMESTAMP);
