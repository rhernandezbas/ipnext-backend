# Design: PPPoE Service Foundation (Fase A)

## Contexto

Dos mundos a unir, por `pppoe`:
- **Router (verdad técnica)**: cada `/ppp secret` tiene `name` (username PPPoE), `password`, `profile`, `remote-address` (IP fija), `comment`, `disabled`, `service`, `caller-id`, `last-logged-out`. Vive en UN router (su `nasId`).
- **GR (verdad comercial)**: cliente (nombre, apellido, dirección, estado) y sus contratos, exportable a CSV.

La unión es por **username** (clave de unión confirmada por el bundle sección 5 y por la data real), con fallback fuzzy por nombre.

## Phase 0 — RESUELTO (2026-06-16, data real verificada)

**Acceso:** usuario dedicado `prominense` (grupo `write-api`; policies read/write/test/winbox/api/rest-api) en los 13 routers, API puerto 8728.

**(a) Conectividad desde la red interna:** **12/13 routers alcanzables** por API 8728. Único que NO responde desde el host probado: **Acceso Sur `10.64.10.2`** (filtrado — resolver su ruta/firewall antes del apply). El host del import debe estar en la red interna (alcanza `10.64.x`/`10.x`).

**(b) Shape real del `/ppp secret`** (muestra: Canepa `10.64.60.2`, 736 secrets, 657 sesiones activas = 89% online):

| Campo | Cobertura | Uso |
|-------|-----------|-----|
| `name` (username) | **100%** | clave de match primaria |
| `remote-address` (IP fija) | **100%** | cross-check / dato del modelo (CGNAT `100.64.x` o pública `190.x`) |
| `profile` | 100% | dato del modelo; **incluye `IP-REDUCCION`** (= profile de corte para Fase C) + `IP-Air-30-10/30-30/40-40/50-50` y variantes `-PUB` (IP pública) |
| `comment` | **43%** (318/736), NO estructurado | descartado para matching |
| dirección / apellido separado | **NO EXISTE** | — |

**Conclusiones que fijan el diseño:**
- El matching por **nombre+apellido+dirección NO es viable del lado del router** (no hay dirección; el `name` es un string concatenado `NombreApellidoLocalidad`; el comment es parcial y ruidoso).
- El **username está al 100%** → es la clave limpia (coincide con bundle §5: "Username PPPoE = clave de unión, match por nombre exacto").
- **`IP-REDUCCION` ya existe** en los routers → Fase C corta con `set profile=IP-REDUCCION` + kick, sin crear profiles nuevos.
- **Lib `node-routeros` (v1.6.8) funcionó** read-only contra producción → confirmada para el script.

**Fuente GR:** export CSV ("Exportar Usuarios" ~8431 filas + "IPs Fijas Asignadas" ~4080), decisión del usuario.

## Decisión 1 — Modelo `PppoeService` (tabla nueva, no columnas en Contract)

```
model PppoeService {
  id             String   @id @default(uuid())
  username       String   @unique            // name del /ppp secret (clave de upsert/match)
  password       String                       // verdad del router
  profile        String?                      // /ppp profile (IP-Air-* / IP-REDUCCION / *-PUB)
  remoteAddress  String?                      // remote-address (IP fija); CGNAT o pública
  status         String                       // enabled | disabled (del secret)
  nasId          String                       // router donde vive (FK NasServer)
  contractId     String?                      // FK Contract — NULLABLE (huérfanos)
  matchMethod    String?                      // username | fuzzy | manual | orphan (trazabilidad)
  importedAt     DateTime?
}
```

**Por qué tabla y no columnas en `Contract`:** cliente con **+1 contrato** → N PppoeService; ciclo de vida propio (profile/status cambian con cortes); `contractId` nullable soporta huérfanos; `username @unique` = upsert idempotente. `matchMethod` deja traza auditable de cómo se vinculó cada fila.

## Decisión 2 — El import es un SCRIPT one-off, NO feature de la app

