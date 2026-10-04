import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  app, paths, validations, plans, executions, audit, dynamicObstacles, safetyReleases,
} from '../src/index.ts';

const W = (x: number, y: number, z: number, extra: Record<string, number> = {}) => ({
  x, y, z, rx: 0, ry: 0, rz: 0, speed: 100, blend: 10, ...extra,
});
const basePath = (waypoints: any[], name = 't') => ({
  name, cellId: 'cell-01', robotId: 'robot-01', toolId: 'gun-01', waypoints,
});
const inject = (opts: Parameters<typeof app.inject>[0]) => app.inject(opts);

beforeEach(() => {
  paths.length = 0;
  validations.length = 0;
  plans.length = 0;
  executions.length = 0;
  audit.length = 0;
  dynamicObstacles.length = 0;
  safetyReleases.length = 0;
});

async function createAndValidate(waypoints: any[], name = 't') {
  const c = await inject({ method: 'POST', url: '/api/paths', payload: basePath(waypoints, name) });
  assert.equal(c.statusCode, 200);
  const path = c.json();
  const v = await inject({ method: 'POST', url: `/api/paths/${path.id}/validate` });
  return { path, validation: v.json(), statusCode: v.statusCode };
}

test('回归：(0,-100,300)→(1000,500,300) 穿过 fixture，必须阻断并定位到 fixture/段0', async () => {
  const { path, validation } = await createAndValidate([W(0, -100, 300), W(1000, 500, 300)], 'through');
  assert.equal(validation.statusCode ?? 200, 200);
  assert.equal(validation.valid, false);
  const ids = validation.errors.map((e: any) => e.obstacleId);
  assert.ok(ids.includes('fixture'), 'fixture 必须被精确几何检测报出');
  const fixtureError = validation.errors.find((e: any) => e.obstacleId === 'fixture');
  assert.deepEqual(
    { type: fixtureError.type, segment: fixtureError.segment, clearance: fixtureError.clearance },
    { type: 'collision', segment: 0, clearance: 0 },
  );
  // 长度/速度/时间/奇异风险语义保持
  assert.equal(validation.length, 1166.19);
  assert.equal(validation.maxSpeed, 100);
  assert.equal(validation.estimatedSeconds, 11.66);
  assert.equal(validation.singularityRisk, 0);
  // 错误回流到路径状态（创建响应是 draft 快照，以 store 最新状态为准）
  const stored = paths.find((p: any) => p.id === path.id);
  assert.equal(stored.status, 'blocked');
  assert.equal(stored.lastValidationId, validation.id);
});

test('多障碍：同一线段同时穿过 fence 与 fixture，两个障碍分别报出', async () => {
  const { validation } = await createAndValidate([W(0, -100, 300), W(1000, 500, 300)], 'multi');
  const collisionErrors = validation.errors.filter((e: any) => e.type === 'collision');
  assert.equal(collisionErrors.length, 2);
  assert.deepEqual(collisionErrors.map((e: any) => e.obstacleId).sort(), ['fence', 'fixture']);
  assert.ok(collisionErrors.every((e: any) => e.segment === 0));
});

test('完全避开：盒外绕行的路径仍为 valid，且度量正确', async () => {
  // x=-1000 竖直线段：两点都在 fence 盒外、可达范围内，也不碰 fixture
  const { path, validation } = await createAndValidate([W(-1000, -300, 0), W(-1000, 300, 0)], 'clear');
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.length, 600);
  assert.equal(validation.maxSpeed, 100);
  assert.equal(validation.estimatedSeconds, 6);
  assert.equal(validation.singularityRisk, 2); // 两点 |z|<80
  assert.equal(paths.find((p: any) => p.id === path.id).status, 'validated');
});

test('刚好接触边界：线段仅擦过 fence 盒角（端点和中点都在盒外）也必须阻断', async () => {
  // 切点 (900,900,300) 位于参数 t=0.3；两端与中点均在 fence 外，旧的端点+中点采样会漏检
  const { validation } = await createAndValidate([W(870, 930, 300), W(970, 830, 300)], 'tangent');
  assert.equal(validation.valid, false);
  const collision = validation.errors.filter((e: any) => e.type === 'collision');
  assert.equal(collision.length, 1);
  assert.equal(collision[0].obstacleId, 'fence');
  assert.equal(collision[0].segment, 0);
});

test('重复验证：历史逐条累积（id 不同），状态随最近结果更新，审计完整', async () => {
  const blocked = await createAndValidate([W(0, -100, 300), W(1000, 500, 300)], 'repeat-blocked');
  const blockedPathId = blocked.path.id;
  await inject({ method: 'POST', url: `/api/paths/${blockedPathId}/validate` });
  assert.equal(validations.filter((v: any) => v.pathId === blockedPathId).length, 2);
  const ids = validations.filter((v: any) => v.pathId === blockedPathId).map((v: any) => v.id);
  assert.equal(new Set(ids).size, 2, '两次验证必须生成不同记录');
  assert.equal(audit.filter((a: any) => a.action === 'path.validate').length, 2);
  assert.equal(paths.find((p: any) => p.id === blockedPathId).status, 'blocked');

  const clear = await createAndValidate([W(-1000, -300, 0), W(-1000, 300, 0)], 'repeat-ok');
  assert.equal(paths.find((p: any) => p.id === clear.path.id).status, 'validated');
  assert.equal(clear.validation.valid, true);
});

