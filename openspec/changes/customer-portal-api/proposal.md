# Proposal: portal API para la app de clientes (`/api/portal/*`)

## Intent

La app mobile de clientes (`ipnext-customer-app`, EPIC fase 2) necesita una superficie de API
propia en el backend: hoy **no existe forma de que un cliente final se autentique ni consuma su
data** — toda la API es de staff (JWT admin + permisos granulares). La data que la app muestra
(saldo, facturas, planes, tickets, tareas) **ya vive espejada** en la Postgres de Prominense; lo
que falta es la puerta de entrada segura.

Construir `/api/portal/*`: identidad de cliente (**DNI + password autogenerada**, decisión del
usuario), tokens con **audience separado** del staff, endpoints de self-service **anclados al
cliente del token** (anti-IDOR estructural), CRUD administrativo de cuentas del portal para
Prominense, y el **borrado de cuenta** que Google Play y App Store exigen.

**Decisión de arquitectura (usuario, 2026-07-29): UNA SOLA base de datos.** Se evaluó y descartó
una DB propia de la app con sync (drift, conflictos — el historial NAS/GR ya mostró el costo).
Los tickets/tareas creados desde la app SON registros de Prominense por construcción.

## Scope

### In Scope (todo BE, este repo)

1. **Identidad del portal**: tablas nuevas `PortalAccount` (credencial: DNI único + hash bcrypt,
   1 cuenta ↔ 1 cliente) y `PortalSession` (refresh tokens rotativos) — migración **aditiva**.
2. **Auth del portal**: `POST /api/portal/auth/login` (DNI + password → access JWT `aud=portal`
   corto + refresh), `refresh`, `logout`, `change-password`. Rate limit dedicado en login.
3. **Kill-switch**: el portal entero responde 503 si `ClientPortalSettings.enabled = false`
   (tabla singleton YA existente — se reusa, no se inventa un flag nuevo).
4. **CRUD admin de cuentas** (`/api/admin/portal-accounts`): crear (password autogenerada,
   mostrada UNA sola vez), regenerar password, habilitar/deshabilitar, borrar, listar. Guard con
   permiso granular nuevo (`portal.manage`) en las DOS capas (catálogo RBAC + expuesto al `/me`).
   **Provisioning MANUAL** — sin self-registration; el único beta inicial es Ronald Hernández
   (la cuenta se crea por este CRUD en prod, NO por seed).
5. **Self-service** (toda query anclada al `clientId` DEL TOKEN):
   - `GET /api/portal/me` — nombre, estado y saldo (`balanceDue`/`balanceCurrency`/`lastBalanceAt`).
   - `GET /api/portal/invoices` — facturas con vencimiento, importe, saldo, estado, `pdfUrl`, `paymentUrl`.
   - `GET /api/portal/plans` — contratos y servicios del cliente.
   - `GET /api/portal/tickets` + `GET :id` + **`POST` (crear)** — decisión del usuario: ver + crear.
   - `GET /api/portal/tasks` — SUS visitas: fecha, franja horaria y **estado público mapeado**
     (agendada/en curso/completada/cancelada) — sin técnicos ni detalle interno.
6. **Borrado de cuenta** (`DELETE /api/portal/account`): elimina la credencial del portal y sus
   sesiones. **NO** borra el `Client` del ISP (la relación contractual sigue) — así se declara en
   la privacy policy y el Data Safety form.
7. DTOs propios del portal (jamás entidades Prisma crudas) + wiring en `app.ts` con
   composition-root test.

### Out of Scope

- **El FE de Prominense** (page del CRUD de cuentas) — change aparte en el repo FE, "cuando
  llegue el momento" (usuario). Este change deja la API lista.
- **Las pantallas de la app** (`ipnext-customer-app`) — fase 3 del EPIC.
- **Canal de entrega de la password** (WhatsApp/manual) — el usuario lo decide después; mientras
  tanto la password la ve el operador al crearla/regenerarla y la entrega por el canal que elija.
- **Página web pública de borrado de cuenta** (requisito de Play): necesita el dominio/TLS
  (fase 4). El endpoint del BE queda listo; la página se monta con el dominio.
- **Pago online in-app**: v1 expone el `paymentUrl` existente de la factura; un flujo de pago
  propio es change futuro (ISP = servicio físico ⇒ sin obligación de IAP).
- Self-registration, multi-cliente por DNI, notificaciones push.

## Approach

Hexagonal como todo el repo: entidades `PortalAccount`/`PortalSession` en `domain/`, ports
(`PortalAccountRepository`, `PortalSessionRepository`) + use cases (`PortalLogin`,
`CreatePortalAccount`, `ListPortalInvoices`, `CreatePortalTicket`, `DeletePortalAccount`, …) en
`application/`, adapters Prisma + in-memory y router `portal.routes.ts` en `infrastructure/`.
TDD estricto con in-memory repos. Detalles y riesgos en `design.md`.
