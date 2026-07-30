# Design — customer-portal-api

## Decisiones de arquitectura

### 1. Una sola DB (cerrada con el usuario)
La app consume `/api/portal/*` sobre la Postgres de Prominense. Sin DB propia de la app, sin
sync. El aislamiento se logra por capas: audience del JWT, anti-IDOR estructural, rate limiting.
(El usuario propuso dos DBs sincronizadas; se descartó por el costo del sync — drift/conflictos,
precedentes NAS/GR del propio historial.)

### 2. Modelo de datos (migración ADITIVA, sin tocar tablas existentes)

```prisma
model PortalAccount {
  id                 String    @id @default(uuid())
  clientId           String    @unique          // 1 cuenta ↔ 1 cliente (v1)
  client             Client    @relation(fields: [clientId], references: [id], onDelete: Cascade)
  dni                String    @unique          // clave de login, materializada ACÁ
  passwordHash       String                     // bcryptjs (ya en el stack)
  status             String    @default("active") // active | disabled
  mustChangePassword Boolean   @default(true)
  lastLoginAt        DateTime?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt
}

model PortalSession {
  id         String    @id @default(uuid())
  accountId  String
  account    PortalAccount @relation(fields: [accountId], references: [id], onDelete: Cascade)
  tokenHash  String    @unique   // sha256 del refresh token opaco — NUNCA el token
  expiresAt  DateTime
  revokedAt  DateTime?
  rotatedAt  DateTime?           // marcado al rotar: un refresh se usa UNA vez
  createdAt  DateTime  @default(now())
  @@index([accountId])
}
```

**Por qué el DNI vive en `PortalAccount` y no se indexa `customAttributes`**: el login es la
ruta caliente — busca por columna única indexada, cero JSON scan. El JSON del espejo GR solo se
lee UNA vez (al crear la cuenta, para defaultear el `dni`). La ambigüedad de DNI duplicado en
GR la resuelve el OPERADOR al elegir el cliente (provisioning manual); la unicidad se garantiza
acá, no en el espejo.

### 3. Identidad: JWT audience `portal`
- Access token: 15 min, claims `{sub: portalAccountId, clientId, aud: 'portal'}`. Mismo secret
  del `JwtAuthAdapter` (rotación única), la separación es el `aud`.
- **Middleware portal** (`portalAuthMiddleware`): exige `aud === 'portal'`, carga la cuenta
  (rechaza `disabled` — el estado se chequea POR REQUEST, no solo al login) y setea
  `req.portalClientId`. Los use cases del portal reciben el `clientId` SOLO de ahí.
- **Middleware admin**: hoy los tokens de staff no llevan `aud` — se agrega el rechazo explícito
  de `aud === 'portal'` (compat: token sin `aud` sigue siendo staff válido). Test cruzado en las
  dos direcciones (spec portal-auth).
- Refresh: opaco (32 bytes random, base64url), guardado como sha256. Rotación estricta; reuso de
  un refresh rotado ⇒ revocación de TODAS las sesiones de la cuenta (señal de robo).

### 4. Kill-switch y orden de middlewares
Router `portal.routes.ts` montado bajo `/api/portal` con orden: (1) kill-switch
(`ClientPortalSettings.enabled`, cacheado ~30 s para no golpear la DB por request), (2) rate
limiter general del portal, (3) auth (salvo `/auth/login|refresh`). El CRUD admin va en router
aparte (`portalAccountsAdmin.routes.ts`) bajo el stack admin existente + `portal.manage`.

### 5. Password autogenerada
Generador criptográfico (`crypto.randomInt`) formato legible para dictado telefónico:
`XXXX-9999-XXXX` (mayúsculas sin ambiguas O/0/I/1, ~49 bits: 24^8 letras × 8^4 dígitos =
2^48.7 — corregido en fix wave L8; el "~60 bits" original sobreestimaba). Suficiente contra
ataque online: el techo real lo pone el rate limiting del login (10/15min por IP+DNI + 30/15min
por IP), no la entropía; contra offline solo protege el hash bcrypt, que es el mismo en
cualquier caso. Se muestra UNA vez en la respuesta del create/regenerate; solo persiste el
hash bcrypt (cost 10, el del repo). Nunca en logs.

### 6. Tickets del portal: defaults por catálogo
`CreatePortalTicket` usa el status inicial default del `TicketStatusCatalog` y un área del
`TicketAreaCatalog` **resuelta por nombre configurable** (env/settings, default "Atención al
cliente" o la que exista en prod — ⚠️ las áreas runtime viven SOLO en la DB de prod, memoria
`ticket-areas-noc-runtime`: verificar el catálogo real en el apply, patrón del POST de la API
externa → área NOC). Fallback si no existe el área configurada: la default del catálogo, JAMÁS
crear área nueva desde el portal. Rate limit de creación (ej. 5/hora por cuenta).

### 7. Tareas: mapeo Stage → estado público
Tabla de mapeo EN CÓDIGO (dominio puro, testeable): categorías/stages conocidos →
`agendada | en_curso | completada | cancelada`. Stage desconocido ⇒ `en_curso` (conservador,
spec). El DTO NUNCA incluye el nombre crudo del stage, técnico, materiales ni notas. Qué
constituye "franja horaria" se resuelve en apply mirando los campos reales de `ScheduledTask`
(fecha programada + estimación); si no hay franja modelada, v1 muestra fecha + turno derivado
(mañana/tarde) y se documenta.

### 8. DTOs y capas
Un DTO por recurso en `application/dto/portal/`. Regla dura del repo: jamás entidad Prisma
cruda. Use cases nuevos (uno por archivo): `PortalLogin`, `RefreshPortalSession`,
`LogoutPortal`, `ChangePortalPassword`, `CreatePortalAccount`, `RegeneratePortalPassword`,
`SetPortalAccountStatus`, `DeletePortalAccountAdmin`, `ListPortalAccounts`, `GetPortalMe`,
`ListPortalInvoices`, `ListPortalPlans`, `ListPortalTickets`, `GetPortalTicket`,
`CreatePortalTicket`, `ListPortalTasks`, `DeleteMyPortalAccount`. Ports: `PortalAccountRepository`,
`PortalSessionRepository` (+ in-memory para tests). Adapters Prisma con la convención
`Prisma{X}Repository`.

### 9. Wiring y verificación
- `app.ts`: inyección de los use cases + routers nuevos. **Composition-root test** (assertions
  estáticas sobre app.ts) para que el wiring no quede muerto (lección W6).
- El permiso `portal.manage` se agrega al catálogo RBAC + migración idempotente de seed del
  permiso para los roles admin (patrón `ON CONFLICT DO NOTHING`), y se verifica que el `/me`
  lo exponga (regla de las dos capas).
- Gate: suite completa + `tsc --noEmit` + `sdd-verify` (matriz scenario→test) + review
  adversarial ANTES del push (regla innegociable del WORKFLOW).

## Riesgos señalados

1. **Tocar el middleware admin** (rechazo de `aud=portal`) es la única modificación a código
   caliente existente — cubierta por tests cruzados en ambas direcciones y por la suite entera.
2. **`balanceDue` puede estar stale** (`lastBalanceAt` viejo): el DTO lo expone para que la app
   muestre "actualizado al …" — la frescura del saldo es la del sync GR existente, este change
   no la mejora ni la empeora.
3. **Sin cuenta de servicio del FE**: hasta que exista la page en Prominense FE, el CRUD se
   opera por API (curl/Postman con token admin) — suficiente para crear el beta.
4. **La página web de borrado** (Play) queda pendiente del dominio (fase 4) — el endpoint nace
   listo; el gap es de publicación, no de código.
