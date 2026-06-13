# SESSION PROGRESS — IPNext (Prominense) — 2026-06-12

> **Documento de handoff durable.** Estado completo de la sesión, para retomar tras compactar.
> Repos: BE `C:\Users\ronald\projects\ipnext\ipnext-backend` · FE `C:\Users\ronald\projects\ipnext\ipnext-frontend`.
> Push a `main` = **DEPLOY A PROD** (fail-fast). Confirmar verde con `gh run watch`.

---

## 1. Resumen de la sesión

**Batch #48–#66 (19 ítems) COMPLETO en el día** — 18 shippeados a prod + #57 cerrado como no-bug. Todo vía SDD automático + híbrido, worktree por ítem, **builders Opus 4.8 / arquitecto+reviews Fable 5** (directiva del usuario), loop fix→review hasta CLEAN con gates corridos por el orquestador. `BACKLOG.md` es la fuente de verdad con el detalle por ítem.

| # | Qué | PRs | Migración |
|---|---|---|---|
| #48 | Reporter + GUARDAR en detalle de ticket | BE #119 + FE #99 | 20260701 |
| #56 | Link al cliente en /admin/contracts | BE #118 + FE #97 | — |
| #58 | Picker "+ Agregar servicio" portaleado | FE #98 | — |
| #61/#62 | TV: filtro LIKE único + columna Estado | FE #100/#101 | — |
| #59 | Feedback Reprocesar (botón estaba disabled con pendientes) | FE #102 | — |
| #60 | TV: fuera el contador de devices (roto upstream, verificado live) | FE #103 | — |
| #57 | Cupos TV | **no-bug** (GPF realmente 102/102 en el partner) | — |
| #52→#66 | Switch Red/FO (el #52 rename se reinterpretó; #66 es el modelo final) | FE #104 → BE #127 + FE #112 | 20260708 |
| #53/#54 | Dirección obligatoria + localidad snapshot en tareas de nodo | BE #120 + FE #105 | 20260702 |
| #50 | Permisos granulares TV (link/register/packs/ott/cancel) | BE #121 + FE #106 | 20260705 |
| #63/#49 | Búsqueda LIKE tickets + Áreas (catálogo+config+filtro) | BE #122 + FE #107 | 20260703/04 |
| #51 | NetworkSite: identidad fija NODO {n} (dispatch intacto) | BE #123 + FE #108 | 20260706 |
| #55 | customerCode a IClass = grContratoId del contrato | BE #124 + FE #109 | — |
| #64 | Baja TV: renew CIC + unlink + modal async | BE #125 + FE #110 | — |
| #65 | Alta TV determinística + credenciales + cambio de password | BE #126 + FE #111 | 20260707 |

## 1b. Mini-batch de la tarde (#67–#71, también COMPLETO)

| # | Qué | PRs |
|---|---|---|
| #67 | Pack base irremovible en la baja TV (424 determinístico del CUA — divergencia #9; reconcile excluye irremovibles) | BE #129 + FE #115 |
| #68 | Coords UISP en el autofill de dirección de tareas de nodo | FE #113 |
| #69 | Área de tickets con color (catálogo + pill + picker, migración 20260709) | BE #128 + FE #114 |
| #70 | Password del alta TV autogenerada server-side (campo fuera del form; cambio de pw sigue libre) | BE #130 + FE #116 |
| #71 | Link al cliente del detalle de ticket: /admin/clients → /admin/customers/view | FE #117 |
| #72 | Baja LOCAL de TV — el partner NO desvincula (divergencia #10); flag Client.tvCancelledAt | BE #132 + FE #119 |
| #73 | Historial de servicios del contrato (deactivatedAt + modal) | BE #131 + FE #118 |

