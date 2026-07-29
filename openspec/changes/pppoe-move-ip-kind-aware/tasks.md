# Tasks: move de PPPoE consciente de la clase de IP

> TDD estricto: cada tarea de código empieza por el test que falla. El gate (suite completa +
> `tsc --noEmit` en BE y FE) lo corre el orquestador, no se confía en reportes parciales.

## Fase 1 — Dominio puro (sin IO, base de todo)

- [ ] **T1.1** Test de `supportedIpKinds(pools)` en tabla: solo-public → `['public']`; solo-cgnat
      → `['cgnat']`; ambos → los dos; sin pools → `[]`; pools inactivos NO cuentan.
- [ ] **T1.2** Implementar `domain/services/ipKindSupport.ts` → `supportedIpKinds`.
- [ ] **T1.3** Test de `resolveMovePoolType(supported, current)`: soporta la actual → la actual;
      soporta solo la otra → la otra (conversión); soporta ambas → la actual; `[]` → `null`.
- [ ] **T1.4** Implementar `resolveMovePoolType`.

## Fase 2 — Exponer las clases por NAS

- [ ] **T2.1** Test: `enrich()` devuelve `supportedIpKinds` **con el orchestrator caído**
      (mock que rechaza `fetchAllSessions`) y `clientCount`/`lastSeen` degradan al stored.
- [ ] **T2.2** Test: `enrich()` devuelve `supportedIpKinds` para un NAS que NO rutea por
      orchestrator (early-return de la línea 63).
- [ ] **T2.3** Test: fallo en la lectura de pools → `supportedIpKinds: []` y la request NO falla.
- [ ] **T2.4** Implementar en `NasLiveStatsProvider`: `safeKinds()` con try propio, calculado
      ANTES del early-return; agregar el campo al `NasServerDto`.
- [ ] **T2.5** Test de ruta: el listado de NAS incluye `supportedIpKinds` (use case REAL + repo
      in-memory, NO mockear el use case — lección #28).

## Fase 3 — El move resuelve la clase (el fix que desbloquea el NE8000)

- [ ] **T3.1** **Test de REGRESIÓN primero:** move CGNAT→CGNAT se comporta idéntico a hoy
      (asigna del pool cgnat, `ipTypePreference` sin cambios, kick, evento). Debe pasar ANTES y
      DESPUÉS del cambio — si no falla al revertir el fix, no está pineando nada.
- [ ] **T3.2** Test: move de un servicio cgnat a NAS public-only → asigna IP de un pool `public`
      del **destino**, persiste `ipTypePreference='public'`, registra `PppoeNasMoveEvent`.
- [ ] **T3.3** Test: la IP asignada al convertir **NO** es la anterior y cae en un pool del destino.
- [ ] **T3.4** Test: destino con pools de ambas clases → gana el `ipTypePreference` persistido.
- [ ] **T3.5** Test: destino SIN pools → error tipado nombrando la clase buscada; `nasId`,
      `remoteAddress` e `ipTypePreference` intactos; sin kick ni escritura en RADIUS.
- [ ] **T3.6** Implementar: reemplazar `MovePppoeToNas.ts:175` por `resolveMovePoolType`;
      persistir el `ipTypePreference` nuevo cuando hay conversión.
- [ ] **T3.7** Verificar que el guard `PPPOE_MOVE_PUBLIC_IP` / flujo `force` de la W1 sigue
      intacto (test existente debe seguir verde sin tocarlo).

## Fase 4 — Persistir el tipo desde el update

- [ ] **T4.1** Test: `PATCH` con `ipTypePreference` lo persiste; sin el campo, no lo toca.
- [ ] **T4.2** Test: valor inválido → 422 zod.
- [ ] **T4.3** Implementar en el DTO de update + `UpdatePppoeService`.

## Fase 5 — Frontend

> Antes de escribir UI: `python .claude/skills/ui-ux-pro-max/scripts/search.py "<contexto>" --design-system`
> (regla innegociable del workflow). Motion, si hay, pasa por las skills de Emil.

- [ ] **T5.1** Test: seleccionar un NAS con `supportedIpKinds: ['public']` esconde "Privada" y
      deja "Pública" seleccionada.
- [ ] **T5.2** Test: NAS con ambas clases muestra las dos opciones.
- [ ] **T5.3** Test: `supportedIpKinds` vacío/ausente → muestra ambas (fallback).
- [ ] **T5.4** Test: cambiar SOLO el tipo (sin tocar router) manda `ipTypePreference` en el update.
- [ ] **T5.5** Test del punto fino de D6: si el NAS **cambió**, el update NO manda
      `ipTypePreference` (para no pisar la clase que el move resolvió).
- [ ] **T5.6** Test: `NO_POOL_FOR_NAS_TYPE` con clase `public` → el mensaje dice "pública", no CGNAT.
- [ ] **T5.7** Implementar: tipo + api, filtrado del toggle, `ipTypePreference` en el update,
      mensaje parametrizado.
- [ ] **T5.8** Selector propio accesible (tokens, `aria-pressed`, focus visible, ≥44px) — reusar
      el existente si ya cumple.
- [ ] **T5.9** Mostrar el impacto antes de guardar cuando la conversión le cambia la IP al
      cliente (regla de feedback de acciones de alto riesgo).

## Fase 6 — Gate, review y verificación en prod

- [ ] **T6.1** Gate BE: suite completa + `tsc --noEmit`, corrido por el orquestador.
- [ ] **T6.2** Gate FE: suite completa + `typecheck` + `build`.
- [ ] **T6.3** Review adversarial (mínimo 1 revisor; 2+ por tocar asignación de IPs en prod).
      Focos: regresión del move CGNAT→CGNAT · orden abort-antes-de-mutar · contrato BE↔FE campo
      por campo · el passthrough del `ipTypePreference` entre move y update.
- [ ] **T6.4** Fix wave con TDD + **re-review focalizada** de los fixes. CLEAN o no se commitea.
- [ ] **T6.5** `sdd-verify`: matriz de spec-compliance (cada scenario con su test verde).
- [ ] **T6.6** E2E con Playwright contra `http://190.7.234.37:7778`: mover un servicio de prueba
      al NE8000, confirmar que "Privada" no aparece, que la IP asignada es del pool del destino y
      que el cliente reconecta. **Limpiar los datos de prueba.**
- [ ] **T6.7** Verificar en la DB de prod que el servicio movido quedó con `ipTypePreference`
      correcto y su IP dentro de un pool del NE8000.

## Notas de ejecución

- **Sin migración de DB** — nada de esto toca el schema.
- Worktrees separados: `fix/pppoe-move-ip-kind-aware-be` y `-fe`.
- El **contrato del wire va explícito campo por campo en ambos lados** (`supportedIpKinds:
  ('cgnat'|'public')[]`) — se construyen BE y FE del mismo spec, y ahí es donde históricamente
  driftean.