test('错误回流：blocked 路径禁止规划、执行、发布', async () => {
  const { path } = await createAndValidate([W(0, -100, 300), W(1000, 500, 300)], 'gate-blocked');
  const plan = await inject({ method: 'POST', url: `/api/paths/${path.id}/plan`, payload: {} });
  assert.equal(plan.statusCode, 409);
  assert.equal(plans.length, 0);

  const exec = await inject({ method: 'POST', url: '/api/executions', payload: { pathId: path.id } });
  assert.equal(exec.statusCode, 409);
  assert.equal(executions.length, 0);

  const release = await inject({ method: 'POST', url: `/api/paths/${path.id}/release`, payload: {} });
  assert.equal(release.statusCode, 200);
  assert.equal(release.json().status, 'blocked');
  assert.ok(release.json().gate.failures.includes('collision-validation'));
  assert.equal(safetyReleases.length, 1);
  assert.equal(paths.find((p: any) => p.id === path.id).status, 'blocked', '发布失败不得改状态');
});

test('通过验证的路径可规划、执行、发布；动态障碍出现时发布被额外门禁阻断，清除后恢复', async () => {
  const { path } = await createAndValidate([W(-1000, -300, 0), W(-1000, 300, 0)], 'gate-ok');

  const plan = await inject({ method: 'POST', url: `/api/paths/${path.id}/plan`, payload: {} });
  assert.equal(plan.statusCode, 200);
  assert.equal(plan.json().status, 'planned');

  const exec = await inject({ method: 'POST', url: '/api/executions', payload: { pathId: path.id } });
  assert.equal(exec.statusCode, 200);
  assert.equal(exec.json().status, 'completed');

  const obstacle = await inject({
    method: 'POST', url: '/api/dynamic-obstacles',
    payload: { cellId: 'cell-01', center: { x: -1000, y: 0, z: 0 }, size: { x: 10, y: 10, z: 10 } },
  });
  assert.equal(obstacle.statusCode, 200);
  const blockedRelease = await inject({ method: 'POST', url: `/api/paths/${path.id}/release`, payload: {} });
  assert.equal(blockedRelease.json().status, 'blocked');
  assert.deepEqual(blockedRelease.json().gate.failures, ['dynamic-obstacle-present']);
  assert.equal(paths.find((p: any) => p.id === path.id).status, 'validated');

  await inject({ method: 'POST', url: `/api/dynamic-obstacles/${obstacle.json().id}/clear` });
  const release = await inject({ method: 'POST', url: `/api/paths/${path.id}/release`, payload: {} });
  assert.equal(release.json().status, 'released');
  assert.equal(paths.find((p: any) => p.id === path.id).status, 'released');
});

test('优化接口：碰撞路径的所有缩放候选都被过滤，best 为 null', async () => {
  const { path } = await createAndValidate([W(0, -100, 300), W(1000, 500, 300)], 'opt-blocked');
  const res = await inject({ method: 'POST', url: `/api/paths/${path.id}/optimize` });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().candidates, []);
  assert.equal(res.json().best, null);
});

test('未验证路径不能规划/执行/发布（保持既有门禁）', async () => {
  const c = await inject({
    method: 'POST', url: '/api/paths',
    payload: basePath([W(-1000, -300, 0), W(-1000, 300, 0)], 'fresh'),
  });
  const path = c.json();
  assert.equal((await inject({ method: 'POST', url: `/api/paths/${path.id}/plan`, payload: {} })).statusCode, 409);
  assert.equal((await inject({ method: 'POST', url: '/api/executions', payload: { pathId: path.id } })).statusCode, 409);
  const release = await inject({ method: 'POST', url: `/api/paths/${path.id}/release`, payload: {} });
  assert.equal(release.json().gate.failures.includes('collision-validation'), true);
});

test('多段路径逐段检测：碰撞段被精确定位（segment 索引）', async () => {
  const { validation } = await createAndValidate(
    [W(-1000, -300, 0), W(-1000, 300, 0), W(0, -100, 300), W(1000, 500, 300)],
    'segments',
  );
  assert.equal(validation.valid, false);
  // 段0 安全；段1(-1000,300,0)->(0,-100,300) 不穿 fixture；段2 穿过 fixture
  const fixtureError = validation.errors.find((e: any) => e.obstacleId === 'fixture');
  assert.ok(fixtureError);
  assert.equal(fixtureError.segment, 2);
});
