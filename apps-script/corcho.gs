/** Corcho privado · CTR-DESPACHO-CORCHO.
 * Añadir al proyecto existente de Operación. Antes del guard general TA:
 *   if (/^corcho(Get|Save)$/.test(payload.action || '')) {
 *     return jsonOut_(corchoHandle_(payload));
 *   }
 * Propiedades privadas: CORCHO_OWNER_EMAIL, CORCHO_SPREADSHEET_ID.
 * No modificar getAll/update; no crear infraestructura ni cambiar permisos.
 * Drive se consulta solo con los scopes ya autorizados del proyecto actual.
 */
function corchoHandle_(payload) {
  payload = payload || {};
  if (payload.action !== 'corchoGet' && payload.action !== 'corchoSave') return { ok: false, error: 'accion' };
  if (!corchoOwner_(payload.k)) return { ok: false, error: 'acceso' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'ocupado' };
  try {
    var spreadsheetId = PropertiesService.getScriptProperties().getProperty('CORCHO_SPREADSHEET_ID');
    if (!spreadsheetId) return { ok: false, error: 'configuracion' };
    corchoStorageGuard_(spreadsheetId);
    var book = SpreadsheetApp.openById(spreadsheetId);
    var sheet = book.getSheetByName('Corcho');
    if (!sheet) return { ok: false, error: 'configuracion' };
    var current = corchoRead_(sheet);
    if (payload.action === 'corchoGet') return { ok: true, version: current.version, data: current.data };
    if (!Number.isSafeInteger(payload.version) || payload.version < 0) return { ok: false, error: 'version' };
    if (payload.version !== current.version) return { ok: false, error: 'conflicto', version: current.version };
    var prepared = corchoPrepare_(payload.data, current);
    var nextVersion = current.version + 1;
    var rows = [['id', 'version', 'payload_json'], ['@config', nextVersion, JSON.stringify(prepared.axes)]];
    prepared.notes.forEach(function (note) { rows.push([note.id, nextVersion, JSON.stringify(note)]); });
    // Sin caché positiva: volver a comprobar ACL/principal antes de escribir.
    corchoStorageGuard_(spreadsheetId);
    // Todos los campos libres están dentro de JSON. IDs aceptados no son fórmulas.
    // El snapshot incluye las notas omitidas del cliente; jamás borra filas/notas.
    sheet.getRange(1, 1, rows.length, 3).setValues(rows);
    SpreadsheetApp.flush();
    corchoStorageGuard_(spreadsheetId);
    var saved = corchoRead_(sheet);
    if (saved.version !== nextVersion || JSON.stringify(saved.data) !== JSON.stringify(prepared)) return { ok: false, error: 'guardado_por_conciliar' };
    return { ok: true, version: saved.version, data: saved.data };
  } catch (err) {
    // Nunca devolver stack ni datos/identidad privada en el protocolo o logs.
    return { ok: false, error: err && err.corchoCode || 'servicio' };
  } finally { lock.releaseLock(); }
}

function corchoOwner_(key) {
  var props = PropertiesService.getScriptProperties();
  var owner = String(props.getProperty('CORCHO_OWNER_EMAIL') || '').trim().toLowerCase();
  key = String(key || '').trim();
  if (!owner || key.length < 4 || key.length > 4096) return false;
  try {
    // Sin caché positiva: revocar DP o la sesión tiene efecto en la siguiente llamada.
    var result = UrlFetchApp.fetch(PORTERO_EXEC + '?recurso=canje&t=' + encodeURIComponent(key), { muteHttpExceptions: true, followRedirects: true });
    if (result.getResponseCode() !== 200) return false;
    var identity = JSON.parse(result.getContentText());
    // El contrato real de canje usa `correo`; jamás tomarlo del payload cliente.
    var email = String(identity.correo || '').trim().toLowerCase();
    var boards = Array.isArray(identity.boards) ? identity.boards : String(identity.boards || '').split(/[,;|\s]+/);
    var allowed = boards.map(function (s) { return String(s).trim().toUpperCase(); }).indexOf('DP') >= 0 || String(identity.rol || '').toLowerCase() === 'admin' || boards.indexOf('*') >= 0;
    return identity.ok === true && email === owner && allowed;
  } catch (err) { return false; }
}

