# Proposal: "Agregar por PPPoE" — auto-poblar equipos del contrato desde la red real

## Intent
Botón en la sección de equipos del contrato que, al apretarlo, descubre y agrega los equipos reales del cliente: la **antena** (Ubiquiti, vía PPPoE) y el **router** del cliente (detrás de la antena), entrando por SSH a la antena en vivo.

## Validado en vivo (cero supuestos)
- El container del BEND alcanza la antena (PPPoE remote-address, CGNAT 100.64.x) en :22.
- `ssh2` (la lib que ya usa el BE) conecta al airOS viejo con algos legacy (config probada abajo).
- `mca-status` → `platform=LiteBeam 5AC Gen2` (modelo) + `deviceId=78:8A:20:96:6A:AE` (MAC antena = caller-id).
- `cat /proc/net/arp` → `192.168.11.193 c0:c9:e3:34:33:75 eth0` (router del cliente; OUI c0:c9:e3 = TP-Link).

## Decisiones (del usuario)
1. **Modelo router**: tabla OUI→marca embebida (TP-Link, ZTE, Huawei, Mikrotik, Ubiquiti, Tenda, etc.) → el router queda con MAC + marca; el operador completa el modelo exacto si quiere.
2. **Best-effort**: registra lo que encuentre + avisa (antena offline → usa el caller-id igual; sin router en ARP → solo antena). Nunca rompe.
3. **Modal de revisión**: muestra lo encontrado (editable) → el operador confirma → recién ahí guarda.

## Scope

### BE
- **Port `AirOsGateway`** + **adapter `Ssh2AirOsGateway`** (`infrastructure/adapters/airos/`): `inspect(ip): Promise<{ model: string|null, ownMac: string|null, lanMacs: string[] }>`.
  - ssh2 connect con la config PROBADA: `algorithms: { kex: ['diffie-hellman-group14-sha1','diffie-hellman-group1-sha1','diffie-hellman-group-exchange-sha1'], serverHostKey: ['ssh-rsa','ssh-dss'], cipher: ['aes128-ctr','aes128-cbc','3des-cbc','aes256-cbc'], hmac: ['hmac-sha1','hmac-sha1-96'] }`, `readyTimeout: 10000`.
  - Prueba los passwords de config en orden (distintas antenas, distintas claves).
  - Corre `mca-status` (parsear `platform=` → model, `deviceId=` → ownMac) + `cat /proc/net/arp` (parsear filas `eth0`, flags completas, excluir 00:00:.. y la propia ownMac → lanMacs = router(s)).
- **Util OUI→marca** (`application/.../ouiVendor.ts`): primeros 3 octetos → marca (TP-Link c0:c9:e3, etc.; tabla acotada de los comunes en WISP).
- **Config** (`config.ts`): `AIROS_SSH_USER` (default ubnt), `AIROS_SSH_PASSWORDS` (lista coma-separada). Fail-fast solo si la feature lo requiere (mejor: opcional, si faltan → la inspección degrada con warning).
- **Use case `InspectPppoeDevices`**: `execute(contractId) → { antenna: {mac, model}, router: {mac, brand}|null, warnings: string[] }`. Resuelve el PPPoE activo del contrato (findByContract) → IP antena = `pppoe.remoteAddress`, MAC antena = caller-id (orchestrator.listSessions, fallback). SSH `airos.inspect(remoteAddress)`: antena = {mca model + ownMac/caller-id}; router = primer lanMac → OUI brand. Best-effort: SSH falla → antena solo con caller-id (model null) + warning; sin lanMac → router null + warning; sin remoteAddress/caller-id → warning.
- **Ruta** `GET /api/contracts/:contractId/inspect-pppoe-devices` (gate `inventory.write`). Devuelve el DTO. NO agrega nada (eso lo hace el FE confirmando con el `POST /contracts/:id/inventory` existente, 1 por equipo).
- Wiring app.ts + tests (in-memory AirOsGateway; parseo mca-status/ARP; OUI; best-effort).

### FE (ui-ux-pro-max)
- Botón **"Agregar por PPPoE"** en `ServiceInventorySection` (al lado de "Agregar SN"), gate `inventory.write`.
- `api.inspectPppoeDevices(contractId)` + `useInspectPppoeDevices` (lazy, on-click).
- Al apretar → loading (~8s, SSH en vivo) → abre **`AddByPppoeReviewModal`**: muestra antena (tipo ANTENA, MAC, modelo) + router (tipo ROUTER, MAC, marca) editables + los warnings → el operador confirma/edita → al confirmar, `POST /contracts/:id/inventory` por cada equipo elegido → refresca la tabla + toast.
- Estados: loading, error (no se pudo), warnings (parcial). a11y (focus-visible, etc.). SVG.

## Out of Scope
- Modelo EXACTO del router (solo marca por OUI). Re-descubrir periódico. Otros vendors de antena (solo airOS Ubiquiti por ahora).

## Risks
| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| Antena offline / SSH falla | Media | best-effort (caller-id + warning), timeout 10s |
| Password distinto por antena | Media | lista de passwords en config, prueba en orden |
| ARP con múltiples/cero dispositivos | Media | tomar eth0 completas, excluir propia MAC; 0 → warning |
| SSH en vivo bloquea la request ~8s | Baja | spinner en el FE; es acción del operador |
| Creds airOS en config | Baja | igual patrón que las creds MikroTik ya presentes |

## Success Criteria
- [ ] Botón "Agregar por PPPoE" → inspecciona en vivo → modal con antena (LiteBeam 5AC Gen2) + router (TP-Link MAC) → confirmar → equipos en el contrato.
- [ ] Best-effort: antena offline → solo caller-id + warning; sin router → solo antena.
- [ ] tests BE + FE verdes + tsc/typecheck + review GO + verificación en vivo contra la antena de Jorge.
