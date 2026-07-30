# Exploration — customer-portal-api

> Fase 2 del EPIC app de clientes (`ipnext-customer-app`). Superficie `/api/portal/*` en el BE
> para la app mobile de CLIENTES finales: auth + saldos, facturas, planes, tickets, tareas +
> borrado de cuenta (requisito de Play Store / App Store).
> Explorado el 2026-07-29 sobre el schema y adapters reales.

## Decisiones ya tomadas por el usuario

- Auth de clientes: **DNI + password autogenerada** (confirmado 2026-07-29, 2ª vez).
- La app es Expo+RN (`ipnext-customer-app`, repo aparte). Este change es SOLO el BE.
- TLS/dominio: lo pasa el usuario más tarde — no bloquea este change (bloquea la fase 4, stores).

## Hallazgos clave (verificados en código)

### La data que la app necesita YA está espejada localmente

| Necesidad | Fuente local | Nota |
|---|---|---|
| Saldo | `Client.balanceDue` + `balanceCurrency` + `lastBalanceAt` | sync GR; null = sin fetch aún, 0 = sin deuda |
| Facturas | `Invoice` | `amount`, `balance` (saldo GR), `dueDate`, `pdfUrl`, `couponPdfUrl`, `paymentUrl`, `status`, `lineItems`; identidad GR = `grInvoiceId` |
| Planes | `Plan` / `ServicePlan` / `ContractService` + `Contract` | contratos del cliente con sus servicios |
| Tickets | `Ticket` (FK `clientId`, `sequenceNumber`, status por catálogo `TicketStatusCatalog`) | el API admin expone `status` como string del catálogo |
| Tareas | `ScheduledTask` (FK a cliente, `sequenceNumber`, `stage`) | definir QUÉ ve el cliente (sus visitas programadas) |
| DNI | `Client.customAttributes` = `raw` COMPLETO del cliente GR (incl. `documento`) | `PrismaClientMirrorRepository` guarda `c.raw`; `domain/entities/gestionReal.ts` tipa `documento: string \| null` |

**Consecuencia**: cero dependencia de GR EN VIVO para el portal (alineado con la regla de deprecación de GR
del WORKFLOW). El lookup DNI→cliente se hace sobre el espejo local.

### Ya existe `ClientPortalSettings` (singleton, id="singleton")

`enabled` (default false), `allowSelfRegistration`, `requireEmailVerification`, `allowPaymentOnline`,
`allowTicketCreation` (default true), `allowServiceManagement`, `welcomeMessage`, `logoUrl`,
`primaryColor`, `customCss`. Herencia conceptual de Splynx. **Reusarlo como kill-switch/config del
portal** en lugar de inventar flags nuevos (verificar si tiene routes/UI de admin hoy).

### Infra de auth existente (admin)

- `src/infrastructure/adapters/jwt/JwtAuthAdapter.ts` + `authMiddleware`/`auth.middleware.ts` +
  `requirePermission.ts` + `rateLimiters.ts` (ya hay rate limiting como middleware).
- `Admin`/`AdminSession` son del staff — los clientes NO son admins. El portal necesita su PROPIA
  identidad de sesión (tabla nueva de credenciales de portal) y JWT con **audience separado**
  (`aud: portal` vs el token admin) para que un token de cliente JAMÁS pase un guard admin y viceversa.

## Riesgos / decisiones de diseño a bajar en design.md

1. **Anti-IDOR estructural**: TODA query del portal se ancla al `clientId` que sale del TOKEN —
   nunca de un param. Un solo helper/guard que resuelva `req.portalClient` y repos/use cases que
   reciben el clientId SOLO de ahí.
2. **DNI no es único garantizado** en el espejo (familias con varios contratos, datos sucios de GR):
   el lookup DNI→Client puede dar N resultados. La política (elegir/agrupar/rechazar) va a specs.
3. **`customAttributes.documento` es JSON sin índice**: el login por DNI necesita índice funcional o
   columna materializada (migración aditiva) — barrer JSON por cada login no escala.
4. **Password autogenerada**: canal de entrega a definir por el usuario (WhatsApp/SMS/email/factura).
   Hash con bcryptjs (ya en el stack). Rotación/reset y rate limit de intentos van a specs.
5. **Borrado de cuenta (stores)**: borra la CREDENCIAL del portal + datos de la app, NO el Client del
   ISP (obligación contractual/facturación sigue). Endpoint in-app + página web pública. Documentarlo
   así en la privacy policy.
6. **Tareas**: exponer solo las visibles al cliente (sus visitas), sin datos internos de técnicos.
7. **Rate limiting** en TODO el portal (login sobre todo) — extender `rateLimiters.ts`.

## Preguntas al usuario (bloquean el proposal)

1. ¿Canal de entrega de la password autogenerada? (WhatsApp ya hay infra de campañas/Chatwoot)
2. ¿El cliente puede CREAR tickets desde la app o solo verlos? (`allowTicketCreation` sugiere crear)
3. ¿Qué ve el cliente en "tareas"? ¿Sus visitas programadas (fecha/estado/franja) y nada más?
