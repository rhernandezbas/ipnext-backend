# Design: iclass-gps-audit

## Decisiones del usuario (2026-07-26)

| Decisión | Valor | Impacto |
|---|---|---|
| Visibilidad | **Dos permisos separados** | `technicians.location_read` (mapa en vivo, despacho/NOC) y `technicians.location_audit` (auditoría histórica, supervisión). El uso operativo NO arrastra el poder de auditar. |
| Retención propia | **12 meses** con purga | ~430k puntos/año con la dotación actual. |

## Las 7 limitaciones verificadas y cómo las resuelve el diseño

| # | Limitación (verificada 2026-07-26) | Resolución |
|---|---|---|
| 1 | **El paginado miente**: página intermedia con <100 ítems sin ser la última. Cortar ahí perdió 3.686/6.286 puntos (59%), en silencio. | `listTeamLocations` corta sólo tras **2 páginas vacías/`204` consecutivas**. Nunca usa `hasMoreElements`/`totalpages`/`totalobjects`. El contador de páginas leídas y puntos ingestados va al log de cada corrida. |
| 2 | **Sin filtro de fecha** en `/teams/{id}/locations` (sólo `pagenumber`/`pagesize`/`orderBy`). | El ingest **acumulativo** no lo necesita: pagina desde el inicio hasta alcanzar el punto más nuevo ya persistido (watermark por cuadrilla). Para consultas puntuales de una fecha vieja, **búsqueda binaria** sobre `pagenumber` (orden DESC) — probada en vivo: 5 requests vs ~50. |
| 3 | **El `id` del team no viene en `id`** (llega `null`). | Se extrae con regex del path embebido en `localizacoes` (`/teams/(\d+)/locations`). El `login` es la clave de negocio estable. |
| 4 | **El punto único da falsos negativos** (OS 4905: 1.538 m según punto único, **3 m** según rastro completo). | La auditoría **jamás** consulta `lastlocation?serviceOrderCode`. Evalúa todos los puntos de la ventana contra el rastro persistido. |
| 5 | **Rate limit `429`**. | Reusa el manejo que ya tiene `IClassClient` (throttle + backoff). Ventana no completada → se marca **incompleta**, no exitosa. |
| 6 | **Retención IClass ~30 días rolling.** | Es la razón de ser del ingest. Cadencia elegida para que ninguna ventana se pierda aun con corridas fallidas seguidas. |
| 7 | **`coordenadasFechamento` vacía (0/416 OS).** | Fuera de alcance del código. Se persiste el campo por si IClass lo habilita, pero **ninguna lógica depende de él**. Consulta al soporte en paralelo. |

## Modelo de datos (aditivo)

```
TeamLocationPoint
  id            String   @id @default(uuid())
  teamLogin     String                 // clave de negocio estable
  iclassTeamId  String                 // extraído de la URL embebida
  latitude      Float
  longitude     Float
  recordedAt    DateTime               // dataRegistro parseado (dd-MM-yyyy HH:mm:ss)
  accuracyM     Float                  // raio, VERBATIM
  sources       Int[]                  // origem(es) — dedup conserva ambas
  ingestedAt    DateTime @default(now())

  @@unique([teamLogin, recordedAt, latitude, longitude])   // dedup (limitación #4 del ingest)
  @@index([teamLogin, recordedAt])                         // consulta por ventana
  @@index([recordedAt])                                    // purga de 12 meses

TeamLocationIngestRun
  id, startedAt, finishedAt, teamsProcessed, pointsNew,
  pointsDuplicate, pointsPurged, pagesRead, incompleteTeams String[]
```

**Por qué el unique compuesto y no un id de IClass**: IClass **no da** identificador de punto. La tupla `(cuadrilla, timestamp, lat, long)` es la identidad natural; el `origem` queda **fuera** del unique a propósito, porque el mismo fix llega por dos fuentes (observado: `origem` 1 y 3 con timestamp y coordenadas idénticas) y son el mismo punto físico.

## Arquitectura (hexagonal estricta)

```
domain/
  entities/TeamLocationPoint.ts
  entities/PresenceVerdict.ts          // EN_SITIO | FUERA_DE_SITIO | NO_CONCLUYENTE | NO_AUDITABLE
  services/haversine.ts                // PURA, sin dependencias — testeable sola
  services/presenceEvaluation.ts       // PURA: puntos + ventana + umbral → veredicto
  ports/TeamLocationRepository.ts
  ports/TeamLocationSource.ts          // el port que implementa el IClassClient

application/use-cases/
  IngestTeamLocations.ts
  AuditServiceOrderPresence.ts
  ListSuspiciousClosures.ts            // pre-filtro temporal, NO toca GPS
  GetTeamsLiveStatus.ts
  GetTeamDailyJourney.ts

infrastructure/
  adapters/iclass/IClassClient.ts      // + listTeamLocations, getLastTeamLocation
  adapters/prisma/PrismaTeamLocationRepository.ts
  adapters/in-memory/InMemoryTeamLocationRepository.ts
  scheduling/TeamLocationIngestScheduler.ts   // patrón IClassClosureScheduler
  http/routes/technicianLocation.routes.ts
```

