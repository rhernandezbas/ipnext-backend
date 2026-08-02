# Proposal: WiFi self-service (fibra Huawei) — Prominense full + app limitada

> Epic multi-repo pedido por el usuario (2026-08-02): *"poder configurar el servicio (only fibra)
> y only Huawei [...] y así poder tocar desde prominense y la app la contraseña, el nombre,
> cantidad de usuarios conectados"*. **Validado EN VIVO antes de escribir esto** — ver §Evidencia.

## Intent

Que el cliente cambie **el nombre y la contraseña de su WiFi desde la app** (por banda), y que el
staff tenga **configuración completa desde Prominense** — sin llamadas, sin visitas, sin tocar la
ONU a mano. Reduce el motivo de contacto más frecuente después de "no tengo internet".

## Evidencia (experimento 2026-08-02, ONU HWTC189C07AA / HG8145V5 / MERCEDES1)

- `POST /api/onu/set_wifi_port_lan/{sn}` con `wifi_port` + `ssid` + `password` +
  `authentication_mode=WPA2` **cambió las DOS bandas**; el usuario verificó ambas redes en el aire.
- **Cadena previa obligatoria en OLT Huawei** (automatizable por API): `set_onu_mgmt_ip_static_ip`
  (vlan por OLT: MERCEDES1=11, ESTUDIANTES=12) → `enable_tr069` (`tr069_profile=SmartOLT`; existe
  también `Wispcontrol` en 429 ONUs — **investigar antes de tocarlas**). La app JAMÁS dispara esta
  cadena; sólo Prominense staff.
- **Puertos**: `wifi_0/1..4` = 2.4GHz, `wifi_0/5..8` = 5GHz. La lista de puertos sale de la
  **plantilla "ONU type" de SmartOLT, no del hardware** — plantilla del HS8145V ya corregida por
  el usuario (declaraba 4 puertos siendo dual-band). Bridges (~1.830) = 0 puertos ⇒ no aplica.
- **Lectura**: tras escribir vía TR-069 el SSID se lee en `get_onu_details` — la app puede MOSTRAR
  el nombre actual una vez que lo gestionamos nosotros.
- **Hosts conectados: NO hay endpoint** (barridos los 115; las MACs del full-status son del propio
  ONT — NAT esconde la LAN). Ver §Fuera de alcance.

## Reglas (aprobadas por el usuario)

1. **La app jamás**: autoriza ONUs, toca PPPoE, activa TR-069. Eso es de Prominense staff.
2. **Elegibilidad** — la pantalla "Mi WiFi" aparece sólo si las TRES se cumplen, y el server las
   re-verifica en **cada** escritura:
   - a) El contrato tiene un `ContractInstalledItem` `type=ONU` activo cuyo serial **normalizado**
     resuelve en SmartOLT. Normalización verificada: Prominense guarda hex (`48575443…`), SmartOLT
     ASCII (`HWTC…`) — decodificar los primeros 8 hex chars a ASCII (31/41 matchean hoy).
   - b) TR-069 = Enabled — **consultado a SmartOLT (cache corto), nunca un flag propio** (un flag
     miente en cuanto alguien lo cambia del otro lado).
   - c) Puertos WiFi > 0 — bandas mostradas según la lista real (2.4 sola / 2.4+5).
3. **NO se crean campos "validadores" en ContractService** — serían una segunda fuente de verdad
   (drift). El vínculo vive en `ContractInstalledItem`; el estado, en SmartOLT.
4. La app expone **sólo** SSID + contraseña por banda. Prominense staff: todo lo demás.
5. UX: al guardar se avisa que el WiFi se reinicia y los dispositivos se reconectan (maqueta
   aprobada, pantalla "Mi WiFi").

## Fases

- **F0 — Adapter + elegibilidad (BE)**: port `WifiManagementPort` + adapter SmartOLT (cliente ya
  parcialmente en la skill), normalizador de seriales (con tests de ida y vuelta), resolver de
  elegibilidad con cache, y rate limit propio de escritura (un cambio de WiFi reinicia la radio —
  no puede ser spammeable).
- **F1 — Prominense staff (FE)**: panel WiFi en el detalle del contrato (config completa +
  disparar la cadena MGMT/TR-069 con confirmación de impacto) + **picker de asociación ONU↔contrato**
  (buscar en SmartOLT por nombre/serial, sugerencia + confirmación de operador).
- **F2 — App**: pantalla "Mi WiFi" según maqueta aprobada (entrada desde Mis servicios).
- **F3 — Backfill de cobertura**: hoy sólo 41/~2.800 contratos tienen su ONU cargada. Sugerencia
  automática por matching de nombre SmartOLT↔cliente + cola de confirmación. **Sin esto la feature
  es invisible para casi todos** — es el trabajo silencioso del epic.

## Fuera de alcance (decidido)

- **Dispositivos conectados (hosts)**: el dato vive en el ACS de SmartOLT y no está expuesto por
  API. Camino barato: pedir el endpoint a soporte. Camino caro: ACS propio (GenieACS) — **TRAMPA
  DOCUMENTADA**: un ONT habla con UN solo ACS ⇒ migrar rompe el set_wifi de SmartOLT; es una
  bifurcación total, no un agregado. Se decide sólo si soporte dice no y los hosts pesan.
- Equipos no-Huawei / no-fibra (Vsol/"670" con 2 puertos: investigar aparte).
- Descuentos/débito (viven en GR; otro dominio).
