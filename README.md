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

## Encargos y problemas de clasificación

La captura prepara acciones con títulos breves, conserva el encargo completo en
observaciones y propone solo proyectos y objetivos existentes. Las referencias
ambiguas quedan visibles para precisar; la preparación local no utiliza IA ni
crea proyectos u objetivos. Una acción aparece confirmada después de recibir su
ID y el ACK del vínculo. Un vínculo fallido conserva el ID; una respuesta de
creación perdida se concilia por marcador antes de repetirla.
También se puede preparar un encargo existente desde su ficha: la primera acción
conserva el ID y el historial, y las demás reciben IDs propios. No se cierra el
encargo ni se destruye su contexto al prepararlo.

«Datos por corregir» separa tareas sin proyecto, proyecto sin registro,
responsable vacío o encargos de corrección del sistema de la operación semanal.
No cambia el registro ni lo marca terminado. Los flags de Sheets se interpretan
como booleanos, incluyendo textos `TRUE`/`FALSE`.

## Corcho privado · integración pendiente

`apps-script/corcho.gs` implementa `CTR-DESPACHO-CORCHO` y se verifica con dobles;
su presencia aquí no significa que esté desplegado. El adaptador provisional de
Sala #35 se integrará por el coordinador **en el backend Portero existente**:
después de parsear JSON en `d`, antes de `cfg` y de `esCredencialValida_`, con
`respuesta_(corchoHandle_(d))` solo para `d.action === 'corchoGet'` o
`d.action === 'corchoSave'`. Conserva `getAll` y `update`.

La identidad local usa `canjearLigaLento_(key, 'DP')`, sin renovar sesiones ni
escribir caché. Nunca invoca `canjearLiga_`; si el backend local solo tiene ese
helper, falla cerrado. Sin Portero local mantiene el canje HTTP original con
`PORTERO_EXEC`. Un rechazo local no recurre al remoto.

`corchoProperties_()` prefiere ScriptProperties por clave y, si falta, permite
el fallback solo cuando existe la función privada `corchoDeploymentConfig_()`.
Requiere `CORCHO_OWNER_EMAIL` y `CORCHO_SPREADSHEET_ID`, sin valores públicos por
defecto. La plantilla `apps-script/corcho-deployment-config.gs.example` contiene
solo placeholders y **no se despliega**. La propuesta de alojamiento, el despacho
exacto y la evidencia pendiente se detallan en
[el documento del adaptador](docs/corcho-portero-adapter.md); revisión de Atlas
pendiente antes de integrar.

- `corchoGet {k}` → `{ok, version, data: {axes, notes}}`; leer no crea recursos.
- `corchoSave {k, version, data}` → ACK con versión global confirmada. Un
  conflicto devuelve `{ok:false,error:"conflicto",version}` sin sobrescribir.
- Ejes `{ejeX,ejeY}` de hasta 100 caracteres. Notas con ID `N-*`, título de
  hasta 160, cuerpo de hasta 12000, etiquetas de eje de hasta 100, posiciones
  numéricas de 0 a 88, color `arena/rosa/verde/azul/lila` y estado
  `activo/archivado`. Las fechas las conserva/genera el servidor.
- Solo el correo exacto del propietario, obtenido del canje Portero, con DP o
  autorización administrativa vigente. Un administrador ajeno no accede.
- Hoja `Corcho`: `id,version,payload_json`; `@config` guarda ejes y versión
  global. Toda fila ocupada debe tener esa misma versión; un snapshot mezclado
  falla cerrado. Se preservan las notas omitidas; archivo/restauración no borran filas.
- El almacén es un libro privado separado. La infraestructura y los headers
  se preparan antes de la integración; el handler no crea libros, pestañas ni
  permisos. Una hoja con solo los headers devuelve la versión inicial cero.
- El guard usa el token del usuario efectivo para comprobar en Drive que ese
  principal y el propietario configurado coinciden. Recorre archivo y todos
  sus ancestros, y todas las páginas de permisos, incluida la vista publicada.
  Solo acepta un propietario exacto: rechaza unidades compartidas, otros
  usuarios, grupos, dominios, accesos públicos y metadatos incompletos.
- Cada lectura revalida el guard; cada escritura lo revalida también justo
  antes de `setValues`. No hay caché positiva ni almacén alternativo. Drive y
  Sheets no ofrecen una transacción conjunta que bloquee cambios externos de
  ACL durante la operación.
- No se amplían scopes automáticamente. Sin token/scope/servicio disponible se
  devuelve `consentimiento_requerido`; si no se puede demostrar la privacidad,
  no se accede a las notas. `corchoPreflight_` permite verificar el mismo guard
  desde el editor sin leer notas ni devolver IDs/correos. No es una ruta pública
  ni sustituye verificar el principal de la implementación en ejecución.

El guard consulta únicamente metadatos mediante [Drive `files.get`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get),
[`permissions.list`](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/list)
y [`about.get`](https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get).
El token de [Apps Script corresponde al usuario efectivo](https://developers.google.com/apps-script/reference/script/script-app#getOAuthToken()).

Antes de desplegar: identificar fuente activa, respaldar editor y versión,
comprobar manifiesto/scopes ya consentidos y las dependencias, verificar ACL y
propietario del libro privado, integrar el handler y conservar URL y permisos.
La verificación productiva es de lectura; escrituras de prueba solo con dobles.
