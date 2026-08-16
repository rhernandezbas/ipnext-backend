# Infraestructura IPNEXT — arquitectura y topología

> Mapa de la red y de los servidores: qué equipo hace qué, dónde está y qué NO hay que tocar.
> Última actualización: 2026-07-27. Fuente: skill `ipnext-infraestructura`.

## 🔑 Los accesos NO están en este documento — se cargan a mano

**Este archivo es commiteable a propósito y por eso no contiene ni una credencial**: no hay usuarios,
passwords, hostkeys ni comandos de conexión. Un documento con claves que entra a git es un **leak
permanente** — queda en el historial aunque después se borre el archivo.

**Cada persona carga sus accesos por su cuenta, en un archivo local que NO se commitea.** El repo ya
tiene la convención armada: los nombres que terminan en `-LOCAL.md` están en el `.gitignore`.

Para armarte el tuyo:

1. Creá `INFRAESTRUCTURA-LOCAL.md` en la raíz del repo (ya está gitignoreado, línea 15 del `.gitignore`).
2. **Verificá que git lo ignore ANTES de escribir la primera credencial** — no después:
   ```bash
   git check-ignore -v INFRAESTRUCTURA-LOCAL.md
   ```
   Si no devuelve nada, **parate ahí**: el archivo NO está protegido.
3. Cargá ahí usuarios, passwords, hostkeys y los comandos de conexión de los equipos que uses.

> ⚠️ **Si alguna credencial llega a commitearse, hay que rotarla de inmediato.** Borrar el archivo no
> alcanza: el valor ya quedó en el historial de git y en cualquier clon que se haya hecho.

Otros archivos locales del repo con el mismo criterio: `CREDENCIALES-LOCAL.md` (app, MinIO, RADIUS HA,
NE8000, Gestión Real) e `infra-ne8000/` (estado del RADIUS/PPPoE).

---

## 1. Panorama

IPNEXT es un ISP con **dos zonas de borde independientes** (Mercedes y Chivilcoy) unidas por WireGuard,
más un tercer borde en Agote. La red llega a los clientes por dos tecnologías: **wireless** (Ubiquiti,
~4000 equipos) y **fibra** (SmartOLT). La autenticación de los clientes es **PPPoE contra RADIUS**.

```
                    ┌─────────────── INTERNET ───────────────┐
                    │                                        │
              ┌─────┴─────┐                            ┌─────┴─────┐
              │  CCR2216  │◄──── WireGuard ───────────►│  Ovoprot  │
              │ MERCEDES  │      (wg-mgmt)             │ CHIVILCOY │
              │ borde BGP │                            │ borde BGP │
              └─────┬─────┘                            └─────┬─────┘
                    │                                        │
        ┌───────────┼───────────┐                  ┌─────────┼─────────┐
        │           │           │                  │         │         │
   ┌────┴────┐ ┌────┴────┐ ┌────┴─────┐        ┌───┴───┐ ┌───┴───┐ ┌───┴────┐
   │ NE-8000 │ │ Core    │ │   VPN    │        │ NE-20 │ │Canepa │ │ P.Ind. │
   │  BRAS   │ │RDA 1/2  │ │  Router  │        │ BRAS  │ │Vialid.│ │ Ugarte │
   │ (fibra+ │ │ (CGNAT) │ │ (puente  │        │       │ │       │ │        │
   │ Acc.Sur)│ │         │ │ a mgmt)  │        └───────┘ └───────┘ └────────┘
   └─────────┘ └─────────┘ └────┬─────┘
                                │
                     ┌──────────┴──────────┐
                     │  Red de gestión     │
                     │  10.3.3.0/24        │
                     │  proxmox-1 / vmware │
                     └─────────────────────┘

   ┌─────────────── RADIUS HA (VLAN 75) ───────────────┐
   │  radius-1 · radius-2 · VIP  ← autentica TODOS     │
   │  los NAS (MikroTik + NE8000)                      │
   └───────────────────────────────────────────────────┘
```

**Otro borde**: **RDA-Agote Gowland**, con BGP propio contra StarNetworks (AS 262259), local AS 27881.

---

## 2. Reglas críticas de operación

Estas no son recomendaciones. Cada una nace de un incidente.

