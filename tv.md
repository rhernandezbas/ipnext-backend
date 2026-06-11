# Referencia de API - Gigared Partners

**Versión:** 1.0.0  
**Base URL:** `https://partners.gigaredsa.com.ar/api/v1`

## Tabla de Contenidos

- [Autenticación](#autenticación)
- [Conceptos Fundamentales](#conceptos-fundamentales)
  - [Partner (Revendedor)](#partner-revendedor)
  - [CIC (Número de Cliente)](#cic-número-de-cliente)
  - [Internal ID](#internal-id)
  - [Account ID](#account-id)
- [Manejo de Errores](#manejo-de-errores)
- [Endpoints](#endpoints)
  - [Health](#health)
  - [Partners](#partners)
  - [API Keys](#api-keys)
  - [Cuentas](#cuentas)
  - [Servicios](#servicios)
  - [OTT](#ott)
- [Límites](#límites)
- [Primeros Pasos](#primeros-pasos)

---

## Autenticación

Todos los endpoints requieren autenticación mediante API Key, excepto `/health/live`.

### Header de Autenticación

Incluí tu API Key en el encabezado `X-API-Key` de cada solicitud:

```bash
curl -H "X-API-Key: tu-api-key-aqui" \
  https://partners.gigaredsa.com.ar/api/v1/partners/summary
```

### Códigos de Error de Autenticación

- **401 Unauthorized** - API Key faltante
- **403 Forbidden** - API Key inválida o partner inactivo

---

## Conceptos Fundamentales

### Partner (Revendedor)

Un Partner es un revendedor de servicios Gigared. Cada Partner tiene:

- **client_id**: Identificador único proporcionado por Gigared
- **name**: Nombre comercial del revendedor
- **internal_ids**: Mapeo entre CICs de Gigared e IDs internos del partner

Un Partner se autentica en la API usando su API Key. Todos los endpoints operan en el contexto de tu Partner.

### CIC (Número de Cliente)

El CIC es el identificador único que Gigared asigna a cada cliente en su sistema.

**Ejemplo:** `0000002354`

### Internal ID

El Internal ID es un identificador adicional que vos proporcionás para tus clientes. Permite integrar los sistemas de Gigared con tus propios sistemas.

- Lo creás y lo asociás a un CIC
- Cuando renovás un CIC, el `internal_id` pasa a estar asociado al nuevo CIC
- Te permite usar tu propio sistema de identificación
- Es único dentro de tu Partner
- Se asigna mediante el endpoint `/accounts/{cic}/internal_id`

**Ejemplos:** `MI_CLIENTE_001`, `USER_12345`, `ACCOUNT_ABC123`

**Caso de Uso:** Si en tu sistema interno identificas clientes por código de cliente, podés usar Internal ID para mapear ese código al CIC de Gigared.

### Account ID

En muchos endpoints, `account_id` es un parámetro flexible que puede ser:

1. Un CIC de Gigared (por defecto)
2. Un Internal ID que proporcionaste (si establecés `use_internal_id=true`)

Esta flexibilidad te permite:

- Consultar cuentas usando el CIC: `curl https://.../accounts/123456789`
- Consultar cuentas usando tu ID: `curl https://.../accounts/MI_CLIENTE_001?use_internal_id=true`

**Importante:** El parámetro `use_internal_id` es un query parameter que cambia la interpretación de `account_id`.

---

## Manejo de Errores

La API sigue el estándar RFC 9457 para problemas HTTP. Cada error devuelve un objeto JSON con:

- **status**: Código HTTP
- **type**: Identificador único del error (URI)
- **title**: Resumen del error
- **detail**: Explicación específica

### Ejemplo de Error

```json
{
  "status": 401,
  "type": "https://partners.gigaredsa.com.ar/errors/invalid-api-key",
  "title": "API Key inválida",
  "detail": "La API Key proporcionada no es válida. Por favor, verifique sus credenciales."
}
```

### Códigos Comunes

- **401** - API Key faltante
- **403** - API Key inválida o sin permisos
- **404** - Recurso no encontrado
- **424** - Error en servicio externo
- **429** - Límite de solicitudes excedido

---

## Endpoints

### Health

#### Liveness

Verifica que la API esté disponible. No requiere autenticación.

| Método | Path |
|--------|------|
| **GET** | `/health/live` |

**Respuesta 200:**

```json
{
  "status": "ok"
}
```

---

### Partners

#### Obtener Resumen

Obtiene un resumen del estado de tu partner, incluyendo cantidad de cuentas y servicios disponibles.

| Método | Path |
|--------|------|
| **GET** | `/partners/summary` |

**Encabezados:**

- `X-API-Key` (requerido)

**Respuesta 200:**

```json
{
  "message": "Éxito",
  "detail": {
    "accounts": {
      "registered": 3,
      "unregistered": 997,
      "total": 1000
    },
    "services": [
      {
        "id": "129",
        "name": "Gigared Play Full",
        "qty_available": 0,
        "qty_used": 1000,
        "qty_purchased": 1000
      },
      {
        "id": "39",
        "name": "Pack Todo Futbol",
        "qty_available": 49,
        "qty_used": 1,
        "qty_purchased": 50
      },
      {
        "id": "156",
        "name": "HBO Max",
        "qty_available": 0,
        "qty_used": 0,
        "qty_purchased": 0
      },
      {
        "id": "130",
        "name": "Hot Go",
        "qty_available": 0,
        "qty_used": 0,
        "qty_purchased": 0
      },
      {
        "id": "164",
        "name": "Teatrix",
        "qty_available": 0,
        "qty_used": 0,
        "qty_purchased": 0
      }
    ]
  }
}
```

#### Listar IDs Internos

Lista todos los IDs internos que has asociado a tus cuentas.

| Método | Path |
|--------|------|
| **GET** | `/partners/internal_ids` |

**Encabezados:**

- `X-API-Key` (requerido)

**Respuesta 200:**

```json
{
  "message": "Éxito",
  "detail": [
    {
      "cic": "0000000001",
      "internal_id": "CLIENTE_001"
    }
  ]
}
```

---

### API Keys

#### Crear Nueva API Key

Genera una nueva API Key. Útil para rotación de credenciales.

| Método | Path |
|--------|------|
| **POST** | `/api-keys` |

**Encabezados:**

- `X-API-Key` (requerido - tu API Key actual)

**Respuesta 200:**

```json
{
  "message": "API Key creada exitosamente",
  "detail": {
    "api_key": "f498656b01114b83a8551ce934bb27ca"
  }
}
```

**Flujo recomendado:**

1. Creá una nueva API Key
2. Actualizá tus sistemas con la nueva key
3. Revocá la key anterior

#### Revocar API Key

Revoca una API Key. Una vez revocada, no podrá utilizarse para autenticación.

| Método | Path |
|--------|------|
| **DELETE** | `/api-keys/{key_value}` |

**Parámetros:**

| Nombre | Ubicación | Descripción |
|--------|-----------|-------------|
| `key_value` | path | La API Key a revocar |

**Encabezados:**

- `X-API-Key` (requerido)

**Respuesta 200:**

```json
{
  "message": "API Key revocada exitosamente"
}
```

---

### Cuentas

#### Listar Cuentas

Lista todas tus cuentas de clientes con filtros opcionales.

| Método | Path |
|--------|------|
| **GET** | `/accounts` |

**Encabezados:**

- `X-API-Key` (requerido)

**Query Parameters:**

| Parámetro | Descripción |
|-----------|-------------|
| `account_id` (opcional) | Filtrar por CIC o Internal ID |
| `use_internal_id` (opcional, default=false) | Si `account_id` es un Internal ID |
| `gigared_id` (opcional) | Filtrar por ID interno de Gigared (abonumero) |
| `email` (opcional) | Filtrar por email |
| `services` (opcional) | Filtrar por servicios |
| `status` (opcional) | `registered` o `unregistered` |
| `pagination_limit` (opcional) | Cantidad de resultados |
| `pagination_offset` (opcional) | Desplazamiento de resultados |

**Ejemplo:**

```bash
curl "https://partners.gigaredsa.com.ar/api/v1/accounts?email=ejemplo@gigared.com.ar" \
  -H "X-API-Key: tu-api-key"
```

**Respuesta 200:**

```json
{
  "message": "Éxito",
  "detail": [
    {
      "crm": {
        "cic": "0000000001",
        "gigared_id": "10000000100",
        "email": "ejemplo@gigared.com.ar",
        "first_name": "Nombre",
        "last_name": "Apellido",
        "registration_date": "19/01/2026",
        "services": [
          {
            "id": "129",
            "name": "Gigared Play Full"
          }
        ]
      },
      "internal_id": "CLIENTE_001",
      "ott": {
        "id": "GIGA10000000100",
        "qty_stationary_licenses": 3,
        "qty_mobile_licenses": 5,
        "qty_registered_devices": 0,
        "status": "deshabilitado"
      }
    }
  ]
}
```

#### Obtener Detalle de Cuenta

Obtiene la información completa de una cuenta específica.

| Método | Path |
|--------|------|
| **GET** | `/accounts/{account_id}` |

**Parámetros:**

| Nombre | Ubicación | Descripción |
|--------|-----------|-------------|
| `account_id` | path | CIC o Internal ID |
| `use_internal_id` | query | Si `account_id` es un Internal ID (default=false) |

**Encabezados:**

- `X-API-Key` (requerido)

**Ejemplos:**

Por CIC:

```bash
curl "https://partners.gigaredsa.com.ar/api/v1/accounts/0000000001" \
  -H "X-API-Key: tu-api-key"
```

Por Internal ID:

```bash
curl "https://partners.gigaredsa.com.ar/api/v1/accounts/CLIENTE_001?use_internal_id=true" \
  -H "X-API-Key: tu-api-key"
```

**Respuesta 200:**

```json
{
  "message": "Éxito",
  "detail": {
    "crm": {
      "cic": "0000000001",
      "gigared_id": "10000000100",
      "email": null,
      "first_name": null,
      "last_name": null,
      "registration_date": null,
      "services": [
        {
          "id": "129",
          "name": "Gigared Play Full"
        }
      ]
    },
    "internal_id": "CLIENTE_001",
    "ott": {
      "id": "GIGA10000000100",
      "qty_stationary_licenses": 3,
      "qty_mobile_licenses": 5,
      "qty_registered_devices": 0,
      "status": null
    }
  }
}
```

#### Registrar Nueva Cuenta

Registra una nueva cuenta de cliente en el CUA.

| Método | Path |
|--------|------|
| **POST** | `/accounts/register` |

**Encabezados:**

- `X-API-Key` (requerido)
- `Content-Type: application/json`

**Body:**

```json
{
  "first_name": "Juan",
  "last_name": "Pérez",
  "email": "ejemplo@gigared.com",
  "cic": "0000000001",
  "password": "secure-password",
  "send_activation_email": true
}
```

**Respuesta 200:**

```json
{
  "message": "Éxito",
  "detail": "Registracion iniciada correctamente"
}
```

#### Activar Cuenta

Activa una cuenta previamente registrada en el CUA.

| Método | Path |
|--------|------|
| **POST** | `/accounts/activate` |

**Encabezados:**

- `X-API-Key` (requerido)
- `Content-Type: application/json`

**Body:**

```json
{
  "cic": "0000000001",
  "email": "ejemplo@gigared.com"
}
```

**Respuesta 200:**

```json
{
  "message": "Éxito",
  "detail": "Cuenta activada correctamente"
}
```

#### Actualizar Cuenta

Modifica datos de una cuenta registrada (email, nombre, apellido, contraseña).

| Método | Path |
|--------|------|
| **PATCH** | `/accounts/{account_id}` |

**Parámetros:**

| Nombre | Ubicación | Descripción |
|--------|-----------|-------------|
| `account_id` | path | CIC o Internal ID |
| `use_internal_id` | query | Si `account_id` es un Internal ID (default=false) |

**Encabezados:**

- `X-API-Key` (requerido)
- `Content-Type: application/json`

**Body (opcional):**

```json
{
  "email": "nuevo@gigared.com",
  "first_name": "Juan",
  "last_name": "Pérez",
  "password": "new-password"
}
```

**Nota:** Incluí sólo los campos que querés actualizar.

**Respuesta 200:**

```json
{
  "message": "Éxito",
  "detail": "Cuenta actualizada correctamente"
}
```

#### Asociar Internal ID a Cuenta

Asocia un ID interno (el tuyo) a una cuenta existente identificada por su CIC.

| Método | Path |
|--------|------|
| **PATCH** | `/accounts/{cic}/internal_id` |

**Parámetros:**

| Nombre | Ubicación | Descripción |
|--------|-----------|-------------|
| `cic` | path | CIC de Gigared |

**Encabezados:**

- `X-API-Key` (requerido)
- `Content-Type: application/json`

**Body:**

```json
{
  "internal_id": "MI_CLIENTE_001"
}
```

**Respuesta 200:**

```json
{
  "message": "Éxito",
  "detail": "ID interno 'CLIENTE_001' asociado al CIC 0000000001"
}
```

#### Renovar CIC

Genera un nuevo CIC para una cuenta.

| Método | Path |
|--------|------|
| **PUT** | `/accounts/{account_id}/renew` |

**Parámetros:**

| Nombre | Ubicación | Descripción |
|--------|-----------|-------------|
| `account_id` | path | CIC o Internal ID actual |
| `use_internal_id` | query | Si `account_id` es un Internal ID (default=false) |

**Encabezados:**

- `X-API-Key` (requerido)

**Respuesta 200:**

```json
{
  "message": "Éxito",
  "detail": {
    "old_cic": "0000000001",
    "new_cic": "0000000002"
  }
}
```

---

### Servicios

#### Listar Servicios de Cuenta

Lista todos los servicios asignados a una cuenta.

| Método | Path |
|--------|------|
| **GET** | `/services/{account_id}` |

**Parámetros:**

| Nombre | Ubicación | Descripción |
|--------|-----------|-------------|
| `account_id` | path | CIC o Internal ID |
| `use_internal_id` | query | Si `account_id` es un Internal ID |

**Encabezados:**

- `X-API-Key` (requerido)

**Ejemplo:**

```bash
curl "https://partners.gigaredsa.com.ar/api/v1/services/0000000001" \
  -H "X-API-Key: tu-api-key"
```

**Respuesta 200:**

```json
{
  "message": "Éxito",
  "detail": [
    {
      "id": "129",
      "name": "Gigared Play Full"
    }
  ]
}
```

#### Agregar Servicio a Cuenta

Asigna un servicio a una cuenta.

| Método | Path |
|--------|------|
| **POST** | `/services/{account_id}` |

**Parámetros:**

| Nombre | Ubicación | Descripción |
|--------|-----------|-------------|
| `account_id` | path | CIC o Internal ID |
| `service_id` | query | ID del servicio a agregar |
| `use_internal_id` | query | Si `account_id` es un Internal ID |

**Encabezados:**

- `X-API-Key` (requerido)

**Ejemplo:**

```bash
curl -X POST "https://partners.gigaredsa.com.ar/api/v1/services/0000000001?service_id=100" \
  -H "X-API-Key: tu-api-key"
```

**Respuesta 200:**

```json
{
  "message": "Éxito",
  "detail": "Servicio agregado con éxito"
}
```

#### Remover Servicio de Cuenta

Quita un servicio de una cuenta.

| Método | Path |
|--------|------|
| **DELETE** | `/services/{account_id}/{service_id}` |

**Parámetros:**

| Nombre | Ubicación | Descripción |
|--------|-----------|-------------|
| `account_id` | path | CIC o Internal ID |
| `service_id` | path | ID del servicio a remover |
| `use_internal_id` | query | Si `account_id` es un Internal ID |

**Encabezados:**

- `X-API-Key` (requerido)

**Ejemplo:**

```bash
curl -X DELETE "https://partners.gigaredsa.com.ar/api/v1/services/0000000001/100" \
  -H "X-API-Key: tu-api-key"
```

**Respuesta 200:**

```json
{
  "message": "Éxito",
  "detail": "Servicio eliminado con éxito"
}
```

---

### OTT

#### Deshabilitar Cuenta OTT

Deshabilita el acceso OTT (streaming) de una cuenta.

| Método | Path |
|--------|------|
| **PUT** | `/ott/{account_id}/disable` |

**Parámetros:**

| Nombre | Ubicación | Descripción |
|--------|-----------|-------------|
| `account_id` | path | CIC o Internal ID |
| `use_internal_id` | query | Si `account_id` es un Internal ID |

**Encabezados:**

- `X-API-Key` (requerido)

**Respuesta 200:**

```json
{
  "message": "Éxito",
  "detail": "La cuenta OTT sera deshabilitada en los proximos minutos"
}
```

#### Habilitar Cuenta OTT

Habilita el acceso OTT (streaming) de una cuenta.

| Método | Path |
|--------|------|
| **PUT** | `/ott/{account_id}/enable` |

**Parámetros:**

| Nombre | Ubicación | Descripción |
|--------|-----------|-------------|
| `account_id` | path | CIC o Internal ID |
| `use_internal_id` | query | Si `account_id` es un Internal ID |

**Encabezados:**

- `X-API-Key` (requerido)

**Respuesta 200:**

```json
{
  "message": "Éxito",
  "detail": "La cuenta OTT sera habilitada en los proximos minutos"
}
```

---

## Límites

- **Rate Limiting:** La API implementa límites de solicitudes. Si excedés el límite, recibirás un error **429 Too Many Requests**.

---

## Primeros Pasos

Bienvenido a Gigared Partners API. Esta guía te ayudará a comenzar en 5 minutos.

### Requisitos

- Una cuenta de revendedor en Gigared
- Una API Key (te será provista por tu Ejecutivo de Cuentas)
- Acceso a herramientas básicas como `curl`, Postman o un navegador
- También podés hacer las peticiones desde nuestro Swagger en `https://partners.gigaredsa.com.ar/api-docs`

### URL Base

```
https://partners.gigaredsa.com.ar/api/v1
```

### Paso 1: Obtené tu API Key

La vas a necesitar para la mayoría de las solicitudes. Si no tenés una API Key, contactá a tu Ejecutivo de Cuentas.

### Paso 2: Verificá que la API esté disponible

```bash
curl https://partners.gigaredsa.com.ar/api/v1/health/live
```

Deberías recibir:

```json
{
  "status": "ok"
}
```

### Paso 3: Autenticá tus primeras solicitudes

Todas las solicitudes requieren tu API Key en el encabezado `X-API-Key`:

```bash
curl https://partners.gigaredsa.com.ar/api/v1/partners/summary \
  -H "X-API-Key: TU_API_KEY"
```

Este endpoint devuelve un resumen de tu cuenta de revendedor.

### Paso 4: Obtené información básica

**Listar tus cuentas de clientes:**

```bash
curl https://partners.gigaredsa.com.ar/api/v1/accounts \
  -H "X-API-Key: TU_API_KEY"
```

**Consultar una cuenta específica:**

```bash
curl https://partners.gigaredsa.com.ar/api/v1/accounts/ACCOUNT_ID \
  -H "X-API-Key: TU_API_KEY"
```

### Conceptos Clave

#### CIC (Número de Cliente)

Es el identificador único de cada cliente en el sistema de Gigared. Se utiliza para consultar información de clientes y realizar operaciones en sus cuentas.

#### Internal ID (ID Interno)

Es un identificador adicional que vos proporcionás para tus clientes. Te permite usar tus propios sistemas de identificación junto con los de Gigared.

**Ejemplo:** Si tu cliente tiene CIC `123456789` en Gigared, vos podrías asignarle Internal ID `CLIENTE_001` en tu sistema.

#### Account ID

En los endpoints, el parámetro `account_id` puede ser:

- Un CIC de Gigared, o
- Un Internal ID que vos proporcionaste

Usá el parámetro `use_internal_id=true` cuando quieras consultar por Internal ID.

**Consultar por CIC (default):**

```bash
curl https://partners.gigaredsa.com.ar/api/v1/accounts/123456789 \
  -H "X-API-Key: TU_API_KEY"
```

**Consultar por Internal ID:**

```bash
curl "https://partners.gigaredsa.com.ar/api/v1/accounts/CLIENTE_001?use_internal_id=true" \
  -H "X-API-Key: TU_API_KEY"
```

### Próximos Pasos

- Leé la Referencia de API para conocer todos los endpoints disponibles
- Explorá los ejemplos de cada operación
- Implementá integraciones en tu sistema

### Soporte

Si tenés problemas o preguntas, comunicate con tu Ejecutivo de Cuentas.

---

**Versión y Cambios:** Esta documentación corresponde a la versión 1.0.0 de Gigared Partners API. Los cambios importantes se notificarán con anticipación.
