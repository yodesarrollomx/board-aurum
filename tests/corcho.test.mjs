import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../apps-script/corcho.gs', import.meta.url), 'utf8');
function fixture() {
  const state = { identity: { ok: true, correo: 'owner@example.test', boards: 'DP', rol: 'direccion' }, created: 0, writes: 0, rows: null, locked: true, releases: 0, fetches: 0 };
  const sheet = { getLastRow: () => state.rows?.length || 0, getRange: (_r, _c, _n, _m) => ({ getValues: () => structuredClone(state.rows), setValues: rows => { state.writes++; state.rows = structuredClone(rows); } }) };
  const book = { getSheetByName: () => state.rows ? sheet : null, insertSheet: () => { state.created++; return sheet; } };
  const props = { CORCHO_OWNER_EMAIL: 'owner@example.test', CORCHO_SPREADSHEET_ID: 'synthetic-book' };
  const context = vm.createContext({
    PORTERO_EXEC: 'https://portero.example.test/exec',
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => props[key] }) },
    UrlFetchApp: { fetch: () => { state.fetches++; return { getResponseCode: () => 200, getContentText: () => JSON.stringify(state.identity) }; } },
    LockService: { getScriptLock: () => ({ tryLock: () => state.locked, releaseLock: () => state.releases++ }) },
    SpreadsheetApp: { openById: () => book, flush: () => {} },
  });
  vm.runInContext(source, context);
  return { state, props, call: payload => JSON.parse(JSON.stringify(context.corchoHandle_({ k: 'synthetic-session', ...payload }))) };
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
  assert.equal(result.ok, true); assert.equal(result.version, 1); assert.equal(f.state.created, 1);
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
