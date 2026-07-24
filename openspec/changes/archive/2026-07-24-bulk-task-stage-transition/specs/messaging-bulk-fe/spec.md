# Spec delta FE — messaging-bulk-fe (change bulk-task-stage-transition)

RFC-2119. Cada scenario cubierto por al menos un test verde (Vitest). Delta sobre la capability FE del bulk. Agrega el
selector de **estado resultante único** en la card de Config y ajusta el preview al conteo POR-TAREA. Toda UI PASA por
`ui-ux-pro-max` (design-system) + skills de motion de Emil (regla del workflow). Stack: React + Vite + CSS Modules +
tokens `var(--color-*)`.

---

## ADDED Requirements

### Requirement: FE-TRANS-1 — selector de estado resultante en la card "Estados de tarea para envíos"

La card existente (Config→WhatsApp) MUST ganar un selector ÚNICO de "estado resultante" — un `Select`/`Combobox` PROPIO
(NUNCA `<select>` nativo), estilado con tokens, accesible (teclado flechas/Enter/Esc, `role="listbox"`, focus visible,
opción con check para el valor activo). MUST poblarse del catálogo de stages (`useWorkflows()`, gate FE `scheduling.read`),
agrupado por workflow, y MUST **excluir** el stage con `code === 'send_to_iclass'` (decisión 7). Es OPCIONAL (opción "—
Sin transición —" que setea `null`). Editar → `PUT /api/messaging/config/task-stages/resulting-stage` (gate FE
`messaging.manage`; si falta el permiso, se muestra read-only).

#### Scenario: elegir un estado resultante
- GIVEN la card abierta con `messaging.manage` y `scheduling.read`
- WHEN el supervisor elige "Avisado" como estado resultante y guarda
- THEN se llama al PUT con `{ stageId: <id de Avisado> }`; la card refleja el valor activo

#### Scenario: send_to_iclass no aparece en el picker
- GIVEN un workflow que incluye el stage `send_to_iclass`
- WHEN se abre el selector de estado resultante
- THEN `send_to_iclass` NO figura entre las opciones

#### Scenario: quitar la transición
- GIVEN un estado resultante ya configurado
- WHEN el supervisor elige "— Sin transición —"
- THEN se llama al PUT con `{ stageId: null }`

### Requirement: FE-TRANS-2 — confirmación de impacto al cambiar/quitar el destino

Cambiar o quitar el estado resultante MUST pasar por un `ConfirmModal` con el impacto explícito (qué implica: "las próximas
campañas por tarea moverán / dejarán de mover las tareas a este estado"). Feedback de éxito Y de error VISIBLES
(`aria-live`), nunca un fallo silencioso.

#### Scenario: confirmación antes de aplicar
- GIVEN un estado resultante configurado
- WHEN el supervisor lo cambia
- THEN aparece el ConfirmModal con el impacto; recién al confirmar se dispara el PUT

### Requirement: FE-TRANS-3 — preview por TAREA + hint de transición

El tab "Tarea" del composer y el `PreviewModal` MUST reflejar el conteo POR-TAREA (no por cliente DISTINCT) y MUST mostrar
un hint honesto de cuántas tareas transicionarán de estado (si hay estado resultante configurado) — coherente con
TRANS-6/decisión 3 (un cliente con varias tareas = varios mensajes). Las 4 ramas de estado (loading/empty/error/success)
se mantienen.

#### Scenario: hint de transición cuando hay destino
- GIVEN `resultingStage` presente en `GET /config/task-stages`, y el preview resuelve 5 tareas
- WHEN el operador ve el preview
- THEN se muestra el count de 5 mensajes/tareas + un hint de que 5 tareas pasarán al estado resultante

#### Scenario: sin destino configurado → sin hint de transición
- GIVEN `resultingStage: null`
- WHEN el operador ve el preview del dominio task
- THEN se cuenta por tarea, SIN el hint de transición (solo se envía)
