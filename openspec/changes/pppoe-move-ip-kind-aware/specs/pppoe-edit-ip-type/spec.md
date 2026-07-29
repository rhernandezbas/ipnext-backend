# Pppoe Edit Ip Type Specification

## Purpose

El modal "Internet — PPPoE" ofrece un toggle `Privada / Pública` que **hoy no se persiste**: solo
alimenta la sugerencia de IP (`useNextFreeIp`) y nunca sale al backend. Este spec cierra ese
agujero y agrega la mitad de UI que el usuario pidió: **ofrecer solo los tipos que el NAS
seleccionado soporta**.

Regla de las dos capas del workflow: el FE es **comodidad** (no ofrece lo imposible), el BE es
**autoridad** (rechaza lo inválido aunque el FE lo mande).

## Requirements

### Requirement: The chosen IP type is persisted
El sistema DEBE (MUST) enviar y persistir el `ipTypePreference` elegido en el modal de edición,
incluso cuando el NAS no cambia.

#### Scenario: Changing only the IP type saves it
- GIVEN un servicio con `ipTypePreference='cgnat'` en un NAS que soporta ambas clases
- WHEN el operador cambia el tipo a "Pública" y guarda, sin tocar el router
- THEN el `ipTypePreference` del servicio queda en `'public'`

#### Scenario: Unchanged type sends nothing (no spurious writes)
- GIVEN el operador abre el form de edición y no toca el tipo de IP
- WHEN guarda otro campo (p. ej. la contraseña)
- THEN el body NO incluye `ipTypePreference`

### Requirement: Only supported IP types are offered per NAS
El FE DEBE (MUST) ofrecer únicamente los tipos presentes en `supportedIpKinds` del NAS
seleccionado. Si soporta una sola clase, esa queda fijada y la otra no se muestra.

#### Scenario: Selecting a public-only NAS hides the private option
- GIVEN el operador está editando un PPPoE
- WHEN selecciona el router "NE8000 - Mercedes" (`supportedIpKinds: ['public']`)
- THEN la opción "Privada" NO se muestra
- AND "Pública" queda seleccionada

#### Scenario: Selecting a NAS that supports both offers both
- GIVEN el operador está editando un PPPoE
- WHEN selecciona un router con `supportedIpKinds: ['cgnat','public']`
- THEN se muestran ambas opciones y puede elegir

#### Scenario: Unknown supported kinds fall back to offering both
- GIVEN el NAS seleccionado llega con `supportedIpKinds` vacío o ausente
- WHEN el operador mira el toggle
- THEN se muestran ambas opciones
- AND el backend es el que rechaza si la combinación es inválida

> **Por qué el fallback muestra ambas y no ninguna:** esconder las dos bloquearía al operador
> por un fallo de lectura ajeno a su intención. Molestarlo con un error claro del backend es
> preferible a un formulario muerto sin explicación.

### Requirement: Accessible, own-component selector
El selector de tipo de IP DEBE (MUST) cumplir las reglas de diseño front del workflow: componente
propio (nunca `<select>` nativo), tokens del design system, `aria-pressed` en los toggles, focus
visible, y touch target ≥44px.

#### Scenario: Keyboard operable
- GIVEN el foco está en el selector de tipo de IP
- WHEN el operador navega con teclado
- THEN puede cambiar la selección sin mouse y el foco es visible en todo momento