function corchoFail_(code) { var error = new Error('Corcho'); error.corchoCode = code; throw error; }

// Preflight privado desde el editor actual; no añadir una ruta pública para él.
// Usa el MISMO token/principal y guard que el runtime; no devuelve IDs ni correos.
function corchoPreflight_() {
  try {
    var id = PropertiesService.getScriptProperties().getProperty('CORCHO_SPREADSHEET_ID');
    if (!id) corchoFail_('configuracion');
    corchoStorageGuard_(id);
    return { ok: true };
  } catch (err) { return { ok: false, error: err && err.corchoCode || 'privacidad_no_verificada' }; }
}

function corchoDriveGet_(path, query, token) {
  var search = Object.keys(query).map(function (key) { return encodeURIComponent(key) + '=' + encodeURIComponent(query[key]); }).join('&');
  var response;
  try {
    response = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/' + path + '?' + search, {
      method: 'get', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true, followRedirects: false
    });
  } catch (err) { corchoFail_('consentimiento_requerido'); }
  var status = response.getResponseCode();
  if (status === 401 || status === 403) corchoFail_('consentimiento_requerido');
  if (status !== 200) corchoFail_('privacidad_no_verificada');
  var body;
  try { body = JSON.parse(response.getContentText()); } catch (err) { corchoFail_('privacidad_no_verificada'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) corchoFail_('privacidad_no_verificada');
  return body;
}

function corchoStorageGuard_(spreadsheetId) {
  var owner = String(PropertiesService.getScriptProperties().getProperty('CORCHO_OWNER_EMAIL') || '').trim().toLowerCase();
  if (!owner || typeof spreadsheetId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(spreadsheetId)) corchoFail_('configuracion');
  var token;
  try { token = ScriptApp.getOAuthToken(); } catch (err) { corchoFail_('consentimiento_requerido'); }
  if (!token || typeof token !== 'string') corchoFail_('consentimiento_requerido');
  // getOAuthToken corresponde al usuario efectivo, no a la identidad del cliente.
  var principal = corchoDriveGet_('about', { fields: 'user(emailAddress,permissionId)' }, token).user;
  if (!principal || String(principal.emailAddress || '').toLowerCase() !== owner || !principal.permissionId) corchoFail_('principal_incompatible');
  var visited = Object.create(null), pending = [spreadsheetId], files = 0;
  while (pending.length) {
    var id = pending.pop();
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id) || visited[id] || ++files > 100) corchoFail_('privacidad_no_verificada');
    visited[id] = true;
    var filePath = 'files/' + encodeURIComponent(id);
    var file = corchoDriveGet_(filePath, {
      fields: 'id,mimeType,driveId,trashed,ownedByMe,owners(emailAddress,permissionId),parents',
      supportsAllDrives: 'true'
    }, token);
    var expectedType = id === spreadsheetId ? 'application/vnd.google-apps.spreadsheet' : 'application/vnd.google-apps.folder';
    if (file.id !== id || file.mimeType !== expectedType || file.driveId || file.trashed !== false || file.ownedByMe !== true ||
        !Array.isArray(file.owners) || file.owners.length !== 1 ||
        String(file.owners[0].emailAddress || '').toLowerCase() !== owner || file.owners[0].permissionId !== principal.permissionId) corchoFail_('almacen_no_privado');
    var parents = file.parents === undefined ? [] : file.parents;
    if (!Array.isArray(parents) || parents.length > 1) corchoFail_('privacidad_no_verificada');
    parents.forEach(function (parent) { pending.push(parent); });
    var pageToken = '', seenTokens = Object.create(null), pages = 0, permissions = 0;
    do {
      if (++pages > 100 || (pageToken && seenTokens[pageToken])) corchoFail_('privacidad_no_verificada');
      seenTokens[pageToken] = true;
      var query = { fields: 'nextPageToken,permissions(id,type,role,emailAddress,deleted,pendingOwner,view)',
        pageSize: '100', supportsAllDrives: 'true', includePermissionsForView: 'published' };
      if (pageToken) query.pageToken = pageToken;
      var page = corchoDriveGet_(filePath + '/permissions', query, token);
      if (!Array.isArray(page.permissions)) corchoFail_('privacidad_no_verificada');
      page.permissions.forEach(function (permission) {
        if (!permission || permission.type !== 'user' || permission.role !== 'owner' || permission.deleted || permission.pendingOwner || permission.view ||
            String(permission.emailAddress || '').toLowerCase() !== owner || permission.id !== principal.permissionId || ++permissions > 1) corchoFail_('almacen_no_privado');
      });
      if (page.nextPageToken !== undefined && (typeof page.nextPageToken !== 'string' || !page.nextPageToken)) corchoFail_('privacidad_no_verificada');
      pageToken = page.nextPageToken || '';
    } while (pageToken);
    if (permissions !== 1) corchoFail_('privacidad_no_verificada');
  }
}