| # | Regla | Consecuencia de romperla |
|---|---|---|
| 1 | **CCR2216: ningún cambio de firewall/raw/BGP sin OK explícito, regla por regla** | Es el **único** borde BGP de Mercedes. Media empresa sin internet |
| 2 | **`proxmox-2` (`10.3.3.6`): NO TOCAR** | Es el backup. Todo va a `proxmox-1` |
| 3 | **Huawei: NUNCA tocar AAA ni configuración de seguridad** | Te podés quedar afuera del equipo **de forma permanente** |
| 4 | **VM 114 (IXC): NUNCA modificar el firewall** | Es del proveedor, no nuestro |
| 5 | **NE-8000: los reintentos fallidos lockean cuenta E IP** | Hay que ir a consola. Verificado el 2026-06-30 |
| 6 | **No habilitar FTP en los MikroTik** | El puerto 21 está en el honeypot del scanner |

### Firewall MikroTik — checklist

1. **`print` fresco siempre** antes de cambiar nada: `/ip firewall raw print all`
2. **Nunca números de regla hardcodeados** → siempre `[find comment="..."]`
3. **Regla por regla**, con ping de verificación entre una y otra
4. Antes de un DROP sobre address-list, buscar IPs propias: `190.7.x.x`, `190.15.x.x`, `200.110.x.x`, `181.98.213.x`
5. Scan detection **siempre** con `src-address-list=!Admins` — si no, bloqueás el VPN Router
6. Umbral de detección de botnet: mínimo **15000 pkt/s**

### Particularidades por vendor

- **MikroTik**: la sesión SSH necesita modo no-interactivo explícito; el exec directo no funciona.
- **Huawei**: exige pausas entre comandos o corta la sesión, y **siempre** cierra con exit code 1
  (los scripts tienen que tolerarlo).
- **Arista**: en Telnet pide la password **antes** que el usuario.
- **NE-8000**: sólo acepta login leyendo prompts; el patrón de los otros Huawei no sirve.

---

## 3. Routers MikroTik (19)

### Borde BGP

| Equipo | IP | Rol |
|---|---|---|
| **CCR2216** | `190.7.253.193` | Borde BGP Mercedes. Conntrack deshabilitado, todo filtrado en `raw`. `BL_DROP` para bloqueos bidireccionales |
| **RDA-Agote Gowland** | `190.7.226.1` | Borde BGP Agote. Peering StarNetworks AS 262259, local AS 27881 |
| **Ovoprot** | `186.108.26.254` | Borde BGP Chivilcoy. WireGuard `wg-mgmt` ↔ CCR2216 (puerto 13350). El iBGP necesita `nexthop-choice=force-self` |

### PPPoE y distribución

| Equipo | IP | Zona / rol |
|---|---|---|
| Core_RDA_1 | `200.110.177.1` | PPPoE Mercedes + CGNAT |
| Core_RDA_2 | `10.2.2.2` | PPPoE Mercedes + CGNAT |
| **VPN Router** | `190.7.253.194` | **Puente a la red de gestión** — es el único camino a `10.3.3.x` desde afuera |
| Estudiantes | `10.64.9.2` | PPPoE Mercedes CGNAT |
| Arzobispado | `10.64.7.2` | PPPoE Mercedes |
| Jauregui OpenDoor | `10.64.5.2` | PPPoE Luján |
| Rodriguez / Catán | `10.17.6.2` | PPPoE CABA |
| Mercedes (Hípico/Areco/Giles) | `10.64.11.2` | PPPoE Mercedes CGNAT |
| Acceso Sur | `10.64.10.2` | PPPoE Mercedes |
| Canepa | `10.64.60.2` | PPPoE Chivilcoy |
| Parque Industrial | `10.64.69.2` | PPPoE Chivilcoy |
| Vialidad | `10.64.62.2` | PPPoE Chivilcoy |
| Ugarte | `10.64.64.2` | PPPoE Chivilcoy / 9 de Julio |
| DockSud Larroque | `10.39.6.252` | Nodo internet secundario. PowerBox Pro, **RouterOS 7.9 (desactualizada)** |
| DockSud Edificio | `10.39.6.177` | Nodo distribución |
| Municipio Chivilcoy | `190.7.231.250` | Nodo distribución. Uplink doble: CCR2216 vlan 1153 + Ovoprot ether2 |

**Rutas WireGuard CCR2216 → Chivilcoy:**
`10.64.60.0/30` Canepa · `10.64.62.0/30` Vialidad · `10.64.64.0/30` Ugarte · `10.64.69.0/30` Parque Industrial

