import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../apps-script/corcho.gs', import.meta.url), 'utf8');
function fixture() {
  const state = { identity: { ok: true, correo: 'owner@example.test', boards: 'DP', rol: 'direccion' }, created: 0, writes: 0, reads: 0, opens: 0,
    rows: [['id', 'version', 'payload_json']], locked: true, releases: 0, fetches: 0, driveRequests: [], driveStatus: 200, tokenFailure: false,
    principal: { emailAddress: 'owner@example.test', permissionId: 'owner-id' }, driveHook: null, permissionPages: {}, files: {} };
  const ownerFile = id => ({ id, mimeType: 'application/vnd.google-apps.folder', trashed: false, ownedByMe: true,
    owners: [{ emailAddress: 'owner@example.test', permissionId: 'owner-id' }], parents: [] });
  state.files = { 'synthetic-book': { ...ownerFile('synthetic-book'), mimeType: 'application/vnd.google-apps.spreadsheet', parents: ['private-folder'] }, 'private-folder': ownerFile('private-folder') };
  for (const id of Object.keys(state.files)) state.permissionPages[id] = { '': { permissions: [{ id: 'owner-id', type: 'user', role: 'owner', emailAddress: 'owner@example.test' }] } };
  const sheet = { getLastRow: () => state.rows?.length || 0, getRange: (_r, _c, _n, _m) => ({ getValues: () => { state.reads++; return structuredClone(state.rows); }, setValues: rows => { state.writes++; state.rows = structuredClone(rows); } }) };
  const book = { getSheetByName: () => state.rows ? sheet : null, insertSheet: () => { state.created++; return sheet; } };
  const props = { CORCHO_OWNER_EMAIL: 'owner@example.test', CORCHO_SPREADSHEET_ID: 'synthetic-book' };
  const context = vm.createContext({
    PORTERO_EXEC: 'https://portero.example.test/exec',
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => props[key] }) },
    ScriptApp: { getOAuthToken: () => { if (state.tokenFailure) throw new Error('synthetic-private-token'); return 'synthetic-token'; } },
    UrlFetchApp: { fetch: (url, options) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'portero.example.test') { state.fetches++; return { getResponseCode: () => 200, getContentText: () => JSON.stringify(state.identity) }; }
      assert.equal(parsed.origin, 'https://www.googleapis.com'); assert.equal(options.method, 'get'); assert.equal(options.followRedirects, false);
      assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
      state.driveRequests.push(parsed); if (state.driveHook) state.driveHook(parsed);
      let body;
      if (parsed.pathname === '/drive/v3/about') body = { user: state.principal };
      else {
        const match = parsed.pathname.match(/^\/drive\/v3\/files\/([^/]+)(\/permissions)?$/); assert.ok(match);
        body = match[2] ? state.permissionPages[match[1]]?.[parsed.searchParams.get('pageToken') || ''] : state.files[match[1]];
      }
      return { getResponseCode: () => state.driveStatus, getContentText: () => typeof body === 'string' ? body : JSON.stringify(body) };
    } },
    LockService: { getScriptLock: () => ({ tryLock: () => state.locked, releaseLock: () => state.releases++ }) },
    SpreadsheetApp: { openById: () => { state.opens++; return book; }, flush: () => {} },
  });
  vm.runInContext(source, context);
  return { state, props, call: payload => JSON.parse(JSON.stringify(context.corchoHandle_({ k: 'synthetic-session', ...payload }))),
    preflight: () => JSON.parse(JSON.stringify(context.corchoPreflight_())) };
}
const data = () => ({ axes: { ejeX: 'Personas', ejeY: 'Pendientes' }, notes: [{ id: 'N-demo', titulo: 'Revisar ejemplo', cuerpo: '=IMPORTXML("example")', ejeX: 'Equipo', ejeY: 'Semana', x: 12, y: 18, color: 'arena', estado: 'activo' }] });
test('Leer un Corcho nuevo no crea ni escribe recursos', () => {
  const f = fixture(), result = f.call({ action: 'corchoGet' });
  assert.equal(result.ok, true); assert.equal(result.version, 0); assert.deepEqual(result.data.notes, []);
  assert.equal(f.state.created, 0); assert.equal(f.state.writes, 0);
});
test('Correo exacto + permiso DP real; ni admin ajeno ni rol enviado por cliente habilitan acceso', () => {
  const f = fixture();
  f.state.identity.correo = 'someone@example.test'; f.state.identity.rol = 'admin';
  assert.equal(f.call({ action: 'corchoGet', correo: 'owner@example.test', rol: 'admin' }).error, 'acceso');
  f.state.identity.correo = 'owner@example.test'; f.state.identity.rol = 'vista'; f.state.identity.boards = 'TA';
  assert.equal(f.call({ action: 'corchoSave', version: 0, data: data(), boards: 'DP' }).error, 'acceso');
  assert.equal(f.state.writes, 0);
});
test('CAS global guarda, rechaza versión vieja y neutraliza texto de fórmulas dentro de JSON', () => {
  const f = fixture();
  assert.equal(f.call({ action: 'corchoSave', data: data() }).error, 'version');
  const result = f.call({ action: 'corchoSave', version: 0, data: data() });
  assert.equal(result.ok, true); assert.equal(result.version, 1); assert.equal(f.state.created, 0);
  assert.ok(f.state.rows[2][2].startsWith('{')); assert.equal(JSON.parse(f.state.rows[2][2]).cuerpo, '=IMPORTXML("example")');
  const conflict = f.call({ action: 'corchoSave', version: 0, data: data() });
  assert.equal(conflict.error, 'conflicto'); assert.equal(conflict.version, 1); assert.equal(f.state.writes, 1);
});
test('Archivar/restaurar conserva ID y fecha de creación; omitir una nota no la borra', () => {
  const f = fixture(), saved = f.call({ action: 'corchoSave', version: 0, data: data() });
  const createdAt = saved.data.notes[0].createdAt;
  const archive = structuredClone(saved.data); archive.notes[0].estado = 'archivado'; archive.notes[0].createdAt = 'spoofed';
  const archived = f.call({ action: 'corchoSave', version: 1, data: archive });
  assert.equal(archived.data.notes[0].createdAt, createdAt);
  const omitted = f.call({ action: 'corchoSave', version: 2, data: { ...archive, notes: [] } });
  assert.equal(omitted.data.notes.length, 1); assert.equal(omitted.data.notes[0].estado, 'archivado');
  const restore = structuredClone(omitted.data); restore.notes[0].estado = 'activo';
  assert.equal(f.call({ action: 'corchoSave', version: 3, data: restore }).data.notes[0].estado, 'activo');
});
test('IDs duplicados, posiciones y payload inválidos se rechazan antes de crear o modificar almacén', () => {
  for (const change of [d => d.notes.push(d.notes[0]), d => d.notes[0].id = '=formula', d => d.notes[0].x = 99, d => d.notes[0].x = '12', d => d.notes[0].cuerpo = 'x'.repeat(12001), d => d.axes.ejeX = '']) {
    const f = fixture(), d = data(); change(d);
    assert.equal(f.call({ action: 'corchoSave', version: 0, data: d }).ok, false);
    assert.equal(f.state.created, 0); assert.equal(f.state.writes, 0);
  }
});
test('Permisos revocados se consultan en cada llamada; lock ocupado no escribe', () => {
  const f = fixture(); assert.equal(f.call({ action: 'corchoGet' }).ok, true);
  f.state.identity.boards = 'TA'; assert.equal(f.call({ action: 'corchoGet' }).error, 'acceso'); assert.equal(f.state.fetches, 2);
  f.state.identity.boards = 'DP'; f.state.locked = false;
  assert.equal(f.call({ action: 'corchoSave', version: 0, data: data() }).error, 'ocupado'); assert.equal(f.state.writes, 0);
});
test('Un almacén corrupto no expone contenido ni se sobrescribe', () => {
  const f = fixture(); f.state.rows = [['unexpected', 'header', 'private-secret']];
  const result = f.call({ action: 'corchoSave', version: 0, data: data() });
  assert.equal(result.error, 'almacen'); assert.ok(!JSON.stringify(result).includes('private-secret')); assert.equal(f.state.writes, 0);
});

