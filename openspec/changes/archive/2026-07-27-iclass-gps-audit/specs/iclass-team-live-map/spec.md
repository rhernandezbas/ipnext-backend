# IClass Team Live Map Specification

## Purpose

Mostrar **dónde está cada cuadrilla ahora** y cómo viene su jornada, para despacho operativo.

Es la cara operativa del mismo rastro que alimenta la auditoría, pero con otro consumidor, otro permiso y otra pregunta: no "¿estuvo donde dijo?" sino "¿a quién le mando esto?".

## Requirements

### Requirement: Live status is exposed per team with its freshness

El sistema DEBE (MUST) exponer, por cuadrilla activa: última posición conocida, su timestamp, su precisión y un enlace al mapa.

El sistema DEBE (MUST) marcar como **desactualizada** toda cuadrilla cuyo último punto tenga más de **24 horas**.

El sistema NO DEBE (MUST NOT) presentar una posición vieja como si fuera actual: una ubicación de hace dos días en un mapa "en vivo" induce a error de despacho.

#### Scenario: A stale team is flagged, not hidden
- GIVEN la cuadrilla `IPNXANTONIOM` cuyo último punto es del `24-07` y hoy es `26-07`
- WHEN se consulta el estado en vivo
- THEN aparece marcada como desactualizada, con la antigüedad del dato
- AND no se dibuja como posición actual

#### Scenario: A fresh team shows as live
- GIVEN la cuadrilla `IPNXDENIC` con un punto de hace 4 minutos
- WHEN se consulta el estado en vivo
- THEN aparece como activa con su precisión

### Requirement: Teams with no trail are distinguished from teams that are far away

El sistema DEBE (MUST) diferenciar tres estados: **activa** (reporta), **desactualizada** (reportó hace >24h) y **sin rastro** (nunca reportó o su usuario está cancelado).

Justificación verificada: de 11 cuadrillas en `/teams`, 6 tienen rastro y 5 devuelven `204` — son logins cancelados o duplicados (`IPNXJULIO`, `IPNXIPNXJULIO`, `IPNXSEBAM`, `IPNXIPNXRONALDH`, `IPNXjulio`). Mezclarlos con técnicos reales ensucia el mapa.

#### Scenario: A cancelled login is not shown as a missing technician
- GIVEN la cuadrilla `IPNXSEBAM` con estado `Cancelado` y sin puntos
- WHEN se arma el mapa
- THEN se clasifica como sin rastro y no se lista entre las cuadrillas operativas

### Requirement: Team status in IClass does not determine tracking

El sistema NO DEBE (MUST NOT) inferir si una cuadrilla trackea a partir de su campo `status` de IClass.

Justificación verificada: `IPNXANDYM` figura con `status: "Inativo"` y sin embargo reportó 28 puntos hoy. El estado administrativo y la actividad real del dispositivo son independientes.

#### Scenario: An "Inativo" team that reports is shown as active
- GIVEN una cuadrilla con `status: "Inativo"` que envió un punto hace 5 minutos
- WHEN se consulta el estado en vivo
- THEN aparece como activa

### Requirement: The daily journey is derived from the trail alone

El sistema DEBE (MUST) exponer por cuadrilla y día: hora del primer punto, hora del último, cantidad de puntos y su distribución horaria.

El sistema DEBE (MUST) calcular estos datos **sin depender de órdenes de servicio**.

#### Scenario: Journey is available for a day without service orders
- GIVEN una cuadrilla con 29 puntos entre las 06:08 y las 09:41 y ninguna OS ese día
- WHEN se consulta su jornada
- THEN devuelve inicio `06:08`, fin `09:41`, 29 puntos y la distribución por hora

### Requirement: Travelled distance is reported as a lower bound

El sistema DEBE (MUST) rotular la distancia recorrida como **mínimo estimado**, nunca como valor exacto.

Justificación: sumar tramos rectos entre puntos tomados cada 5-10 minutos "corta las curvas" y **subestima** sistemáticamente el recorrido real. Presentarlo como exacto sería vender un número que no es — y sobre esa cifra alguien podría evaluar el desempeño de una persona.

El sistema DEBE (MUST) exponer el intervalo de muestreo junto a la distancia, para que el margen sea legible.

#### Scenario: Distance is labelled as an estimate
- GIVEN una cuadrilla con 30 puntos cuya suma de tramos rectos da 2,2 km
- WHEN se muestra el recorrido
- THEN se presenta como mínimo estimado, con el intervalo de muestreo visible
- AND no se afirma que recorrió exactamente 2,2 km

### Requirement: The live map is gated by its own permission

El sistema DEBE (MUST) proteger el estado en vivo con el permiso `technicians.location_read`, distinto del permiso de auditoría histórica.

El sistema DEBE (MUST) aplicar el guard en **ambas capas**: la ruta del backend y la page del frontend.

Justificación (decisión del usuario, 2026-07-26): quien despacha necesita ver dónde están las cuadrillas para operar; eso **no** debe arrastrar la capacidad de auditar el historial completo de una persona.

#### Scenario: Dispatch access does not grant audit access
- GIVEN un usuario con `technicians.location_read` y sin `technicians.location_audit`
- WHEN consulta el mapa en vivo
- THEN lo ve correctamente
- AND al intentar acceder a la auditoría histórica recibe un rechazo del backend, no solo del frontend
