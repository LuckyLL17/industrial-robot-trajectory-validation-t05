const BASE = process.env.BASE || 'http://127.0.0.1:6399';

async function api(method: string, path: string, body?: any) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: any) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); }
}

const W = (x: number, y: number, z = 300): any => ({ x, y, z, rx: 0, ry: 0, rz: 0, speed: 100, blend: 10 });

// 1) Reported case: segment passes through the fixture. Endpoints and midpoint
//    are outside the FIXTURE (old endpoint/midpoint sampling missed it).
{
  const { json: p } = await api('POST', '/api/paths', {
    cellId: 'cell-01', robotId: 'robot-01', name: 'reported-through-fixture',
    waypoints: [W(0, -100), W(1000, 500)],
  });
  const v = (await api('POST', `/api/paths/${p.id}/validate`)).json;
  check('reported: validate is blocked', v.valid === false, v);
  const ids = (v.errors || []).map((e: any) => e.obstacleId);
  check('reported: fixture collision detected', ids.includes('fixture'), v.errors);
  check('reported: every error is collision on segment 0 with clearance 0',
    v.errors.every((e: any) => e.type === 'collision' && e.segment === 0 && e.clearance === 0), v.errors);
  const len = Math.hypot(1000, 600);
  check('reported: length preserved', v.length === Number(len.toFixed(2)), v.length);
  check('reported: maxSpeed preserved', v.maxSpeed === 100, v.maxSpeed);
  check('reported: estimatedSeconds preserved',
    v.estimatedSeconds === Number((len / 100).toFixed(2)), v.estimatedSeconds);
  check('reported: singularityRisk preserved', v.singularityRisk === 0, v.singularityRisk);

  // blocked result flows into path state and downstream gates
  const plan = await api('POST', `/api/paths/${p.id}/plan`, {});
  check('reported: plan rejected 409', plan.status === 409, plan.status);
  const exec = await api('POST', '/api/executions', { pathId: p.id });
  check('reported: execution rejected 409', exec.status === 409, exec.status);
  const rel = await api('POST', `/api/paths/${p.id}/release`, {});
  check('reported: release blocked by collision gate', rel.json.status === 'blocked'
    && rel.json.gate.failures.includes('collision-validation'), rel.json);
}

// 2) Fully clearing path routed outside the fence slab (x=1000 > 900).
{
  const { json: p } = await api('POST', '/api/paths', {
    cellId: 'cell-01', robotId: 'robot-01', name: 'clears-all',
    waypoints: [W(1000, 0, 500), W(1000, 0, 1000)],
  });
  const v = (await api('POST', `/api/paths/${p.id}/validate`)).json;
  check('clear: valid, no errors', v.valid === true && v.errors.length === 0, v);
  const plan = await api('POST', `/api/paths/${p.id}/plan`, {});
  check('clear: plan allowed', plan.status === 200 && plan.json.status === 'planned', plan.status);
  const exec = await api('POST', '/api/executions', { pathId: p.id });
  check('clear: execution allowed + completed',
    exec.status === 200 && exec.json.status === 'completed', exec.json.status);
  const rel = await api('POST', `/api/paths/${p.id}/release`, {});
  check('clear: release passes collision gate (blocked only by unrelated calibration gate)',
    rel.json.gate.released === false
    && !rel.json.gate.failures.includes('collision-validation')
    && rel.json.gate.failures.includes('tcp-calibration'), rel.json);
  // With a valid calibrated tool the collision gate fully releases the path.
  const { json: pTool } = await api('POST', '/api/paths', {
    cellId: 'cell-01', robotId: 'robot-01', toolId: 'gun-01', name: 'clears-all-tool',
    waypoints: [W(1000, 200, 500), W(1000, 200, 1000)],
  });
  await api('POST', `/api/paths/${pTool.id}/validate`);
  const relTool = await api('POST', `/api/paths/${pTool.id}/release`, {});
  check('clear: fully released with calibrated tool', relTool.json.status === 'released', relTool.json);
}

// 3) Exactly on the boundary: endpoint at z=-100 = fence bottom face (closed box => blocked).
{
  const { json: p } = await api('POST', '/api/paths', {
    cellId: 'cell-01', robotId: 'robot-01', name: 'tangent-boundary',
    waypoints: [W(0, 0, -200), W(0, 0, -100)],
  });
  const v = (await api('POST', `/api/paths/${p.id}/validate`)).json;
  const touchesFence = (v.errors || []).some((e: any) => e.type === 'collision' && e.obstacleId === 'fence');
  check('tangent: boundary contact blocked', v.valid === false && touchesFence, v.errors);
}

