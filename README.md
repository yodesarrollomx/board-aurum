# MOAC · Operación semanal (board-aurum)

Tablero de tareas semanales de Yo Desarrollo / Aurum. Código de acceso **`TA`**
(ver `yod-portal/CODIGOS-BOARDS.md`). No confundir con **`aurum-board`**, que es el
tablero de Métricas del embudo comercial (`MK`).

## URL en vivo
https://yodesarrollomx.github.io/board-aurum/ (la casa vieja `alexpueblag.github.io` solo reenvía).

## Cómo fluyen los datos
El board (React + Vite, `src/App.jsx`) lee y escribe **directo** al Apps Script de
Operación (`APPS_SCRIPT_URL`, `src/App.jsx:24`), el mismo que usa el Pulso de YOD OS
(`yod-portal/os/adapters/operations.js`). El Sheet es el único almacén: lo que ves es lo
que el Sheet confirma. No hay `data.json` público ni sincronización desde la Mac
(`scripts/sync_sheet.*` son históricos).

Publicación: `.github/workflows/deploy.yml` construye y publica en Pages en cada push a `main`.

## Acceso
Entrar con Google a través del **Portero YOD** (`potenciales-yod/portero.js`). Cada petición
lleva la credencial (`k`) y el Apps Script la valida con `board=TA`; sin ella no entrega datos.
