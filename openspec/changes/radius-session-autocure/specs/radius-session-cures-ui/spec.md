# Spec: FE-1 — UI de sesiones curadas + botón manual

> Repo: FE de Prominense. Delta spec del change `radius-session-autocure`. El detalle visual (composición, copys, estados) se resuelve en el apply FE con ui-ux-pro-max — esta spec fija el CONTRATO funcional.

## REQ-FE-CURE-1 — Tab "Sesiones curadas" en la page de auditoría RADIUS

La page de auditoría RADIUS (donde viven "Errores de auth" / Logs) DEBE sumar una sección/tab "Sesiones curadas": tabla paginada de `GET /api/radius/session-cures` con el wire contract de REQ-CURE-5 campo por campo. DEBE mostrar: chips de `countsByOutcome` (patrón de los chips de reason de Errores de auth), badge por outcome (curada · ya curada · skip vivo · skip ambiguo · sin señal · sin sesión · **flapping** · fallo — `flagged_flapping` con tratamiento visual destacado: delata credencial compartida/clon, es un caso de soporte), columnas username / NAS / sesión / evidencia (`signalUsed`: "rejects sostenidos" vs "interim viejo", + `sessionLastUpdate`) / trigger / actor / fecha, y filtros outcome/trigger/username/rango de fechas. Outcomes desconocidos DEBEN degradar a texto plano (outcome String libre en el BE — lección `OutcomeBadge`).

- **S1.1** fila `cured` auto → badge de curada, actor "sistema", señal visible ("última actividad hace 25 min").
- **S1.2** chips: seleccionar `?outcome=cured` filtra la tabla pero los chips siguen mostrando el desglose completo.
- **S1.3** outcome desconocido (agregado a futuro en el BE sin release FE) → texto plano, sin crash.
- **S1.4** el tab respeta el mismo guard de permisos que sus vecinos (visible con `network.read`; sin permiso no se monta — nunca "visible pero muerto" en 403).

## REQ-FE-CURE-2 — Botón "Curar sesión colgada" (escape hatch con doble confirmación)

Las filas de "Errores de auth" con `reason='session_stuck'` DEBEN ofrecer la acción "Curar sesión colgada", visible solo con `network.manage`. Flujo: (1) confirmación PRIMERA explicando el efecto (CoA Disconnect + cierre contable en radacct) → `POST /api/radius/session-cures` SIN `force`; (2) si responde 409 `CURE_SKIPPED_ALIVE`/`CURE_SKIPPED_AMBIGUOUS`, mostrar el motivo REAL del rechazo y ofrecer una SEGUNDA confirmación con copy de riesgo explícito ("la sesión parece viva / hay sesiones en varios NAS; forzar la desconecta igual") → reenviar con `force: true`. Resultado (cured/already_cured/failed) DEBE quedar visible (toast/estado) y refrescar el tab de Sesiones curadas.

- **S2.1** click + confirm 1 sobre sesión stale → 200 cured → feedback de éxito + la fila nueva aparece en "Sesiones curadas".
- **S2.2** 409 alive → NO se cura; el motivo se muestra; el force requiere el SEGUNDO confirm explícito (jamás automático).
- **S2.3** confirm 2 + force → cured; la fila registra al operador como actor.
- **S2.4** sin `network.manage` → la acción no se renderiza.
- **S2.5** `already_cured` (el cron/watcher ganó) → feedback informativo "ya estaba curada", sin error.