- **App (permanente):** solo `PppoeService` + entidad + `PppoeServiceRepository`. Lo consumen B y C.
- **Script standalone** (`scripts/pppoe-import/`, ts-node): `node-routeros` directo + lectura del CSV de GR + Prisma directo. **Sin** use case/ruta/runner; NO entra al build; `node-routeros` como `devDependency` (DIP intacto). Idempotente (upsert por `username`), re-corrible.
- El adapter RouterOS "de la app" (read+write) se construye en **Fase B**.

## Decisión 3 — Matching en CASCADA (decisión del usuario, ajustada a la data)

Por cada `/ppp secret` de cada router:

1. **Username exacto** — `normalize(secret.name)` == `normalize(csv.pppoeUsername)` → vincula `contractId`, `matchMethod = username`. (Cubre la mayoría; el username está al 100% en el router.)
2. **Fallback fuzzy por nombre** — para los que NO matchean por username: parsear el `name` (`NombreApellidoLocalidad`) y comparar (token-set / distancia normalizada, umbral conservador) contra `nombre+apellido` del CSV. Único candidato sobre umbral → `matchMethod = fuzzy`. Empate/múltiples → bucket **ambiguo** (NO auto-resuelve).
3. **Huérfano** — sin match (Agote/Gowland ~500-700, **esperado**) → insertar con `contractId = null`, `matchMethod = orphan`.

**Cross-check opcional:** `remote-address` (100%) vs "IPs Fijas Asignadas" del CSV — para validar un match dudoso o detectar drift, no como clave primaria (las IPs pueden diverger, bundle §1).

**Multi-contrato:** un cliente con N contratos no se colapsa a 1 PPPoE; si el username no desambigua el contrato, va a bucket ambiguo (no adivinar).

**Salida (reporte CSV/log):** `matched-username` · `matched-fuzzy` · `orphan` (sub-conteo Agote/Gowland) · `ambiguous`. El operador revisa `fuzzy`/`ambiguous`/`orphan` antes de dar por bueno el inventario.

## Decisión 4 — Lib RouterOS: `node-routeros` (confirmada)

Validada en Phase 0 (v1.6.8, conexión read-only a prod OK). Soporta API 8728. Para el script alcanza. En Fase B (adapter de runtime con write/TLS 8729) se reconfirma o se cambia detrás del port — el use case no la conoce (DIP).

## Decisión 5 — Permanente vs one-off

| Pieza | Permanente (app) | One-off (script) |
|------|------------------|------------------|
| Tabla `PppoeService` + migración | ✅ | — |
| Entidad + `PppoeServiceRepository` | ✅ | — |
| Barrido `/ppp secret` + matching cascada + carga | — | ✅ |
| Lectura CSV de GR + reporte | — | ✅ |
| Adapter RouterOS de runtime | ⏳ Fase B | — |

## Decisión 6 — Credenciales de los routers (⚠️ seguridad, para Fase B/C)

El usuario indicó "se carga como var". **Las credenciales del usuario `prominense` (acceso a TODOS los routers) deben vivir en el BACKEND** (env var / config server-side, idealmente cifradas en `NasServer.apiPassword`), **NUNCA en el frontend/browser** — el front es público y expondría el acceso a toda la red. La UI de admin puede *gestionarlas* (formulario), pero el valor se guarda y se usa server-side. A confirmar con el usuario en el design de Fase B. (Mismo usuario/pass para los 13 → puede ser una credencial global por env, con la IP por `NasServer`.)

## Open questions (para apply / Fase B)

1. Acceso Sur `10.64.10.2` filtrado: ¿ruta/firewall a resolver, o se importa por otra IP?
2. Umbral fuzzy concreto + librería de similitud (token-set ratio vs Levenshtein normalizado) — calibrar con la primera corrida real del CSV.
3. ¿El CSV de GR trae el `pppoeUsername` en una columna? (confirmar al exportar — define el matching primario).
4. Credenciales de runtime (Decisión 6) — política exacta en Fase B.