---

## 4. Switches y BRAS Huawei / Arista (23)

### Mercedes

| Equipo | IP | Modelo | Rol |
|---|---|---|---|
| **N8000-1** | `10.39.94.252` | NE-8000 M8 | **BRAS** — termina el PPPoE de Acceso Sur y la fibra |
| 6720HI-MERC-HIPI | `10.39.94.253` | S6720-50L-HI | Core de distribución |
| HW-Arzobispado6720 | `10.39.94.44` | S6720-30C-EI | Distribución |
| HW-Suipacha5720 | `10.39.94.42` | S5720-28X-SI | Distribución |
| HW-Mercedes5300 | `10.39.94.31` | S5324TP-SI | Acceso |
| HW3300-OFICINA27 | `10.39.94.36` | S3328TP-EI | Acceso |
| HW-3300ALTAMIRA | `10.39.94.10` | S3328TP-SI | Acceso |

### Chivilcoy

| Equipo | IP | Modelo | Rol |
|---|---|---|---|
| **NE-20_1** | `10.39.94.251` | NE20E-S2F | **BRAS** Chivilcoy |
| Ovoprot 6720 | `10.39.94.56` | S6720-30C-EI | Distribución |
| HW-ChivilcoyOvoprot5300 | `10.39.94.32` | S5324TP-SI | Acceso |
| ParqueIndustrial-CTCI | `10.39.94.35` | **Arista** DCS-7280SE | Distribución |
| HW-Municipio5300 | `10.39.94.18` | S5324TP-SI | Acceso |
| MUNI_CHIV_DATACENTER | `10.39.94.200` | S5335-L48T4X | Datacenter municipal |

### Otras localidades

| Equipo | IP | Localidad | Modelo |
|---|---|---|---|
| HW-Jauregui6720 | `10.39.94.27` | Luján / Jáuregui | S6720-30C-EI |
| HW-BRAGADO6720 | `10.39.94.43` | Bragado | S6720-30C-EI |
| HW-Olascoaga3300 | `10.39.94.21` | Bragado | S3328TP-SI |
| HW-9DeJulio3300 | `10.39.94.40` | 9 de Julio | S3328TP-EI |
| HW-Alberti5300 | `10.39.94.33` | Alberti | S5324TP-SI |
| HW-Ugarte3300 | `10.39.94.19` | Ugarte | S3328TP-EI |
| HW-Rodriguez6720 | `10.39.94.55` | Gral. Rodríguez | S6720-30C-EI |
| HW-Catan6720 | `10.39.94.37` | González Catán | S6720-30C-EI |
| HW-Las Heras-Torre | `10.39.94.45` | Las Heras | S2326TP-EI |
| HW-Cab-Arg-DC | `10.39.94.46` | Las Heras / Cañuelas | S2326TP-EI |
| Canuelas | `10.39.94.110` | Cañuelas | S5720-52X-PWR |

---

## 5. Servidores y VMs

### proxmox-1 — `10.3.3.5` (el que se usa)

> **`proxmox-2` (`10.3.3.6`) es el backup y NO se toca.**

| VMID | Nombre | IP | Qué corre |
|---|---|---|---|
| 103 | TestBed | `190.7.234.34` | Sonet + bot de Telegram (containers Docker) |
| 105 | mercurio | `190.7.234.36` | **UISP** — NMS de los ~4000 Ubiquiti |
| 106 | **saturno** | `190.7.234.37` | "Frankestein": BD de clientes, desarrollo inhouse, **runners de deploy**, Grafana/Prometheus, oxidized |
| 107 | clonesaturno | `190.7.234.21` | Clone de saturno |
| 111 | Splynx | `190.7.234.41` | Billing/CRM **legacy** (lo reemplaza Prominense) |
| 114 | OPA-IXC | `190.7.234.42` | Server IXC (proveedor Brasil). 24 GB RAM, 16 cores. Tiene `qemu-guest-agent` |
| 101 | OPNsense | `10.10.100.59` | Firewall interno |

> Para llegar a `10.3.3.x` desde afuera hay que pasar por el **VPN Router** (`190.7.253.194`).

### vmware-1 — Dell 630 ESXi, `10.3.3.8`

