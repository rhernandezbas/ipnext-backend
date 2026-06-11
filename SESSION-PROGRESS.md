# SESSION PROGRESS — IPNext (Prominense) — 2026-06-11

> **Documento de handoff durable.** Estado completo de la sesión, para retomar tras compactar.
> Repos: BE `C:\Users\ronald\projects\ipnext\ipnext-backend` · FE `C:\Users\ronald\projects\ipnext\ipnext-frontend`.
> Push a `main` = **DEPLOY A PROD** (fail-fast). Confirmar verde con `gh run watch`.

---

## 1. Resumen de la sesión

Batch de 8 ítems nuevos (#40–#47) pedidos por el usuario. **7 de 8 SHIPPEADOS A PROD** en el día, todos vía SDD automático + hybrid con el loop fix→review hasta CLEAN. `BACKLOG.md` es la fuente de verdad con el detalle por ítem.

| # | Qué | PRs | Estado |
|---|---|---|---|
| #40 | Page Tareas Nodos (kind=network, proyectos de red exclusivos, secuencia compartida) | BE #104 + FE #78 | ✅ PROD |
| #40b | Follow-ups (sin toggle en modal cliente, sin col Cliente, kind=customer en lista clientes, deep-link Proyectos→nodos) | FE #79 | ✅ PROD |
| #41 | Estados generales open/closed/dismissed + filtro default Abiertas + cierre auto por flujo IClass + dismissed fuera de loops | BE #105 + FE #80 | ✅ PROD |
| #43 | Contract.name + ServiceCatalog + ContractService + grant clients.manage (migraciones 20260625/26/27) | BE #106 | ✅ PROD |
| #42 | Redesign tab Contratos (cards impeccable, servicios, name editable, fixes id-string/ip) | FE #81 | ✅ PROD |
| #44 | Detalle de ticket redesign + comentarios PERSISTIDOS con fotos base64 (paste/upload) — mata replies in-memory | BE #107 + FE #82 | ✅ PROD |
| #46 | Lista tickets: bulk actions + filtros colapsables + muere whitelist VALID_STATUSES + CloseTicket catalog-aware | BE #108 + FE #83 | ✅ PROD |
| #45 | Mapper de ciudades: catálogo IClassNode (los nodos SON las ciudades, verificado live) + select en Mapeo de nodos | BE #109 + FE #84+#85 | ✅ PROD |
| #47 | Integración TV **Gigared Partners** (desbloqueado: el usuario pegó la doc) | BE #111 + FE #86 | ✅ PROD (flag OFF hasta cargar key — **key YA CARGADA por el usuario**) |
| #47b | TV desde el contrato (panel con contrato dueño, page en Clientes, fuera la tab) | FE #87 | ✅ PROD |
| #47c | Paginación Gigared capeada en 20 + quitar ítem TV local + alta local sin Gigared | FE #88 | ✅ PROD |

**TV-MATCHES.md** (raíz BE): cruce de las 84 cuentas Gigared registradas vs clientes — 66 directos, 14 multi-contrato, 4 sin match. El usuario vincula A MANO desde el panel. ⚠️ Gigared Play Full 102/102 (cupo lleno). #45 bootstrap aplicado (catálogo 36 nodos + 26 auto-matches; quedan 47 barriales).

## 2. Incidente de la sesión (resuelto)

**Commit incompleto rompió el BUILD de main FE** (PR #84): el staging encadenado con `2>/dev/null` se tragó un fallo del add de untracked → 6 archivos nuevos no entraron → `Could not load src/hooks/useIClassNodes`. **Prod NO se afectó** (deploy fail-fast). Hotfix PR #85 con `git add` uno-por-uno + verificación. Lección en engram (`incidents/2026-06-11-incomplete-commit-main-build`): nunca silenciar stderr en staging; verificar `git show --stat HEAD` contra la lista esperada ANTES de pushear.

## 3. Pendientes del usuario (post-deploy)

1. **#47 TV**: pegar el contenido de `tv.md` (está vacío) + token después. El modelo de servicios x contrato (#43) ya está listo para colgarle el ítem TV.
2. **#45**: apretar **"Sincronizar desde IClass"** en Gestión de red → Mapeo de nodos (puebla el catálogo: 36 nodos, 3 agrupadores quedan no-seleccionables) y asignar nodo/ciudad a los 73 NetworkSites (el badge "Faltan datos IClass" se va solo).
3. **Smoke visual de prod**: no tengo credenciales de admin (las del seed dan 401) — pasarlas si querés el recorrido Playwright de todo lo shippeado.
4. Pendientes heredados: rotar token UISP · prender flags W4/W6 cuando se decida · asignar admin.flags/uisp.* a roles no-super_admin.

## 4. Deudas técnicas anotadas en la sesión

- `IngestGestionRealOrders` crea tareas DIRECTO en el repo (bypassa el guard de kind del #40) — inofensivo hoy.
- Calendar muestra tareas dismissed (#41) — revisar si molesta.
- BE `toService` no mapea `technology` (campo muerto en cards #42 y buildContractLabel) — pre-existente.
- `UpdateDeviceType` tiene el mismo agujero de rename-bypass que se cerró en ServiceCatalog (#43).
- Test e2e del dual-parser (8mb scoped + global 100kb) — sugerencia del review #44.
- Composition-guard test del wiring #46 — sugerencia.

## 5. Aprendizajes clave (también en engram, topic_keys backlog/*)

1. **El loop fix→review cazó bugs FIX-FIRST en TODAS las waves** otra vez (audit middleware persistiendo 12MB de base64, SVG XSS, paste roto en browsers reales, Prisma NOT sobre relación nullable, whitelist que funcionaba de casualidad, checkbox desync). El verify NUNCA alcanza solo.
2. **Verificar findings de reviewers contra origin/main y contra la API REAL** — 2 falsos positivos descartados con evidencia (filtro kind "inexistente", campo nodeId "improbable" que era real, verificado live).
3. Guard de update por CAMBIO no por presencia; select filtrado pinea el valor actual; misma acción = mismo permiso en todas las superficies; todo writer de valores de catálogo resuelve vía catálogo.
4. Parser path-scoped ANTES del global; elidir data-URIs del audit; el paste real llega por clipboardData.items.

## 6. Cómo operar (sin cambios)

Ver `WORKFLOW-MULTI-REPO.md`. DB prod vía node+pg dentro del container (SSH 2222). Dry-run rolled-back para toda migración. Worktrees por agente. `git add` por path explícito CON verificación.