function corchoRead_(sheet) {
  if (!sheet || sheet.getLastRow() === 0) corchoFail_('almacen');
  var rows = sheet.getRange(1, 1, sheet.getLastRow(), 3).getValues();
  if (rows[0].join('|') !== 'id|version|payload_json') corchoFail_('almacen');
  if (rows.length === 1) return { version: 0, data: { axes: { ejeX: 'Personas', ejeY: 'Pendientes' }, notes: [] } };
  var version = 0, axes = null, notes = [], used = {};
  rows.slice(1).forEach(function (row) {
    if (!row[0]) return;
    var id = String(row[0]);
    if (used[id] || !Number.isSafeInteger(Number(row[1])) || Number(row[1]) < 1) corchoFail_('almacen');
    used[id] = true;
    var value; try { value = JSON.parse(row[2]); } catch (err) { corchoFail_('almacen'); }
    if (id === '@config') { version = Number(row[1]); axes = value; }
    else { if (!value || value.id !== id) corchoFail_('almacen'); notes.push(value); }
  });
  if (!axes) corchoFail_('almacen');
  return { version: version, data: { axes: axes, notes: notes } };
}

function corchoText_(value, max, required) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) corchoFail_('dato_invalido');
  return value;
}
function corchoPrepare_(data, current) {
  if (!data || typeof data !== 'object' || !data.axes || !Array.isArray(data.notes) || data.notes.length > 500) corchoFail_('dato_invalido');
  var axes = { ejeX: corchoText_(data.axes.ejeX, 100, true), ejeY: corchoText_(data.axes.ejeY, 100, true) };
  var oldById = {}, seen = {}, now = new Date().toISOString();
  current.data.notes.forEach(function (n) { oldById[n.id] = n; });
  var supplied = data.notes.map(function (n) {
    if (!n || typeof n.id !== 'string' || !/^N-[A-Za-z0-9-]{1,96}$/.test(n.id) || seen[n.id]) corchoFail_('id_invalido');
    seen[n.id] = true;
    if (typeof n.x !== 'number' || typeof n.y !== 'number' || !isFinite(n.x) || !isFinite(n.y) || n.x < 0 || n.x > 88 || n.y < 0 || n.y > 88) corchoFail_('posicion');
    if (['arena', 'rosa', 'verde', 'azul', 'lila'].indexOf(n.color) < 0 || ['activo', 'archivado'].indexOf(n.estado) < 0) corchoFail_('dato_invalido');
    var old = oldById[n.id];
    var note = { id: n.id, titulo: corchoText_(n.titulo, 160, true), cuerpo: corchoText_(n.cuerpo, 12000, false),
      ejeX: corchoText_(n.ejeX, 100, false), ejeY: corchoText_(n.ejeY, 100, false), x: n.x, y: n.y, color: n.color, estado: n.estado,
      createdAt: old ? old.createdAt : now, updatedAt: now };
    if (old) {
      var equal = ['titulo', 'cuerpo', 'ejeX', 'ejeY', 'x', 'y', 'color', 'estado'].every(function (field) { return note[field] === old[field]; });
      if (equal) note.updatedAt = old.updatedAt;
    }
    return note;
  });
  // Preservar orden de registros existentes permite actualizar sin purgar ni reordenar.
  var byId = {}; supplied.forEach(function (note) { byId[note.id] = note; });
  var notes = current.data.notes.map(function (old) { return byId[old.id] || old; });
  supplied.forEach(function (note) { if (!oldById[note.id]) notes.push(note); });
  if (notes.length > 500) corchoFail_('limite');
  return { axes: axes, notes: notes };
}