test('Preflight y lectura comprueban principal y todos los ancestros sin leer notas ni crear recursos', () => {
  const f = fixture(); assert.deepEqual(f.preflight(), { ok: true });
  assert.equal(f.state.opens, 0); assert.equal(f.state.reads, 0); assert.equal(f.state.writes, 0);
  assert.equal(f.call({ action: 'corchoGet' }).ok, true);
  for (const id of ['synthetic-book', 'private-folder']) {
    const requests = f.state.driveRequests.filter(url => url.pathname === '/drive/v3/files/' + id + '/permissions');
    assert.equal(requests.length, 2);
    assert.ok(requests.every(url => url.searchParams.get('includePermissionsForView') === 'published'));
  }
});

test('Token de ejecución ajeno, email ausente o permissionId distinto no habilitan lectura', () => {
  for (const principal of [{ emailAddress: 'other@example.test', permissionId: 'owner-id' }, { permissionId: 'owner-id' }, { emailAddress: 'owner@example.test', permissionId: 'other-id' }]) {
    const f = fixture(); f.state.principal = principal;
    assert.equal(f.call({ action: 'corchoGet' }).ok, false); assert.equal(f.state.opens, 0); assert.equal(f.state.reads, 0);
  }
  const f = fixture(); f.state.identity.email = f.state.identity.correo; delete f.state.identity.correo;
  assert.equal(f.call({ action: 'corchoGet' }).error, 'acceso'); assert.equal(f.state.driveRequests.length, 0);
});

