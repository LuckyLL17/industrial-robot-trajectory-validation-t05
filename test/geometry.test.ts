import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentHitsBox } from '../src/index.ts';

// 测试用盒：中心 (0,0,0)，半边长 1
const box = { center: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 2, z: 2 } };
const P = (x: number, y: number, z = 0) => ({ x, y, z });

test('线段横穿盒体：端点在盒外、中段穿过，必须命中', () => {
  // y=0.5 水平线，从 x=-2 到 2：两端在盒外，x∈(-1,1) 的中段在盒内
  assert.equal(segmentHitsBox(P(-2, 0.5), P(2, 0.5), box).hit, true);
  // y=x 对角线穿过盒内（(-1,-1) 入、(1,1) 出）
  assert.equal(segmentHitsBox(P(-2, -2), P(2, 2), box).hit, true);
});

test('线段两端及采样点都不在盒内，但中段穿过盒体（采样法必漏场景）', () => {
  // 盒在 x∈[290,710], y∈[-180,180]（fixture 尺寸），线段从 (0,-100) 到 (1000,500)
  const fixture = { center: { x: 500, y: 0, z: 300 }, size: { x: 420, y: 360, z: 300 } };
  const a = { x: 0, y: -100, z: 300 };
  const b = { x: 1000, y: 500, z: 300 };
  const hit = segmentHitsBox(a, b, fixture);
  assert.equal(hit.hit, true);
  if (hit.hit) {
    assert.ok(hit.tEnter >= 0 && hit.tEnter <= 1);
    assert.ok(hit.tExit >= hit.tEnter && hit.tExit <= 1);
    // 进入点应落在边界上
    const ex = a.x + (b.x - a.x) * hit.tEnter;
    const ey = a.y + (b.y - a.y) * hit.tEnter;
    assert.ok(
      Math.abs(ex - 290) < 1e-6 || Math.abs(ex - 710) < 1e-6 ||
      Math.abs(ey + 180) < 1e-6 || Math.abs(ey - 180) < 1e-6
    );
  }
});

test('完全避开：线段从盒旁经过且有间隙', () => {
  assert.equal(segmentHitsBox(P(-2, 1.5), P(2, 1.5), box).hit, false);
  assert.equal(segmentHitsBox(P(-2, -2), P(-1.5, 2), box).hit, false);
  // 角附近掠过但不接触：y = -x + 2.01 与盒最近距离 > 0
  assert.equal(segmentHitsBox(P(-2, 4.01), P(2, 0.01), box).hit, false);
});

test('刚好接触边界（闭盒语义）：面接触（垂直擦边）判命中', () => {
  // 线段沿 x 方向，y 恰为盒面 y=1，z=0：贴合盒面一段，属于接触
  const r = segmentHitsBox(P(-2, 1), P(2, 1), box);
  assert.equal(r.hit, true);
  if (r.hit) {
    assert.ok(Math.abs(r.tEnter - 0.25) < 1e-9);
    assert.ok(Math.abs(r.tExit - 0.75) < 1e-9);
  }
});

test('刚好接触边界：单点擦角判命中', () => {
  // y = -x + 2，线段经过盒角 (1,1)
  const r = segmentHitsBox(P(0, 2), P(2, 0), box);
  assert.equal(r.hit, true);
  if (r.hit) assert.ok(Math.abs(r.tEnter - r.tExit) < 1e-9);
});

test('刚好接触边界：端点停在盒面上判命中', () => {
  assert.equal(segmentHitsBox(P(1, 0), P(2, 0), box).hit, true);
  assert.equal(segmentHitsBox(P(-2, 0), P(-1, 1), box).hit, true);
});

test('近似接触的浮点容差：偏离面 1e-12 不产生假阴性', () => {
  assert.equal(segmentHitsBox(P(-2, 1 + 1e-12), P(2, 1 + 1e-12), box).hit, true);
});

test('间隙 1mm（0.001 盒单位）应明确不命中，不能用大 epsilon 吞掉真实间隙', () => {
  assert.equal(segmentHitsBox(P(-2, 1.001), P(2, 1.001), box).hit, false);
});

test('线段与某轴 slab 平行：落在 slab 外不命中，落在 slab 内按其余两轴判定', () => {
  assert.equal(segmentHitsBox(P(0, 0, 5), P(1, 1, 5), box).hit, false);
  assert.equal(segmentHitsBox(P(-2, 0, 0), P(2, 0, 0), box).hit, true);
});

test('端点在盒内 / 整段在盒内', () => {
  assert.equal(segmentHitsBox(P(0, 0, 0), P(2, 0, 0), box).hit, true);
  assert.equal(segmentHitsBox(P(-0.5, -0.5, 0), P(0.5, 0.5, 0), box).hit, true);
});

test('多个互不相交盒：逐盒独立判定，命中正确的盒', () => {
  const small = { center: { x: 5, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } };
  assert.equal(segmentHitsBox(P(0, 0, 0), P(2, 0, 0), small).hit, false);
  assert.equal(segmentHitsBox(P(4, 0, 0), P(6, 0, 0), small).hit, true);
});
