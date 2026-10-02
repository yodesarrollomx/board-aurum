import test from 'node:test';
import assert from 'node:assert/strict';
import { sheetFlag, normalizeTask, dataProblems, splitInstructions, conciseTitle, prepareIntake, savePreparedActions } from '../src/task-intake.mjs';

test('Sheet FALSE no oculta tareas; TRUE distingue archivo y papelera', () => {
  for (const value of [false, 'FALSE', 'false', '', 0, null]) assert.equal(sheetFlag(value), false);
  for (const value of [true, 'TRUE', 'true', 1]) assert.equal(sheetFlag(value), true);
  assert.deepEqual(normalizeTask({ id: 'demo', archivada: 'FALSE', borrada: 'TRUE' }), { id: 'demo', archivada: false, borrada: true });
});
test('Los datos por corregir señalan su causa sin cambiar ni cerrar registros', () => {
  const registry = { buscar: name => name === 'Proyecto ejemplo' ? { nombre: name } : null };
  assert.deepEqual(dataProblems({ proyecto: 'Proyecto ejemplo', responsable: 'Equipo', actividad: 'Revisar planos' }, registry), []);
  assert.deepEqual(dataProblems({ proyecto: '', responsable: '', actividad: 'Revisar planos' }, registry), ['Sin proyecto', 'Sin responsable']);
  assert.ok(dataProblems({ proyecto: 'Proyecto ejemplo', responsable: 'Equipo', actividad: 'Integrar todas las tareas internas con su proyecto correcto' }, registry).includes('Corrección del sistema'));
});
test('Desglosa verbos independientes, mantiene condiciones y no divide objetos compuestos', () => {
  assert.deepEqual(splitInstructions('Revisar planos y preparar presupuesto; enviar informe si lo autorizan'), ['Revisar planos', 'preparar presupuesto', 'enviar informe si lo autorizan']);
  assert.deepEqual(splitInstructions('Revisar topografía y suelos'), ['Revisar topografía y suelos']);
  assert.equal(conciseTitle('Por favor ayúdame a revisar planos porque tenemos cambios'), 'revisar planos');
});
test('Asigna únicamente proyectos y objetivos existentes con evidencia clara', () => {
  const tasks = [{ id: 'demo', proyecto: 'Proyecto ejemplo', actividad: 'Preparar presupuesto de construcción' }];
  const moac = { objetivos: [{ objetivo_id: 'O-demo', texto: 'Presupuesto de construcción listo', estado: 'Pendiente' }, { objetivo_id: 'O-closed', texto: 'Preparar informe', estado: 'Cerrado' }], tareas: { demo: { objetivo_id: 'O-demo' } } };
  const source = 'Preparar presupuesto de construcción y enviar informe';
  const plan = prepareIntake(source, { draft: { proyecto: 'Proyecto ejemplo' }, tasks, moac });
  assert.equal(plan.length, 2); assert.equal(plan[0].objetivoId, 'O-demo'); assert.equal(plan[1].objetivoId, '');
  assert.ok(plan.every(a => a.source === source));
  const missing = prepareIntake('Revisar contratos', { tasks, moac });
  assert.equal(missing[0].proyecto, '');
});
test('El fallo de vínculo mantiene ID, muestra parcial y reintenta solo el vínculo', async () => {
  const actions = [{ phase: 'prepared', objetivoId: 'O-demo', id: '' }]; let created = 0; let fail = true;
  const adapters = { create: async () => ({ id: 'T-' + ++created }), link: async () => { if (fail) throw new Error('red'); } };
  await assert.rejects(savePreparedActions(actions, adapters), /red/);
  assert.equal(actions[0].phase, 'link-error'); assert.equal(actions[0].id, 'T-1');
  fail = false; await savePreparedActions(actions, adapters);
  assert.equal(created, 1); assert.equal(actions[0].phase, 'saved');
});
test('Respuesta de creación perdida nunca dispara una segunda creación ciega', async () => {
  const actions = [{ phase: 'prepared', objetivoId: 'O-demo', id: '' }]; let created = 0;
  const adapters = { create: async () => { created++; throw new Error('respuesta perdida'); }, link: async () => {} };
  await assert.rejects(savePreparedActions(actions, adapters));
  assert.equal(actions[0].phase, 'uncertain');
  await assert.rejects(savePreparedActions(actions, adapters), /conciliar/); assert.equal(created, 1);
});
test('Encargo existente conserva su ID; actualización fallida permite reintento idempotente', async () => {
  const actions = [{ phase: 'prepared', objetivoId: 'O-demo', id: '', existingId: 'T-source' }]; let updates = 0; let fail = true;
  const adapters = { create: async a => { updates++; if (fail) throw new Error('update falló'); return { id: a.existingId }; }, link: async () => {} };
  await assert.rejects(savePreparedActions(actions, adapters), /update falló/);
  assert.equal(actions[0].phase, 'update-error');
  fail = false; await savePreparedActions(actions, adapters);
  assert.equal(actions[0].id, 'T-source'); assert.equal(actions[0].phase, 'saved'); assert.equal(updates, 2);
});