test('Bloquea permisos anyone/domain/grupo/segundo usuario tanto en archivo como en ancestros', () => {
  for (const id of ['synthetic-book', 'private-folder']) {
    for (const permission of [{ id: 'public', type: 'anyone', role: 'reader', view: 'published' }, { id: 'domain', type: 'domain', role: 'reader' },
      { id: 'group', type: 'group', role: 'reader' }, { id: 'other', type: 'user', role: 'writer', emailAddress: 'other@example.test' },
      { id: 'owner-id', type: 'user', role: 'writer', emailAddress: 'owner@example.test' }]) {
      const f = fixture(); f.state.permissionPages[id][''].permissions.push(permission);
      const result = f.call({ action: 'corchoSave', version: 0, data: data() });
      assert.equal(result.error, 'almacen_no_privado'); assert.equal(f.state.opens, 0); assert.equal(f.state.writes, 0);
    }
  }
});

test('Recorre páginas vacías/intermedias y rechaza exposición oculta en la última página', () => {
  const f = fixture(); const owner = f.state.permissionPages['private-folder'][''].permissions[0];
  f.state.permissionPages['private-folder'] = { '': { permissions: [], nextPageToken: 'second' },
    second: { permissions: [], nextPageToken: 'third' }, third: { permissions: [owner] } };
  assert.deepEqual(f.preflight(), { ok: true });
  f.state.permissionPages['private-folder'].third.permissions.push({ type: 'anyone', role: 'reader' });
  assert.equal(f.call({ action: 'corchoGet' }).error, 'almacen_no_privado'); assert.equal(f.state.opens, 0);
  assert.ok(f.state.driveRequests.some(url => url.searchParams.get('pageToken') === 'third'));
});

