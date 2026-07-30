# Tasks — customer-portal-api

> TDD estricto: cada task arranca por el test que falla. Orden por dependencia; F1–F3 son la
> base, F4–F6 pueden paralelizarse entre sí una vez mergeada F2.

## Fase 1 — Modelo y ports

- [x] 1.1 Migración aditiva `PortalAccount` + `PortalSession` (SQL generado con `migrate diff`,
      timestamp posterior a la última; revisar SQL antes de crear el archivo)
- [x] 1.2 Entidades de dominio + errores tipados (`PortalAccountNotFound`,
      `PortalAccountDisabled`, `InvalidPortalCredentials`, …)
- [x] 1.3 Ports `PortalAccountRepository` / `PortalSessionRepository` + adapters
      `InMemory*` (tests) y `Prisma*` (convención de naming del repo)

## Fase 2 — Auth del portal

- [x] 2.1 Generador de password autogenerada (dominio puro, formato dictable, tests de formato
      y entropía) + hash bcrypt
- [x] 2.2 `PortalLogin` (DNI+password → access `aud=portal` + refresh rotativo; 401 genérico
      único para inexistente/mal password/disabled; `mustChangePassword` en la respuesta;
      `lastLoginAt`)
- [x] 2.3 `RefreshPortalSession` (rotación estricta; reuso ⇒ revocar TODAS las sesiones) +
      `LogoutPortal` + `ChangePortalPassword` (limpia `mustChangePassword`)
- [x] 2.4 `portalAuthMiddleware` (exige `aud=portal`, cuenta activa POR REQUEST, setea
      `req.portalClientId`) + rechazo de `aud=portal` en el middleware admin — **tests cruzados
      en las DOS direcciones**
- [x] 2.5 Kill-switch `ClientPortalSettings.enabled` (503 en todo `/api/portal/*`, cache ~30 s)
      + rate limiter dedicado del login (IP+DNI) + general del portal — extender `rateLimiters.ts`
- [x] 2.6 `portal.routes.ts` (`/auth/login`, `/auth/refresh`, `/auth/logout`,
      `/auth/change-password`) + tests de ruta con supertest e in-memory

## Fase 3 — CRUD admin de cuentas

- [x] 3.1 `CreatePortalAccount` (password una vez; `dni` default del espejo GR con override;
      409 dni/cliente duplicado; 422 sin documento ni override)
- [x] 3.2 `RegeneratePortalPassword` (revoca sesiones) + `SetPortalAccountStatus` (disable
      revoca) + `DeletePortalAccountAdmin` + `ListPortalAccounts` (con nombre de cliente,
      paginado)
- [x] 3.3 Permiso `portal.manage`: catálogo RBAC + migración idempotente de seed a roles admin
      (`ON CONFLICT DO NOTHING`) + verificar que `/me` lo expone (dos capas)
- [x] 3.4 `portalAccountsAdmin.routes.ts` bajo el stack admin + guard + tests de ruta
      (incluido 403 sin permiso)

## Fase 4 — Self-service (lectura)

- [x] 4.1 `GetPortalMe` (saldo con `null` ≠ 0, `lastBalanceAt`) + DTO
- [x] 4.2 `ListPortalInvoices` (DTO sin campos internos, orden `issueDate` desc, paginado,
      `pdfUrl`/`paymentUrl` passthrough)
- [x] 4.3 `ListPortalPlans` (contratos + servicios del cliente, DTO limpio)
- [x] 4.4 `ListPortalTasks` (mapeo Stage→estado público en dominio puro con test por rama +
      desconocido⇒`en_curso`; DTO sin técnico/stage crudo; resolver "franja" con los campos
      reales de `ScheduledTask`)
- [x] 4.5 Tests anti-IDOR de CADA endpoint: dos clientes seedeados, el token de A jamás ve data
      de B (**fixtures con ≥2 elementos** — lección fixtures degenerados)

## Fase 5 — Tickets ver + crear

- [x] 5.1 `ListPortalTickets` + `GetPortalTicket` (404 indistinguible para ajeno/inexistente;
      sin comentarios internos)
- [x] 5.2 `CreatePortalTicket` (status inicial + área por catálogo según design §6 — verificar
      catálogo real de prod; validación de payload; rate limit de creación)
- [x] 5.3 Test del seam completo: POST del portal → visible por la ruta admin de tickets
      existente (mismo registro, misma DB)

## Fase 6 — Borrado de cuenta (stores)

- [x] 6.1 `DeleteMyPortalAccount` (confirma password; borra cuenta+sesiones; `Client` intacto;
      evento de auditoría; recreación posterior sin conflicto)
- [x] 6.2 Ruta `DELETE /api/portal/account` + tests (204, 401 confirmación mala, tokens muertos
      después)

## Fase 7 — Wiring, gate y cierre

- [x] 7.1 Wiring completo en `app.ts` + **composition-root test** (lección W6: el wiring se pinea)
- [x] 7.2 Gate: suite completa + `tsc --noEmit` (corridos por el orquestador)
- [x] 7.3 `sdd-verify`: matriz scenario→test de las 4 specs
- [x] 7.4 Review adversarial (4 revisores → 3 CRITICAL + 4 HIGH + 7 MEDIUM + ~12 LOW con la suite
      en verde) + fix wave 22/22 + re-review focalizada (2 MEDIUM en los propios fixes) + fix wave
      2 (3/3) → CLEAN
- [x] 7.5 Push con OK del usuario (2026-07-30, `13f0514d`, run 30517918756 verde con migraciones) +
      verificación EN VIVO: `/api/portal/*` → 503 PORTAL_DISABLED (nace DARK), settings anónimo →
      401 (fix C2 activo en prod)

## Post-change (fuera de este change, registrados en el EPIC)

- Page del CRUD en Prominense FE (repo FE, con `ui-ux-pro-max`)
- Crear la cuenta beta de Ronald Hernández EN PROD vía el CRUD (decisión de go-live del usuario:
  además prender `ClientPortalSettings.enabled`)
- Página web pública de borrado de cuenta (requiere dominio/TLS — fase 4 del EPIC)
- Canal de entrega automática de la password (decisión pendiente del usuario)
