// Preparación local de encargos: conserva la fuente y usa referencias existentes.
export const sheetFlag = value => value === true || value === 1 || /^(true|si|sí|1)$/i.test(String(value ?? '').trim());
export function normalizeTask(task) {
  return { ...task, archivada: sheetFlag(task.archivada), borrada: sheetFlag(task.borrada) };
}
const norm = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const stop = new Set('para con del las los una uno que por sus este esta como desde antes despues hacer favor quiero necesito ayudame tenemos debemos'.split(' '));
const words = value => [...new Set(norm(value).split(' ').filter(w => w.length > 3 && !stop.has(w)))];
const overlap = (a, b) => words(a).filter(w => words(b).includes(w)).length;
const closedObjective = o => /^(cerrado|cancelado|terminado)$/i.test(String(o.estado || '').trim());

export function dataProblems(task, registry) {
  const issues = [];
  if (!String(task.proyecto || '').trim()) issues.push('Sin proyecto');
  else if (registry?.buscar && !registry.buscar(task.proyecto) && !/^(decisiones|bandeja)$/i.test(task.proyecto.trim())) issues.push('Proyecto sin registro');
  if (!String(task.responsable || '').trim()) issues.push('Sin responsable');
  if (/tareas? (?:internas |del tablero )?(?:mal ligadas|sin resolver)|(?:integrar|clasificar|corregir).*(?:proyecto correcto|tareas internas)/i.test(String(task.actividad || ''))) issues.push('Corrección del sistema');
  return issues;
}

export function splitInstructions(original) {
  const text = String(original || '').trim();
  const verb = '(?:revisar|corregir|preparar|enviar|pedir|generar|actualizar|publicar|cotizar|llamar|confirmar|integrar|registrar|subir|modificar|marcar|coordinar|desglosar|resumir|mapear|ligar|crear|calcular|mostrar|diseñar|migrar|pasar|consultar|separar|programar)';
  return text.split(new RegExp('(?:\\r?\\n|;)+|\\.\\s+(?=[A-ZÁÉÍÓÚ¿])|[, ]+y\\s+(?=' + verb + '\\b)', 'i'))
    .map(s => s.replace(/^\s*(?:[-•]|\d+[.)])\s*/, '').trim()).filter(Boolean);
}

export function conciseTitle(text) {
  const value = String(text).replace(/^(?:(?:por favor|ay[uú]dame a|necesito que|quiero que|tenemos que|hay que|puedes)\s+)+/i, '').replace(/\s+/g, ' ').trim();
  const first = value.split(/\s+(?:porque|para que|ya que)\s+/i)[0];
  if (first.length <= 100) return first;
  return first.slice(0, 97).replace(/\s+\S*$/, '') + '…';
}

export function prepareIntake(original, { draft = {}, tasks = [], moac = null, registry = null } = {}) {
  const source = String(original || '').trim();
  const projects = [...new Set(tasks.map(t => t.proyecto).filter(Boolean))];
  const explicitProject = String(draft.proyecto || '').trim();
  const objectives = (moac?.objetivos || []).filter(o => !closedObjective(o));
  return splitInstructions(source).map((part, index) => {
    const partNorm = ' ' + norm(part) + ' ';
    const matches = projects.filter(p => {
      const registered = registry?.buscar?.(p);
      const aliases = registered ? [registered.nombre, registered.codigo, ...(registered.alias || [])] : [p];
      return aliases.some(a => norm(a).length > 3 && partNorm.includes(' ' + norm(a) + ' '));
    });
    const canonical = [...new Set(matches.map(p => registry?.buscar?.(p)?.nombre || p))];
    const selectedProject = canonical.length === 1 ? (matches.find(p => registry?.buscar?.(p)?.nombre === canonical[0]) || canonical[0]) : canonical.length > 1 ? '' : explicitProject;
    const candidates = objectives.map(o => {
      const examples = tasks.filter(t => moac?.tareas?.[t.id]?.objetivo_id === o.objetivo_id && (!selectedProject || norm(t.proyecto) === norm(selectedProject)));
      const projectExamples = examples.filter(t => selectedProject && norm(t.proyecto) === norm(selectedProject));
      const score = overlap(part, o.texto) * 2 + Math.min(3, Math.max(0, ...examples.map(t => overlap(part, t.actividad)))) + (projectExamples.length ? 1 : 0);
      return { id: o.objetivo_id, score, examples: projectExamples.length };
    }).sort((a, b) => b.score - a.score);
    const top = candidates[0], runner = candidates[1];
    const objective = top && top.score >= 4 && (!runner || top.score - runner.score >= 2) ? top.id : '';
    return { index, actividad: conciseTitle(part), detalle: part, proyecto: selectedProject, objetivoId: objective,
      source, phase: 'prepared', id: '', error: '', reason: !selectedProject ? 'Proyecto por precisar' : !objective ? 'Objetivo por precisar' : 'Referencia a proyecto y objetivo existentes' };
  });
}

// El estado se conserva por acción: una liga fallida no vuelve a crear la tarea.
// Una respuesta de create perdida queda incierta; exige conciliación antes de reintentar.
export async function savePreparedActions(actions, { create, link, onChange = () => {} }) {
  for (const action of actions) {
    if (action.phase === 'saved') continue;
    if (action.phase === 'uncertain') throw new Error('Relee el tablero para conciliar la tarea antes de volver a crearla.');
    try {
      if (!action.id) {
        action.phase = 'creating'; action.error = ''; onChange(action);
        const result = await create(action);
        if (!result?.id) throw new Error('La respuesta no confirmó el identificador de la tarea.');
        action.id = result.id; action.phase = 'created'; onChange(action);
      }
      if (action.objetivoId) {
        action.phase = 'linking'; onChange(action);
        await link(action.id, action.objetivoId);
      }
      action.phase = 'saved'; action.error = ''; onChange(action);
    } catch (error) {
      action.error = error.message || String(error);
      action.phase = action.id ? 'link-error' : action.existingId ? 'update-error' : 'uncertain'; onChange(action);
      throw error;
    }
  }
  return actions;
}