test('Falla seguro ante paginación cíclica, permisos incompletos o ancestros inaccesibles/cíclicos', () => {
  for (const change of [
    f => { f.state.permissionPages['synthetic-book'][''].nextPageToken = 'repeat'; f.state.permissionPages['synthetic-book'].repeat = { permissions: [], nextPageToken: 'repeat' }; },
    f => { f.state.permissionPages['synthetic-book'][''] = {}; },
    f => { f.state.permissionPages['synthetic-book'][''].permissions = []; },
    f => { delete f.state.files['private-folder']; },
    f => { f.state.files['private-folder'].parents = ['synthetic-book']; }
  ]) {
    const f = fixture(); change(f);
    assert.equal(f.call({ action: 'corchoGet' }).error, 'privacidad_no_verificada'); assert.equal(f.state.opens, 0);
  }
});

test('Libro/ancestro sharedDrive, propietario adicional/ajeno, papelera o tipo incorrecto fallan cerrados', () => {
  for (const id of ['synthetic-book', 'private-folder']) {
    for (const change of [file => { file.driveId = 'shared-drive'; }, file => { file.owners.push({ emailAddress: 'other@example.test', permissionId: 'other-id' }); },
      file => { file.owners[0].emailAddress = 'other@example.test'; }, file => { file.trashed = true; }, file => { file.ownedByMe = false; },
      file => { file.mimeType = 'application/vnd.google-apps.shortcut'; }]) {
      const f = fixture(); change(f.state.files[id]);
      assert.equal(f.call({ action: 'corchoGet' }).error, 'almacen_no_privado'); assert.equal(f.state.opens, 0);
    }
  }
});

test('Scope/servicio sin autorizar requiere consentimiento explícito; 5xx/JSON inválido nunca usan fallback', () => {
  for (const change of [f => { f.state.tokenFailure = true; }, f => { f.state.driveStatus = 401; }, f => { f.state.driveStatus = 403; }]) {
    const f = fixture(); change(f);
    const result = f.call({ action: 'corchoGet' });
    assert.deepEqual(result, { ok: false, error: 'consentimiento_requerido' }); assert.equal(f.state.opens, 0);
    assert.ok(!JSON.stringify(result).includes('synthetic-private-token'));
  }
  for (const change of [f => { f.state.driveStatus = 503; }, f => { f.state.files['synthetic-book'] = 'private-invalid-json'; }]) {
    const f = fixture(); change(f);
    assert.equal(f.call({ action: 'corchoSave', version: 0, data: data() }).error, 'privacidad_no_verificada'); assert.equal(f.state.writes, 0);
  }
});

test('ACL se verifica de nuevo antes de setValues y bloquea un permiso añadido después de la lectura', () => {
  const f = fixture(); let checks = 0;
  f.state.driveHook = url => {
    if (url.pathname === '/drive/v3/about' && ++checks === 2) f.state.permissionPages['synthetic-book'][''].permissions.push({ type: 'anyone', role: 'reader' });
  };
  assert.equal(f.call({ action: 'corchoSave', version: 0, data: data() }).error, 'almacen_no_privado');
  assert.equal(f.state.reads, 1); assert.equal(f.state.writes, 0); assert.equal(f.state.releases, 1);
});

test('Antes de releer para ACK se verifica el guard; ACL modificada no devuelve contenido ni confirma guardado', () => {
  const f = fixture(); let checks = 0;
  f.state.driveHook = url => {
    if (url.pathname === '/drive/v3/about' && ++checks === 3) f.state.permissionPages['synthetic-book'][''].permissions.push({ type: 'anyone', role: 'reader' });
  };
  const result = f.call({ action: 'corchoSave', version: 0, data: data() });
  assert.deepEqual(result, { ok: false, error: 'almacen_no_privado' });
  assert.equal(f.state.writes, 1); assert.equal(f.state.reads, 1); assert.equal(f.state.releases, 1);
});

test('Infraestructura faltante o sin headers no se crea desde GET ni SAVE', () => {
  for (const rows of [null, [], [['id', 'bad-header', 'payload_json']]]) {
    for (const action of ['corchoGet', 'corchoSave']) {
      const f = fixture(); f.state.rows = rows;
      assert.equal(f.call({ action, version: 0, data: data() }).ok, false); assert.equal(f.state.created, 0); assert.equal(f.state.writes, 0);
    }
  }
});
