# Proposal: Auditoría GPS de técnicos — ingest de breadcrumbs IClass + presencia en sitio + mapa en vivo

## Intent

IClass trackea el GPS de las cuadrillas y **lo tira a los ~30 días**. Verificado en vivo (2026-07-26): 6 técnicos con rastro activo, 1 punto cada 5-10 min, precisión 4-48 m. Hoy ese dato no se usa y se pierde.

Un caso ya confirmado justifica el negocio: la **OS 4995** se cerró como *"Cliente Ausente"* con el patrón `DESLOCAMENTO → ANDAMENTO → FECHADA` en **2m16s**, mientras el dispositivo del técnico estuvo **estable a ~12,89 km** durante 2 horas (puntos a 20:23 y 20:33 rodeando la "visita" de 20:29). Nunca se acercó a menos de 8,96 km ese día.

## Scope

### In Scope
- **Ingest** periódico de breadcrumbs (`GET /teams/{id}/locations`) + catálogo de teams → tabla propia. Rompe la retención de 30 días.
- **Auditoría de presencia por OS**: distancia mínima del técnico al domicilio **durante la ventana real de trabajo** (de `historicoStatus`, NO de `dataAgendamento`), con hora, precisión y link a Maps.
- **Pre-filtro barato sin GPS**: OS con `DESLOCAMENTO→ANDAMENTO→FECHADA` bajo umbral de minutos.
- **Mapa en vivo de cuadrillas** (Leaflet, ya instalado) + jornada del día: inicio/fin, paradas, cobertura horaria.
- Permiso granular nuevo en **ambas capas** (BE guard + FE `RequirePermission`).

### Out of Scope
- Veredictos automáticos de fraude o acciones disciplinarias. La UI reporta **evidencia**, nunca acusa.
- Geocoding inverso, PostGIS, point-in-polygon, optimización de rutas.
- `coordenadasFechamento` (viene vacía en 0/416 OS — pedido al soporte de IClass, fuera de código).
- Tracking de clientes (ya cubierto por `client-geolocation` / `customer-zones-map`).

## Capabilities

### New Capabilities
- `iclass-team-location-ingest`: ingest y persistencia de breadcrumbs GPS por cuadrilla, con deduplicación y ventana propia de retención.
- `iclass-presence-audit`: verificación de presencia en sitio por OS cruzando rastro × ventana de trabajo, más el pre-filtro temporal.
- `iclass-team-live-map`: posición actual y jornada del día por técnico para despacho.

### Modified Capabilities
- `iclass-integration`: el `IClassClient` gana métodos de ubicación (`listTeamLocations`, `getLastLocation`) con paginación robusta.

## Approach

Extender el `IClassClient` existente (ya tiene login+retry, manejo de `429`, `fetchAllPages`). Scheduler de ingest siguiendo el patrón de `IClassClosureScheduler`. Cálculo de distancia (Haversine) en el **dominio**, puro y testeable. Ports + adapters Prisma/in-memory. Migración aditiva.

> Las **7 limitaciones verificadas de la API** (paginado que miente, sin filtro de fecha, `id` embebido en URLs, falso negativo del punto único, `429`, retención 30d, `coordenadasFechamento` vacía) están documentadas en la card del `BACKLOG` y en engram `iclass/gps-tracking-tecnicos`. **El `design.md` DEBE resolverlas explícitamente una por una.**

## Affected Areas

| Área | Impacto | Descripción |
|------|---------|-------------|
| `src/infrastructure/adapters/iclass/IClassClient.ts` | Modified | Métodos de ubicación + paginación robusta |
| `src/domain/` | New | Entidades `TeamLocation`/`PresenceVerdict`, distancia Haversine, ports |
| `src/application/use-cases/` | New | `IngestTeamLocations`, `AuditServiceOrderPresence`, `GetTeamsLiveStatus` |
| `src/infrastructure/scheduling/` | New | Scheduler de ingest (patrón `IClassClosureScheduler`) |
| `prisma/schema.prisma` | Modified | Tablas nuevas + migración **aditiva** |
| `src/infrastructure/http/app.ts` | Modified | Wiring (⚠️ 3326 líneas — deuda `god-object-app`) |
| `ipnext-frontend` | New | Page de auditoría + mapa Leaflet; permiso en `RequirePermission` |

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| **Conclusión injusta por dato parcial** | **Alta** | Nunca veredicto de un punto. Exigir cobertura GPS en la ventana; si el equipo no reportaba → **"no concluyente"**, jamás "no fue". Mostrar precisión y nº de puntos. |
| Paginado inconsistente pierde datos | Alta | Iterar hasta 2 páginas vacías; loguear puntos ingestados por corrida. |
| `429` corta el ingest | Media | Throttle ~0.4s + retry con backoff (ya en el client). |
| Crecimiento de tabla | Media | ~6k pts/técnico/mes × 6 ≈ 36k/mes. Índice por `(teamId, recordedAt)` + política de retención propia. |
| Colisión en `app.ts` | Media | Wiring atómico al final; composition-root test. |
| Privacidad / uso laboral | Media | Permiso granular restrictivo; el dato ya lo captura IClass. Definir **quién** puede verlo. |

## Rollback Plan

Todo es **aditivo**. Rollback = revertir los commits BE/FE y apagar el scheduler por feature flag (patrón `pppoe-auto-move`). Las tablas nuevas quedan huérfanas sin afectar nada; se dropean en una migración posterior si se confirma el descarte. **Cero cambios destructivos sobre datos existentes.**

## Dependencies

- Credenciales IClass ya en prod (el `IClassClient` ya opera contra la API).
- Leaflet ya instalado en el FE (decisión de `customer-zones-map`: gratis, no Google Maps).
- **No bloqueante**: consulta al soporte de IClass por `coordenadasFechamento`.

## Success Criteria

- [ ] El ingest corre y acumula breadcrumbs más allá de los 30 días de retención de IClass.
- [ ] La auditoría reproduce los casos verificados a mano: OS 4943 → 0 m, OS 4905 → 3 m (**no** 1538 m), OS 4995 → nunca <8,9 km.
- [ ] Una OS sin cobertura GPS en su ventana devuelve **"no concluyente"**, nunca "no estuvo".
- [ ] El pre-filtro temporal lista las OS cerradas en <5 min sin consultar GPS.
- [ ] El mapa muestra la posición actual de las cuadrillas activas y marca las que no reportan hace >24h.
- [ ] Gate verde: `npm test` + `tsc --noEmit` + `sdd-verify` con matriz de spec-compliance.