### ⚠️ Escalamiento a Gigared (bloqueo del partner, NO código)
- Pedir endpoint de desasociación/borrado de internal_id (no existe: PATCH ''=400, mapeo append-only, DELETE 405/404).
- Pedir limpieza de internal_ids basura del abonado 204366 (de las pruebas live del #72).


## 1c. Mini-batch noche 2 (#74–#79, COMPLETO)

| # | Qué | PRs |
|---|---|---|
| #74 | Baja TV: renew exitoso = baja completa (no parcial — el OTT viejo es moot tras el renew) | BE #133 + FE #120 |
| #75 | Tickets list: columna Área en posición 2 por default (respeta orden guardado) | FE #122 |
| #76 | Tickets list: nombre del cliente como link | FE #122 |
| #77 | Ticket detail: tab Datos → comentario de apertura virtual + fecha legible | FE #121 |
| #78 | Tickets list: columna Tipo eliminada (campo muerto, type no existe en BE) | FE #122 |
| #79 | Tickets list: columna Timer SLA con color por umbrales configurables (migración 20260713) | BE #134 + FE #122 |

## 2. Decisiones/hallazgos clave de la sesión

1. **#57/#60 verificados contra la API real** (SSH→container→node+pg): el summary es fiel; `qty_registered_devices` viene 0 en las 87 cuentas (roto upstream) y NO hay endpoint de devices (OpenAPI revisado). Divergencia #8 de Gigared.
2. **#64**: NO hay dato local del vínculo TV — el link ES el internal_id en el partner. Baja = renew + `setInternalId(newCic,'')`, renew SOLO con desmontaje completo (un retry podía mintear CICs sin límite). ⚠️ Sin confirmar que el partner acepte internal_id '' — si lo rechaza: 207 + retry visible.
3. **#55**: `Contract.grContratoId` es el código (dato GR real, no secuencia inventada); IClass crea/matchea el customer inline. Identidades mixtas en IClass post-deploy (esperado).
4. **#51**: los nodos de IClass SON las ciudades → el fixedCode NODO {n} es identidad interna, NO viaja a IClass (labels desambiguados en la UI).
5. **#66**: networkType inmutable post-create; fibra = nombre libre + localidad como nodeCode; localidad OPCIONAL para red (relajación del #54).
6. **Las reviews adversariales volvieron a cazar FIX-FIRST en CASI TODOS los ítems** (modal fantasma, minteo de CICs, password expuesta a cualquier autenticado, cic sin amarrar, lockout de tareas legacy, columna que desaparecía, cache sin invalidar, suite sin migrar, tests no-falsificables…). El verify solo NUNCA alcanza.
7. Builders reportando "verde" sin correr suites completas: pasó 2 veces (#56, #66) — el gate del orquestador y la regla pipefail los cazaron.

## 3. Pendientes del usuario (post-deploy)

1. **Smoke visual de prod** de todo el batch (sigo sin credenciales admin de prod).
2. **#64/#65 en vivo**: probar una baja real (verificar que el partner acepte el unlink con '') y un alta determinística.
3. Heredados: rotar token UISP · flags W4/W6 · admin.flags/uisp.* a roles no-super_admin.

## 4. Deudas técnicas del batch (anotadas en BACKLOG por ítem)

- `tv.write` huérfano en el catálogo RBAC (checkbox sin efecto en PermissionMatrix).
- Localidad de tarea no editable post-create desde el detail (#54/#66).
- M4/M5 del #48 (warn-before-leave SPA; cerrar sin tickets.close vía draft — pre-#44).
- Fidelidad del JOIN contractCode en in-memory (#55); test cross-repo del generador (#65); tvLogin column no leída (#65).
- Fibra: normalizar siteId whitespace-only; resend no maneja network (pre-existente #29).
- Dropdowns de CustomerDetailPage/CustomersListPage con el mismo riesgo de clipping del #58.

## 5. Cómo operar (sin cambios)

Ver `WORKFLOW-MULTI-REPO.md`. Worktrees por ítem en `.claude/worktrees/` (los del batch quedaron vivos — limpiar con `git worktree remove` cuando se quiera). Gates SIEMPRE con `set -o pipefail` (un `| tail` sin eso se traga el exit de jest/vitest). Dry-run rolled-back para toda migración (3 corridos hoy: #51 73/73, #65, #66).