| VMID | Nombre | IP | Qué corre |
|---|---|---|---|
| 47 | FreeRADIUS Gestión Real | `200.110.176.5` | RADIUS **legacy** — IDLE/deprecado desde 2025-08 |
| 44 | vCenter | `10.3.3.201` | `vcenter.ipnext.net.ar` |
| 41 | Aircontrol | prob. `190.15.240.10` | Gestión Ubiquiti (legacy) |
| 50 | Windows 2019 Tango | — | Windows Server 2019 |

> ⚠️ **Confusión frecuente**: `200.110.176.5` está en **vmware-1**, no en proxmox-2.
> Y es el RADIUS **viejo** — el que autentica hoy es el **HA en VLAN 75**.

### VM 130 — `flow-colector` (`10.75.0.40`)

El **cerebro del NOC**: FastNetMon, exabgp, Akvorado, watchdogs, `fnm_bot`, los sensores de fibra.

> ⚠️ **Regla dura**: antes de tocar cualquier servicio ahí hay que poner el modo mantenimiento
> (`maint start`), o los vigías disparan una lluvia de falsas alertas al Telegram del NOC.
> Al terminar, `maint end`.

---

## 6. IPs públicas /32 en el VPN Router

| IP | Servicio |
|---|---|
| `200.110.176.2` | DNS |
| `200.110.176.3` | ispweb |
| `200.110.176.4` | ispmail |
| `200.110.176.7` | WISPCONTROL (on-prem) |

El VPN Router también maneja: WISP `10.39.x.x` (40+ APs), clientes `172.20.x.x`,
gestión `10.3.3.0/24`, y los pools `190.7.231.0/27`, `190.7.234.16/29`, `190.7.234.32/28`.

---

## 7. Autenticación de clientes — RADIUS

**Todos los NAS autentican contra el RADIUS HA** (VLAN 75, esquema master-master con VIP).
Los `/ppp secret` locales quedaron atrás en la migración del 2026-06-30.

- El backend (Prominense) **no reimplementa RADIUS**: habla por REST con el `radius-orchestrator`.
- El corte por deuda es **blando** (por rate), no por rechazo de autenticación.
- Fuente de verdad del estado actual: `infra-ne8000/ESTADO-ACTUAL-RADIUS-PPPOE.md` (local).

---

## 8. Proyecto pendiente — migración OCA Netflix al CRS328

**Estado: PENDIENTE**

```
Hoy:      CCR2216 → sfp-sfpplus3/4 → OCA Netflix
Objetivo: CCR2216 → 6720HI (.253) → CRS309 (.253) → CRS328 (190.7.224.118) sfp-sfpplus3/4 → OCA
```

- El CRS328 ya tiene `vlan803` configurada (`10.0.80.252/24`)
- La IP de peering BGP `190.7.233.9/30` en esa vlan está **DISABLED (#16)** — hay que habilitarla al migrar
- Peering OCA: `190.7.233.9` (CCR2216) ↔ `190.7.233.10` (OCA), VLAN 803
- CRS309 (`10.3.3.253`): SSH conecta pero **no devuelve output en modo batch**

---

## 9. Dónde está cada cosa

| Necesito… | Está en |
|---|---|
| Topología, inventario, reglas de operación | **este archivo** |
| Cómo entrar a cada equipo (usuarios, claves, hostkeys) | `INFRAESTRUCTURA-LOCAL.md` 🔒 — **lo cargás vos a mano**, ver la sección del principio |
| Credenciales de app, MinIO, RADIUS HA, NE8000, GR | `CREDENCIALES-LOCAL.md` 🔒 |
| Estado actual de RADIUS/PPPoE (qué NAS autentica dónde) | `infra-ne8000/ESTADO-ACTUAL-RADIUS-PPPOE.md` 🔒 |
| Cómo se trabaja en los repos (deploy, worktrees, gates) | `WORKFLOW-MULTI-REPO.md` |
| Estado del trabajo, cards, deudas | `BACKLOG.md` |

🔒 = local, gitignored, **nunca commitear**

---

## 10. Deuda de seguridad conocida

- **Credenciales compartidas y reutilizadas** en ~45 equipos, con variantes que se diferencian sólo
  por un guión bajo o un signo duplicado. Es frágil y ya causó lockeos.
- El usuario de automatización tiene **escritura en casi todos los equipos**; sólo en el CCR2216 es
  de lectura.
- Resto de la deuda abierta (PAT de GitHub, credenciales en skills, enforcement de roles,
  leak de secretos NAS): `BACKLOG.md`, sección "🔧 Deudas conocidas".