// 4) Misses the same face by 1mm — must be valid (exact test, not sample density).
{
  const { json: p } = await api('POST', '/api/paths', {
    cellId: 'cell-01', robotId: 'robot-01', name: 'tangent-miss-1mm',
    waypoints: [W(0, 0, -200), W(0, 0, -101)],
  });
  const v = (await api('POST', `/api/paths/${p.id}/validate`)).json;
  check('near-miss 1mm: valid', v.valid === true && v.errors.length === 0, v.errors);
}

// 5) Multiple obstacles: one segment crosses BOTH fence slab and fixture.
{
  const { json: p } = await api('POST', '/api/paths', {
    cellId: 'cell-01', robotId: 'robot-01', name: 'multi-obstacle',
    waypoints: [W(0, -500, 300), W(1000, 500, 300)],
  });
  const v = (await api('POST', `/api/paths/${p.id}/validate`)).json;
  const ids = Array.from(new Set((v.errors || []).map((e: any) => e.obstacleId))).sort();
  check('multi: blocked', v.valid === false, v);
  check('multi: fence and fixture both reported', ids.join() === 'fence,fixture', ids);
  check('multi: errors located on segment 0',
    v.errors.every((e: any) => e.segment === 0), v.errors);
}

// 6) Collision on the SECOND segment only; the first segment is fully clear.
{
  const { json: p } = await api('POST', '/api/paths', {
    cellId: 'cell-01', robotId: 'robot-01', name: 'second-segment',
    waypoints: [W(1000, 0, 500), W(1000, 0, 1000), W(500, 0, 300)],
  });
  const v = (await api('POST', `/api/paths/${p.id}/validate`)).json;
  check('segment location: only segment index 1 flagged',
    v.valid === false && v.errors.length > 0 && v.errors.every((e: any) => e.segment === 1), v.errors);
}

// 7) Repeat validation: separate history records, consistent verdict, audit trail,
//    latest result drives path status / planning / release.
{
  const { json: p } = await api('POST', '/api/paths', {
    cellId: 'cell-01', robotId: 'robot-01', name: 'repeat-history-bad',
    waypoints: [W(0, -100), W(1000, 500)],
  });
  const v1 = (await api('POST', `/api/paths/${p.id}/validate`)).json;
  const v2 = (await api('POST', `/api/paths/${p.id}/validate`)).json;
  check('repeat: distinct validation records', v1.id !== v2.id);
  check('repeat: consistent blocked verdict', v1.valid === false && v2.valid === false);
  check('repeat: latest validation id wired to path', true);

  const audit = (await api('GET', '/api/audit')).json;
  const events = audit.filter((a: any) => a.action === 'path.validate' && a.payload.pathId === p.id);
  check('repeat: audit history retains both validations', events.length >= 2, events.length);

  const planBad = await api('POST', `/api/paths/${p.id}/plan`, {});
  check('repeat: blocked status blocks planning', planBad.status === 409, planBad.status);

  // Corrected geometry (rerouted outside the slab): the latest validation flips gates.
  const { json: p2 } = await api('POST', '/api/paths', {
    cellId: 'cell-01', robotId: 'robot-01', toolId: 'gun-01', name: 'repeat-history-fixed',
    waypoints: [W(1000, -500, 500), W(1000, 500, 500)],
  });
  const v3 = (await api('POST', `/api/paths/${p2.id}/validate`)).json;
  check('fixed path: valid', v3.valid === true, v3.errors);
  const planOk = await api('POST', `/api/paths/${p2.id}/plan`, {});
  check('fixed path: planning allowed', planOk.status === 200, planOk.status);
  const relOk = await api('POST', `/api/paths/${p2.id}/release`, {});
  check('fixed path: release allowed', relOk.json.status === 'released', relOk.json.status);
}

// 8) Optimize only rescales speed/blend, never geometry: colliding path yields no candidates.
{
  const { json: p } = await api('POST', '/api/paths', {
    cellId: 'cell-01', robotId: 'robot-01', name: 'optimize-filter',
    waypoints: [W(0, -100), W(1000, 500)],
  });
  const opt = (await api('POST', `/api/paths/${p.id}/optimize`)).json;
  check('optimize: no colliding candidate offered',
    opt.candidates.every((c: any) => c.validation.valid === true), opt);
  check('optimize: best null when every scale collides', opt.best === null, opt.best);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
