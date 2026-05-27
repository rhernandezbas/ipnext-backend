# Glosario del dominio — Prominense

Términos del negocio (gestión de ISP) tal como aparecen en el código. Mezcla
inglés/español tal cual está en el repo.

## Clientes y servicios

- **Cliente / Client** (`Client`, `domain/entities/customer.ts`, modelo
  `Client`): persona o empresa que contrata servicios del ISP. Identidad dual:
  `id` UUID local + ids externos opcionales `splynxId` y `grClienteId`
  (`@unique`). Tiene `status` (enum `ClientStatus`), datos de contacto, `login`
  único, y `customAttributes` (JSON) donde se guarda el payload crudo de GR.
- **Contrato / Servicio (Service)** (modelo `Service`): el servicio contratado por
  un cliente (internet, etc.). `grContratoId` lo liga al contrato de Gestión Real.
  Tiene `plan`, `status`, `startDate`. En GR el término es **contrato**; localmente
  se modela como **Service**.
- **ServicePlan** (`ServicePlan`): catálogo de planes ofrecidos.
- **Lead / Prospecto** (`Lead`, `domain/entities/lead.ts`): cliente potencial,
  aún no convertido. El use-case `ConvertLeadToClient` lo transforma en `Client`.

## Scheduling y proyectos

- **ScheduledTask / Tarea** (`ScheduledTask`, `domain/entities/scheduling.ts`):
  tarea de campo u operativa (instalación, visita técnica, etc.). Tiene
  `sequenceNumber` autoincremental, `category`, `priority` (free text, validado
  contra catálogos), una `Stage` (FK obligatoria), checklist opcional, geolocación
  (`lat`/`lng`) y `projectId` opcional. Varios campos están **marcados
  `@deprecated`** (`assignedTo`, `clientId`, `status`, `scheduledDate`…), en
  transición hacia los nuevos (`assigneeId`, `customerId`, `stageCategory`,
  `startDate`).
- **Workflow** (`Workflow`): conjunto ordenado de stages que define el flujo de
  una clase de tareas/proyectos. Hay un workflow default protegido.
- **Stage / Etapa** (`Stage`): un paso dentro de un workflow. Tiene `order`,
  `category` (enum `StageCategory`) y `color` editable. Las tareas se mueven entre
  stages (`MoveTaskToStage`, `UpdateTaskStatus`).
- **Project / Proyecto** (`Project`): agrupa tareas bajo un tipo, categoría,
  workflow, lead (admin responsable) y partners.
- **TaskTemplate** (`TaskTemplate`): plantilla de checklist asignable a una tarea.

## Catálogos editables

(Ver [ADR 0003](../adr/0003-editable-catalogs-over-enums.md).) Tablas con CRUD,
no enums:

- **TaskCategory**: `{ name, description }`. La tarea guarda el **nombre** (free
  text), no una FK — el catálogo solo alimenta el dropdown de la UI.
- **TaskPriority**: `{ name, color, weight }`. `color` = hex de la pill; `weight`
  = orden de urgencia.
- **ProjectCategory**, **ProjectType**, **AdminRoleDefinition** (respalda
  `Admin.role`, hoy `String` editable).

## Personas del sistema

- **Admin** (`Admin`): usuario operador del backoffice. `role` es un `String`
  editable respaldado por `AdminRoleDefinition` (antes era `enum AdminRole`).
  Soporta 2FA. Puede ser reporter/assignee/watcher de tareas y lead de proyectos.
- **Partner** (`Partner`): socio/contratista asociable a proyectos.

## Billing

- **Invoice / Factura** (`Invoice`): comprobante de cobro a un cliente.
- **Proforma**: factura preliminar; `ConvertToInvoice` la convierte en `Invoice`,
  `CancelProforma` la cancela.
- **CreditNote / Nota de crédito**: `CreateCreditNote`, `ApplyCreditNote`,
  `VoidCreditNote`.
- **PaymentMethod**, **Transaction**, **Payment**, **FinanceHistory**: medios de
  pago, movimientos e historial financiero.

## Red e infraestructura del ISP

- **NAS / RADIUS** (`NasServer`, `RadiusSession`): servidores de acceso y sesiones
  PPPoE/RADIUS.
- **GPON: OLT / ONU** (`gpon.ts`): equipos de fibra (OLT = central, ONU = equipo
  del abonado).
- **CPE / TR-069** (`cpe.ts`, `tr069.ts`): equipos en casa del cliente y su
  aprovisionamiento remoto.
- **IpNetwork / IpPool / Ipv6Network**: gestión de direccionamiento IP.
- **NetworkSite**, **NetworkDevice**, **HardwareAsset**, **Ubicacion**: sitios,
  dispositivos, activos y ubicaciones de la red.

## Integraciones externas

- **Splynx**: sistema legacy del que provienen tickets y billing (adapters en
  `infrastructure/adapters/splynx/`).
- **Gestión Real (GR)**: API externa (Real Software), **fuente de verdad** de
  clientes y contratos. Se espeja read-only (ver
  [ADR 0004](../adr/0004-gestion-real-readonly-mirror.md)).
  - **GrClient / GrContract** (`domain/entities/gestionReal.ts`): formas
    normalizadas del payload de GR.
  - **SyncState**: watermark del polling incremental.
  - **grClienteId / grContratoId**: business ids externos de GR.