**El corazón del cambio es lógica PURA de dominio.** `presenceEvaluation` recibe una lista de puntos, una ventana y umbrales, y devuelve un veredicto. No sabe de HTTP, de Prisma ni de IClass. Por eso los casos verificados a mano se convierten en tests unitarios directos, sin infraestructura.

## Algoritmo de evaluación de presencia

```
1. Traer la OS → si falta domicilio con coords o cuadrilla → NO_AUDITABLE
2. Ventana := [primer DESLOCAMENTO|ANDAMENTO, FECHADA] del historicoStatus
   (NUNCA dataAgendamento)  ± margen (default 15 min)
3. Puntos := rastro persistido de esa cuadrilla dentro de la ventana
4. Si |Puntos| == 0 → NO_CONCLUYENTE (¡NUNCA "no estuvo"!)
5. dMin := min(haversine(domicilio, p)) sobre Puntos
6. Si dMin - accuracyM(p_más_cercano) <= umbral (default 150 m) → EN_SITIO
   Si no → FUERA_DE_SITIO
7. Devolver SIEMPRE: veredicto, dMin, hora del punto, precisión,
   |Puntos|, ventana usada y link a maps
```

El paso 6 **resta la precisión** a propósito: con un fix de `raio` 102 m, una distancia de 180 m no alcanza para condenar. Con 12.867 m y `raio` 31,8 m, ninguna imprecisión plausible lo explica.

## Cadencia del ingest

Cada **6 horas**, con watermark por cuadrilla. Fundamento: IClass retiene ~30 días; incluso 4 corridas fallidas seguidas dejan un margen enorme antes de perder dato. Más frecuente sería gastar rate limit sin ganancia — los breadcrumbs llegan cada 5-10 min y no son tiempo real.

**Para el mapa en vivo**, la posición actual se sirve del **último punto persistido**, con su antigüedad visible. No se consulta IClass en cada request (rate limit). Una cuadrilla con dato de más de 24h se marca **desactualizada** — nunca se dibuja como posición actual.

## Feature flag y rollback

Scheduler detrás del flag `iclass-gps-ingest` (patrón `pppoe-auto-move`, ya probado). Apagarlo detiene el ingest sin tocar código. Todo es aditivo: rollback = revertir commits + flag OFF; las tablas quedan huérfanas sin afectar nada.

## RBAC

Módulo `technicians` con acciones `location_read` y `location_audit`, vía migración **idempotente** (`ON CONFLICT (name) DO NOTHING`, patrón de `customer-zones-map`). Guard en **cada** ruta del BE + `RequirePermission` en el FE. La clave que consume el front usa **punto** (`technicians.location_read`), no el colon del catálogo RBAC del BE — confundirlos deja la página invisible para todos.

## Frontend

**Leaflet** (ya instalado; decisión de `customer-zones-map`: gratis, no Google Maps de pago). Reusar los átomos existentes (`DataTable`, `Tabs`, el `Select` propio — **prohibido el `<select>` nativo**), tokens `var(--color-*)`, y las 4 ramas de estado (loading/empty/error/success). Pasar por `ui-ux-pro-max` antes de escribir UI y por `review-animations` si algo se mueve.

**Regla de presentación innegociable**: `NO_CONCLUYENTE` y `NO_AUDITABLE` se muestran con **igual peso visual** que los otros veredictos, jamás como una variante apagada de "no estuvo". El color no puede ser el único indicador de estado.

## Riesgo dominante: la conclusión injusta

El modo de falla que importa no es técnico. Es que alguien lea "fuera de sitio" y actúe sobre una persona sin ver que había 0 puntos, o que el fix tenía 100 m de error. Mitigación en tres capas: el dominio devuelve `NO_CONCLUYENTE` por defecto ante falta de datos; la API expone siempre la evidencia completa; la UI la muestra junto al veredicto, sin texto que impute intención.

## Test plan (Strict TDD — test primero)

| Nivel | Qué |
|---|---|
| Dominio (puro) | Haversine contra distancias conocidas; evaluación con 0 puntos → `NO_CONCLUYENTE`; resta de precisión en el borde del umbral |
| **Casos reales como tests** | OS 4943 → `EN_SITIO` 0 m · OS 4905 → `EN_SITIO` 3 m (**y NO** 1.538 m) · OS 4995 → `FUERA_DE_SITIO`, mín 12.867 m con 16 puntos |
| Ingest (in-memory) | Página corta a mitad **no** corta el loop; dedup de `origem` 1+3; idempotencia; purga a 12 meses |
| Rutas (supertest) | Ambos permisos por separado; `location.read` **no** habilita la auditoría |
| Composition root | Test estático que pinea el wiring en `app.ts` (lección W6: rutas cableadas sin hook = feature muerta en prod con CI verde) |
