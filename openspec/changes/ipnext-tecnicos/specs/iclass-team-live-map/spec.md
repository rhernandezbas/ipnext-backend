# Delta for iclass-team-live-map (Wave 2b)

Las lecturas (`live`, `journey`, `audit`) pasan a ver AMBOS orígenes (`source='iclass'` y `source='app'`) sin que el shape de sus respuestas cambie — mismo criterio "aditivo, sin romper contrato" del resto del EPIC.

## MODIFIED Requirements

### Requirement: Live status is exposed per team with its freshness

El sistema DEBE (MUST) exponer, por cuadrilla activa: última posición conocida, su timestamp, su precisión y un enlace al mapa.

El sistema DEBE (MUST) marcar como **desactualizada** toda cuadrilla cuyo último punto tenga más de **24 horas**.

El sistema NO DEBE (MUST NOT) presentar una posición vieja como si fuera actual: una ubicación de hace dos días en un mapa "en vivo" induce a error de despacho.

El sistema DEBE (MUST), a partir de la wave 2b, resolver "último punto conocido" tomando el MÁS RECIENTE entre `source='iclass'` y `source='app'` para la cuadrilla resuelta vía `RbacUser.iclassTeamLogin` — sin que el query de lectura necesite un `UNION` explícito por origen a nivel de consumidor (la fuente de verdad sigue siendo la MISMA tabla `TeamLocationPoint`, el filtro por `source` es transparente).

(Previously: solo consideraba filas `source='iclass'` — implícito, porque no existía otro origen.)

#### Scenario: A stale team is flagged, not hidden
- GIVEN la cuadrilla `IPNXANTONIOM` cuyo último punto es del `24-07` y hoy es `26-07`
- WHEN se consulta el estado en vivo
- THEN aparece marcada como desactualizada, con la antigüedad del dato
- AND no se dibuja como posición actual

#### Scenario: A fresh team shows as live
- GIVEN la cuadrilla `IPNXDENIC` con un punto de hace 4 minutos
- WHEN se consulta el estado en vivo
- THEN aparece como activa con su precisión

#### Scenario: An app-origin point is the freshest and drives "live"
- GIVEN la última fila de `IPNXANDYM` en IClass es de hace 3 horas, pero su técnico mandó un punto `source='app'` hace 2 minutos
- WHEN se consulta el estado en vivo
- THEN la posición mostrada es la de hace 2 minutos (la más reciente, sin importar el origen)

### Requirement: The daily journey is derived from the trail alone

El sistema DEBE (MUST) exponer por cuadrilla y día: hora del primer punto, hora del último, cantidad de puntos y su distribución horaria.

El sistema DEBE (MUST) calcular estos datos **sin depender de órdenes de servicio**.

A partir de la wave 2b, el conteo y la distribución DEBEN (MUST) incluir puntos de AMBOS orígenes para la cuadrilla del día, sin exponer el desglose por origen en la respuesta (el consumidor actual del endpoint no cambia su parsing).

(Previously: la jornada se calculaba solo sobre puntos `source='iclass'`.)

#### Scenario: Journey is available for a day without service orders
- GIVEN una cuadrilla con 29 puntos entre las 06:08 y las 09:41 y ninguna OS ese día
- WHEN se consulta su jornada
- THEN devuelve inicio `06:08`, fin `09:41`, 29 puntos y la distribución por hora

#### Scenario: Journey merges both sources into one count
- GIVEN la cuadrilla de `tech-A` tiene 12 puntos `source='app'` y 8 puntos `source='iclass'` el mismo día
- WHEN se consulta la jornada
- THEN el total reportado es 20, sin distinguir origen

## ADDED Requirements

### Requirement: The team roster read is the union of the IClass roster and app-only technician logins

`GetTeamsLiveStatus` itera hoy el roster de IClass (`source.listTeams()`) y hace join por `teamLogin` — un punto de un técnico SIN mapeo a cuadrilla (`teamLogin` sintético `tech:{rbacUserId}`, ver `tech-location-ingest` Decision 5) NUNCA aparece en ese roster. El sistema DEBE (MUST), a partir de la wave 2b, UNIR al roster de IClass los `teamLogin` que tengan puntos `source='app'` y NO estén ya en el roster — con un `name` derivado del `RbacUser` dueño de esos puntos. Sin este paso aditivo, la feature queda **inerte** exactamente para los técnicos que solo usan la app propia (el modo de falla "feature sin perilla").

#### Scenario: A solo-app technician with no IClass team mapping is drawn on the live map
- GIVEN el técnico `tech-C` sin `iclassTeamLogin` (mandó puntos con `teamLogin='tech:tech-C'`, `source='app'`)
- AND `tech:tech-C` NO existe en el roster de `source.listTeams()` de IClass
- WHEN se consulta el estado en vivo
- THEN `tech:tech-C` aparece en la respuesta con su última posición y un `name` derivado del `RbacUser` de `tech-C`
- AND no depende de que IClass conozca esa cuadrilla

### Requirement: Audit trail reads both sources without a client-visible schema change

La auditoría histórica (`/audit/*`) DEBE (MUST) incluir puntos `source='app'` junto a los `source='iclass'` para la ventana consultada, con el mismo shape de respuesta que hoy (el consumidor no necesita saber de dónde vino cada punto para el veredicto de presencia; `accuracyM`/`recordedAt` siguen siendo los campos que importan).

#### Scenario: Audit window includes app-origin points
- GIVEN una ventana de auditoría con 5 puntos `source='iclass'` y 3 `source='app'`
- WHEN se consulta la auditoría
- THEN los 8 puntos aparecen en la respuesta, con el mismo shape que hoy

## Aditivo, solo-crece
Ningún endpoint de esta capability cambia su shape de request/response — el cambio es puramente de QUÉ FILAS entran al cálculo, no de cómo se exponen.
