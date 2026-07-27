# IClass Presence Audit Specification

## Purpose

Responder, con evidencia y sus límites explícitos: **¿el técnico estuvo en el domicilio durante la ventana real de trabajo de la orden?**

Esta capability produce **evidencia**, no veredictos disciplinarios. La distinción no es cosmética: un falso positivo de "no fue" acusa a una persona real de algo que sí hizo. Todos los requisitos de abajo existen para hacer ese error difícil.

## Requirements

### Requirement: A single point MUST NOT be used as proof of absence

El sistema NO DEBE (MUST NOT) emitir un veredicto de presencia a partir de un único punto GPS, en particular el de `GET /teams/lastlocation?serviceOrderCode=X`.

El sistema DEBE (MUST) evaluar **todos** los puntos del rastro que caen dentro de la ventana de trabajo.

Justificación verificada (falso negativo real): para la OS 4905, el punto único devolvió **1.538 m** → "lejos". El rastro completo de ese día puso al técnico a **3 metros** del domicilio a las 18:18. La semántica del punto único parece ser el **cierre administrativo**, no el momento del trabajo — se observaron dos OS distintas cerradas con 2 minutos de diferencia, ambas "lejos", el mismo día en que otra dio 0 m.

#### Scenario: The full trail overrides a misleading single point
- GIVEN la OS `4905` cuyo `lastlocation?serviceOrderCode` está a 1.538 m del domicilio
- AND el rastro del técnico ese día contiene un punto a 3 m dentro de la ventana de trabajo
- WHEN se audita la OS `4905`
- THEN el veredicto es `EN_SITIO` con distancia mínima 3 m
- AND NO es `FUERA_DE_SITIO`

### Requirement: The work window comes from the status history, never from the scheduled date

El sistema DEBE (MUST) derivar la ventana de trabajo de `GET /serviceorders/{id}/history`, tomando los estados de ejecución (`DESLOCAMENTO`, `ANDAMENTO`) hasta el cierre (`FECHADA`).

El sistema NO DEBE (MUST NOT) usar `dataAgendamento` como ventana: una OS puede agendarse un día y ejecutarse otro, y auditar contra el día agendado produce conclusiones sobre un día equivocado.

El sistema DEBE (MUST) ampliar la ventana con un margen configurable a ambos lados (default **±15 minutos**), porque los breadcrumbs llegan cada 5-10 minutos y una ventana de 2 minutos puede no contener ningún punto.

#### Scenario: Window is taken from execution states
- GIVEN el historial de la OS registra `DESLOCAMENTO 20:29:02`, `ANDAMENTO 20:29:13` y `FECHADA 20:31:18`
- WHEN se calcula la ventana con margen de 15 min
- THEN la ventana evaluada es `20:14:02` – `20:46:18`

#### Scenario: A rescheduled order is audited on its execution day
- GIVEN una OS con `dataAgendamento` del día `D1` cuyo historial muestra ejecución el día `D2`
- WHEN se audita
- THEN se evalúa el rastro de `D2`, no el de `D1`

### Requirement: Absence of GPS coverage yields NO_CONCLUYENTE, never absence

El sistema DEBE (MUST) devolver el veredicto `NO_CONCLUYENTE` cuando no existan puntos del técnico dentro de la ventana evaluada.

El sistema NO DEBE (MUST NOT) devolver `FUERA_DE_SITIO` por ausencia de datos. **Ausencia de dato no es dato de ausencia**: el equipo pudo tener la app cerrada, el teléfono sin batería o sin señal.

El sistema DEBE (MUST) exponer la cantidad de puntos evaluados junto al veredicto, para que quien lo lea pueda juzgar su solidez.

#### Scenario: No points in the window is inconclusive
- GIVEN una OS cuya ventana de trabajo no contiene ningún punto del técnico
- WHEN se audita
- THEN el veredicto es `NO_CONCLUYENTE` con `pointsEvaluated = 0`
- AND NO es `FUERA_DE_SITIO`

#### Scenario: A verdict of absence requires actual coverage
- GIVEN una OS cuya ventana contiene 16 puntos, todos a más de 12 km del domicilio
- WHEN se audita
- THEN el veredicto es `FUERA_DE_SITIO` con `pointsEvaluated = 16` y distancia mínima 12.867 m

### Requirement: The verdict accounts for GPS accuracy

El sistema DEBE (MUST) comparar la distancia mínima contra el umbral de presencia (default **150 m**) **sumando** el `raio` del punto más cercano, de modo que un fix impreciso no produzca un falso "fuera de sitio".

El sistema DEBE (MUST) exponer la precisión del punto más cercano junto al veredicto.

#### Scenario: A low-accuracy point near the threshold does not condemn
- GIVEN el punto más cercano está a 180 m con `raio` de 102 m
- WHEN se evalúa contra un umbral de 150 m
- THEN el veredicto NO es `FUERA_DE_SITIO`, porque el margen de error abarca el umbral

#### Scenario: Distance far beyond any accuracy margin is conclusive
- GIVEN el punto más cercano está a 12.867 m con `raio` de 31,8 m
- WHEN se evalúa
- THEN el veredicto es `FUERA_DE_SITIO`: ninguna imprecisión plausible explica 12,8 km

### Requirement: Orders without an address or without an assigned team are not auditable

El sistema DEBE (MUST) devolver `NO_AUDITABLE` cuando la OS carece de `endereco.latitude`/`longitude` o de cuadrilla asignada.

Medido sobre 416 OS de julio 2026: 391 tenían domicilio con coordenadas y 345 tenían cuadrilla asignada. El resto no admite auditoría, y decirlo es parte del resultado.

#### Scenario: An order without coordinates is reported as not auditable
- GIVEN una OS sin `endereco.latitude`
- WHEN se audita
- THEN el veredicto es `NO_AUDITABLE` con el motivo explícito

### Requirement: A cheap temporal pre-filter flags impossible closures without touching GPS

El sistema DEBE (MUST) ofrecer un listado de OS cuyo tramo `DESLOCAMENTO → FECHADA` haya durado menos que un umbral configurable (default **5 minutos**), calculado **solo** con el historial de estados.

Justificación verificada: la OS 4995 registró viaje + visita + cierre en **2 minutos y 16 segundos**, con el `DESLOCAMENTO` durando 11 segundos. No existe viaje de 11 segundos. Este filtro es órdenes de magnitud más barato que el cruce GPS y sirve para priorizar qué auditar.

El pre-filtro NO DEBE (MUST NOT) presentarse como veredicto: marca **candidatos a revisar**, no culpables.

#### Scenario: An impossibly short closure is flagged
- GIVEN una OS con `DESLOCAMENTO 20:29:02` y `FECHADA 20:31:18`
- WHEN corre el pre-filtro con umbral de 5 minutos
- THEN la OS aparece como candidata con duración `2m16s`
- AND el resultado se rotula como candidato, no como incumplimiento

### Requirement: Audit output is evidence, not accusation

El sistema DEBE (MUST) acompañar todo veredicto con: distancia mínima, hora de ese punto, precisión, cantidad de puntos evaluados, la ventana usada y un enlace al mapa.

El sistema NO DEBE (MUST NOT) emitir texto que impute intención, responsabilidad o dolo. La evidencia habla de **dónde estuvo el dispositivo**; no puede establecer quién lo operaba.

#### Scenario: A far verdict is presented with its full evidence
- GIVEN un veredicto `FUERA_DE_SITIO` a 12.867 m
- WHEN se muestra al operador
- THEN incluye distancia, hora, precisión, puntos evaluados, ventana y link al mapa
- AND no afirma que el técnico haya mentido ni incumplido
