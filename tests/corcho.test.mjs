import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../apps-script/corcho.gs', import.meta.url), 'utf8');
function fixture() {
  const state = { identity: { ok: true, correo: 'owner@example.test', boards: 'DP', rol: 'direccion' }, created: 0, writes: 0, reads: 0, opens: 0,
    rows: [['id', 'version', 'payload_json']], locked: true, releases: 0, fetches: 0, driveRequests: [], driveStatus: 200, tokenFailure: false,
    principal: { emailAddress: 'owner@example.test', permissionId: 'owner-id' }, driveHook: null, permissionPages: {}, files: {},
    remoteStatus: 200, remoteBody: undefined, remoteFailure: false, porteroRequests: [], propertyReads: [], propertyWrites: 0 };
  const ownerFile = id => ({ id, mimeType: 'application/vnd.google-apps.folder', trashed: false, ownedByMe: true,
    owners: [{ emailAddress: 'owner@example.test', permissionId: 'owner-id' }], parents: [] });
  state.files = { 'synthetic-book': { ...ownerFile('synthetic-book'), mimeType: 'application/vnd.google-apps.spreadsheet', parents: ['private-folder'] }, 'private-folder': ownerFile('private-folder') };
  for (const id of Object.keys(state.files)) state.permissionPages[id] = { '': { permissions: [{ id: 'owner-id', type: 'user', role: 'owner', emailAddress: 'owner@example.test' }] } };
  const sheet = { getLastRow: () => state.rows?.length || 0, getRange: (_r, _c, _n, _m) => ({ getValues: () => { state.reads++; return structuredClone(state.rows); }, setValues: rows => { state.writes++; state.rows = structuredClone(rows); } }) };
  const book = { getSheetByName: () => state.rows ? sheet : null, insertSheet: () => { state.created++; return sheet; } };
  const props = { CORCHO_OWNER_EMAIL: 'owner@example.test', CORCHO_SPREADSHEET_ID: 'synthetic-book' };
  const context = vm.createContext({
    PORTERO_EXEC: 'https://portero.example.test/exec',
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => { state.propertyReads.push(key); return props[key]; },
      setProperty: () => { state.propertyWrites++; throw new Error('No escribir propiedades persistidas'); }
    }) },
    ScriptApp: { getOAuthToken: () => { if (state.tokenFailure) throw new Error('synthetic-private-token'); return 'synthetic-token'; } },
    UrlFetchApp: { fetch: (url, options) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'portero.example.test') {
        state.fetches++; state.porteroRequests.push({ url, options: structuredClone(options) });
        if (state.remoteFailure) throw new Error('synthetic-private-remote-error');
        return { getResponseCode: () => state.remoteStatus,
          getContentText: () => state.remoteBody === undefined ? JSON.stringify(state.identity) : state.remoteBody };
      }
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
    SpreadsheetApp: { openById: id => { assert.equal(id, 'synthetic-book'); state.opens++; return book; }, flush: () => {} },
  });
  vm.runInContext(source, context);
  return { state, props, context, call: payload => JSON.parse(JSON.stringify(context.corchoHandle_({ k: 'synthetic-session', ...payload }))),
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

// Doble del límite de Portero V57 indicado por coordinador, no copia de su backend.
function localFixture() {
  const f = fixture();
  Object.assign(f.state, { localCalls: [], fastCalls: 0, renewals: 0, sessionWrites: 0, cacheAccesses: 0,
    session: { key: 'synthetic-session', expiresAt: 4102444800000, revoked: false } });
  f.context.renuevaSesion_ = () => { f.state.renewals++; f.state.sessionWrites++; f.state.session.expiresAt++; };
  f.context.CacheService = { getScriptCache: () => { f.state.cacheAccesses++; return { get: () => null, put: () => {} }; } };
  f.context.canjearLiga_ = () => {
    f.state.fastCalls++; f.context.renuevaSesion_(); f.context.CacheService.getScriptCache().put();
    return structuredClone(f.state.identity);
  };
  f.context.canjearLigaLento_ = (key, board) => {
    f.state.localCalls.push([key, board]);
    if (key !== f.state.session.key || f.state.session.revoked || f.state.session.expiresAt <= Date.now()) return { ok: false, error: 'sesion' };
    return structuredClone(f.state.identity);
  };
  return f;
}
function assertNoAuthWrites(f) {
  assert.equal(f.state.fastCalls, 0); assert.equal(f.state.renewals, 0);
  assert.equal(f.state.sessionWrites, 0); assert.equal(f.state.cacheAccesses, 0); assert.equal(f.state.propertyWrites, 0);
}
function assertNoStorageAccess(f) {
  assert.equal(f.state.driveRequests.length, 0); assert.equal(f.state.opens, 0);
  assert.equal(f.state.reads, 0); assert.equal(f.state.writes, 0); assert.equal(f.state.created, 0);
}

test('Remoto conserva URL de canje sin board, encoding y opciones originales en GET y SAVE', () => {
  const f = fixture(), key = 'session +/?=&:#';
  assert.equal(f.call({ action: 'corchoGet', k: ' ' + key + ' ' }).ok, true);
  assert.equal(f.call({ action: 'corchoSave', k: key, version: 0, data: data() }).ok, true);
  assert.equal(f.state.fetches, 2);
  for (const request of f.state.porteroRequests) {
    assert.equal(request.url, 'https://portero.example.test/exec?recurso=canje&t=' + encodeURIComponent(key));
    assert.deepEqual(request.options, { muteHttpExceptions: true, followRedirects: true });
  }
});

test('Remoto rechaza HTTP fallido, JSON/identidad inválidos y errores sin filtrar contenido ni tocar almacén', () => {
  for (const change of [f => { f.state.remoteStatus = 403; }, f => { f.state.remoteStatus = 503; },
    f => { f.state.remoteBody = 'synthetic-private-invalid-json'; }, f => { f.state.remoteFailure = true; },
    ...[null, [], { ok: 'true', correo: 'owner@example.test', boards: 'DP' }, { ok: false, correo: 'owner@example.test', boards: 'DP' }]
      .map(identity => f => { f.state.identity = identity; })]) {
    const f = fixture(); change(f);
    assert.deepEqual(f.call({ action: 'corchoGet' }), { ok: false, error: 'acceso' });
    assertNoStorageAccess(f);
  }
  const f = fixture(); delete f.context.PORTERO_EXEC;
  assert.equal(f.call({ action: 'corchoGet' }).error, 'acceso'); assert.equal(f.state.fetches, 0); assertNoStorageAccess(f);
});

test('Local prefiere canjearLigaLento_(key, DP) y GET no renueva SESIONES ni escribe caché o propiedades', () => {
  const f = localFixture(), session = structuredClone(f.state.session), props = structuredClone(f.props);
  delete f.context.PORTERO_EXEC;
  for (let i = 0; i < 2; i++) assert.equal(f.call({ action: 'corchoGet', k: ' synthetic-session ' }).ok, true);
  assert.deepEqual(f.state.localCalls, [['synthetic-session', 'DP'], ['synthetic-session', 'DP']]);
  assert.deepEqual(f.state.session, session); assert.deepEqual(f.props, props); assertNoAuthWrites(f);
  assert.equal(f.state.fetches, 0); assert.equal(f.state.writes, 0); assert.equal(f.state.created, 0);
});

test('Local rechaza sesión desconocida, revocada o vencida; no usa HTTP aunque el remoto autorizaría', () => {
  for (const change of [f => { f.state.session.key = 'another-session'; }, f => { f.state.session.revoked = true; },
    f => { f.state.session.expiresAt = 0; }, f => { f.state.identity.ok = false; }]) {
    const f = localFixture(); change(f);
    assert.deepEqual(f.call({ action: 'corchoGet' }), { ok: false, error: 'acceso' });
    assert.deepEqual(f.state.localCalls, [['synthetic-session', 'DP']]);
    assert.equal(f.state.fetches, 0); assertNoStorageAccess(f); assertNoAuthWrites(f);
  }
});

test('Local revalida roster y sesión después de éxito; DP y sesión revocados afectan la siguiente llamada', () => {
  const f = localFixture(); assert.equal(f.call({ action: 'corchoGet' }).ok, true);
  f.state.identity.boards = 'TA';
  assert.equal(f.call({ action: 'corchoSave', version: 0, data: data() }).error, 'acceso');
  f.state.identity.boards = 'DP'; f.state.session.revoked = true;
  assert.equal(f.call({ action: 'corchoGet' }).error, 'acceso');
  assert.equal(f.state.localCalls.length, 3); assert.equal(f.state.reads, 1); assert.equal(f.state.writes, 0);
  assert.equal(f.state.fetches, 0); assertNoAuthWrites(f);
});

test('Local con identidad inválida/excepción o solo canje renovador falla cerrado sin HTTP ni filtraciones', () => {
  for (const identity of [null, [], {}, { ok: 'true', correo: 'owner@example.test', boards: 'DP' },
    { ok: true, email: 'owner@example.test', boards: 'DP' }]) {
    const f = localFixture(); f.state.identity = identity;
    assert.deepEqual(f.call({ action: 'corchoGet' }), { ok: false, error: 'acceso' });
    assert.equal(f.state.fetches, 0); assertNoStorageAccess(f); assertNoAuthWrites(f);
  }
  for (const change of [f => { delete f.context.canjearLigaLento_; },
    f => { f.context.canjearLigaLento_ = () => { throw new Error('synthetic-private-local-error'); }; }]) {
    const f = localFixture(); change(f);
    assert.deepEqual(f.call({ action: 'corchoGet' }), { ok: false, error: 'acceso' });
    assert.equal(f.state.fetches, 0); assertNoStorageAccess(f); assertNoAuthWrites(f);
  }
});

test('Credenciales vacías/cortas/excesivas se rechazan antes del canje tanto local como remoto', () => {
  for (const create of [fixture, localFixture]) {
    for (const k of [undefined, null, '', '   ', 'abc', 'k'.repeat(4097)]) {
      const f = create(); assert.equal(f.call({ action: 'corchoGet', k }).error, 'acceso');
      assert.equal(f.state.fetches, 0); assert.equal(f.state.localCalls?.length || 0, 0); assertNoStorageAccess(f);
    }
  }
});

test('Owner exacto y DP/admin/* mantienen el mismo contrato local/remoto; payload nunca autoriza', () => {
  const identities = [
    [{ boards: 'TA; dp|MK' }, true], [{ boards: ['TA', ' dp '] }, true], [{ boards: 'TA', rol: 'admin' }, true],
    [{ boards: '*' }, true], [{ boards: ['*'] }, true], [{ boards: 'DPP' }, false], [{ boards: 'TA' }, false],
    [{ correo: 'owner@example.test.attacker', boards: 'DP' }, false],
    [{ correo: 'other@example.test', boards: '*', rol: 'admin' }, false],
    [{ correo: ' OWNER@EXAMPLE.TEST ', boards: 'DP' }, true], [{ correo: '', boards: 'DP' }, false],
    [{ ok: false, boards: '*', rol: 'admin' }, false]
  ];
  for (const create of [fixture, localFixture]) {
    for (const [identity, allowed] of identities) {
      const f = create(); Object.assign(f.state.identity, identity);
      assert.equal(f.call({ action: 'corchoGet', correo: 'owner@example.test', boards: 'DP', rol: 'admin' }).ok, allowed);
      assert.equal(f.state.writes, 0); if (!allowed) assertNoStorageAccess(f);
      if (create === localFixture) assertNoAuthWrites(f);
    }
  }
});

test('ScriptProperties prevalece por clave y queda intacto aunque el fallback privado arroje error', () => {
  const f = localFixture(), props = structuredClone(f.props); let fallbackCalls = 0;
  f.context.corchoDeploymentConfig_ = () => { fallbackCalls++; throw new Error('synthetic-private-config'); };
  assert.equal(f.preflight().ok, true); assert.equal(f.call({ action: 'corchoGet' }).ok, true);
  assert.equal(f.call({ action: 'corchoSave', version: 0, data: data() }).ok, true);
  assert.equal(fallbackCalls, 0); assert.deepEqual(f.props, props); assertNoAuthWrites(f);
  assert.ok(f.state.propertyReads.every(key => ['CORCHO_OWNER_EMAIL', 'CORCHO_SPREADSHEET_ID'].includes(key)));
  assert.equal(f.context.corchoProperties_().getProperty('UNRELATED_PRIVATE_PROPERTY'), null);
  assert.ok(!f.state.propertyReads.includes('UNRELATED_PRIVATE_PROPERTY'));
});

test('Fallback privado completa solo claves faltantes y se usa también en preflight y guard de SAVE', () => {
  for (const key of ['CORCHO_OWNER_EMAIL', 'CORCHO_SPREADSHEET_ID']) {
    const f = localFixture(), value = f.props[key]; delete f.props[key];
    const props = structuredClone(f.props);
    f.context.corchoDeploymentConfig_ = () => ({ CORCHO_OWNER_EMAIL: 'other@example.test', CORCHO_SPREADSHEET_ID: 'untrusted-book', [key]: value });
    assert.equal(f.preflight().ok, true); assert.equal(f.call({ action: 'corchoGet' }).ok, true);
    assert.equal(f.call({ action: 'corchoSave', version: 0, data: data() }).ok, true);
    assert.deepEqual(f.props, props); assertNoAuthWrites(f);
  }
  const f = localFixture(), config = structuredClone(f.props); delete f.context.PropertiesService;
  f.context.corchoDeploymentConfig_ = () => config;
  assert.equal(f.preflight().ok, true); assert.equal(f.call({ action: 'corchoGet' }).ok, true);
  assert.equal(f.state.fetches, 0); assertNoAuthWrites(f);
});

test('Configuración ausente y fallback no función fallan cerrado sin defaults, recursos ni acceso a notas', () => {
  for (const create of [fixture, localFixture]) {
    for (const key of ['CORCHO_OWNER_EMAIL', 'CORCHO_SPREADSHEET_ID']) {
      const f = create(); delete f.props[key];
      f.context.corchoDeploymentConfig_ = { CORCHO_OWNER_EMAIL: 'owner@example.test', CORCHO_SPREADSHEET_ID: 'synthetic-book' };
      assert.equal(f.call({ action: 'corchoGet' }).error, key === 'CORCHO_OWNER_EMAIL' ? 'acceso' : 'configuracion');
      assert.deepEqual(f.preflight(), { ok: false, error: 'configuracion' }); assertNoStorageAccess(f);
    }
  }
  const f = localFixture(); delete f.context.PropertiesService;
  assert.equal(f.call({ action: 'corchoGet' }).error, 'acceso');
  assert.deepEqual(f.preflight(), { ok: false, error: 'configuracion' });
  assert.equal(f.state.localCalls.length, 0); assert.equal(f.state.fetches, 0); assertNoStorageAccess(f); assertNoAuthWrites(f);
});

test('Fallback inválido/heredado y errores de propiedades no exponen datos ni permiten degradar protección', () => {
  for (const config of [null, [], 'synthetic-private-config', {},
    Object.create({ CORCHO_OWNER_EMAIL: 'owner@example.test', CORCHO_SPREADSHEET_ID: 'synthetic-book' }),
    { CORCHO_OWNER_EMAIL: 1, CORCHO_SPREADSHEET_ID: 1 }]) {
    const f = localFixture(); delete f.context.PropertiesService; f.context.corchoDeploymentConfig_ = () => config;
    assert.deepEqual(f.call({ action: 'corchoGet' }), { ok: false, error: 'acceso' });
    assert.deepEqual(f.preflight(), { ok: false, error: 'configuracion' }); assertNoStorageAccess(f); assertNoAuthWrites(f);
  }
  for (const change of [f => { delete f.context.PropertiesService; f.context.corchoDeploymentConfig_ = () => { throw new Error('synthetic-private-config'); }; },
    f => { f.context.PropertiesService.getScriptProperties = () => { throw new Error('synthetic-private-service'); }; },
    f => { f.context.PropertiesService.getScriptProperties = () => ({ getProperty: () => { throw new Error('synthetic-private-property'); } }); }]) {
    const f = localFixture(); f.context.corchoDeploymentConfig_ = () => structuredClone(f.props); change(f);
    assert.deepEqual(f.call({ action: 'corchoGet' }), { ok: false, error: 'acceso' });
    assert.deepEqual(f.preflight(), { ok: false, error: 'configuracion' }); assertNoStorageAccess(f); assertNoAuthWrites(f);
  }
});

test('Plantilla documental tiene solo placeholders y no habilita un runtime sin configuración real', () => {
  const f = localFixture(); delete f.context.PropertiesService;
  vm.runInContext(readFileSync(new URL('../apps-script/corcho-deployment-config.gs.example', import.meta.url), 'utf8'), f.context);
  const config = JSON.parse(JSON.stringify(f.context.corchoDeploymentConfig_()));
  assert.deepEqual(config, { CORCHO_OWNER_EMAIL: '<CORCHO_OWNER_EMAIL>', CORCHO_SPREADSHEET_ID: '<CORCHO_SPREADSHEET_ID>' });
  assert.equal(f.call({ action: 'corchoGet' }).error, 'acceso');
  assert.deepEqual(f.preflight(), { ok: false, error: 'configuracion' }); assertNoStorageAccess(f); assertNoAuthWrites(f);
});

test('Snapshot con versiones de nota distintas de @config no se entrega ni se sobrescribe', () => {
  for (const rowVersion of [1, 3, 0, 1.5, 'bad-version']) {
    for (const action of ['corchoGet', 'corchoSave']) {
      const f = localFixture();
      f.state.rows = [['id', 'version', 'payload_json'], ['@config', 2, JSON.stringify(data().axes)], ['N-demo', rowVersion, JSON.stringify(data().notes[0])]];
      const rows = structuredClone(f.state.rows);
      assert.deepEqual(f.call({ action, version: 2, data: data() }), { ok: false, error: 'almacen' });
      assert.deepEqual(f.state.rows, rows); assert.equal(f.state.writes, 0); assert.equal(f.state.releases, 1); assertNoAuthWrites(f);
    }
  }
  const f = localFixture();
  f.state.rows = [['id', 'version', 'payload_json'], ['N-demo', 2, JSON.stringify(data().notes[0])], ['@config', 2, JSON.stringify(data().axes)]];
  assert.equal(f.call({ action: 'corchoGet' }).version, 2);
  assert.equal(f.call({ action: 'corchoSave', version: 2, data: data() }).version, 3);
  assert.ok(f.state.rows.slice(1).every(row => row[1] === 3)); assertNoAuthWrites(f);
});
