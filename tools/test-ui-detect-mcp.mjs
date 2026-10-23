// ui-detect MCP 纯逻辑单测：序号->中心解析、越界/刷新失效。
// 运行: node tools/test-ui-detect-mcp.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const server = require(path.join(here, '..', 'app/src/main/assets/builtin-plugins/dsh-computer-use-android/lib/server.cjs'));

assert.strictEqual(typeof server.resolveClickIndex, 'function', 'server 应导出 resolveClickIndex');

const boxes = [
  { index: 1, cls: 'Icon', cx: 60, cy: 215 },
  { index: 2, cls: 'TextButton', cx: 594, cy: 1549 },
  { index: 3, cls: 'TextButton', cx: 596, cy: 1712 },
];

// 取该序号框中心
assert.deepStrictEqual(server.resolveClickIndex(boxes, 2), { x: 594, y: 1549 });
assert.deepStrictEqual(server.resolveClickIndex(boxes, 3), { x: 596, y: 1712 });

// 越界序号抛 DETECT_STALE（提示重新 detect）；<1 抛 INVALID_index
assert.throws(() => server.resolveClickIndex(boxes, 9), /DETECT_STALE/);
assert.throws(() => server.resolveClickIndex(boxes, 0), /INVALID_index/);

// 新 detect 刷新后，旧序号失效（传新数组即模拟缓存被替换）
const fresh = [{ index: 1, cls: 'TextButton', cx: 10, cy: 10 }];
assert.deepStrictEqual(server.resolveClickIndex(fresh, 1), { x: 10, y: 10 });
assert.throws(() => server.resolveClickIndex(fresh, 3), /DETECT_STALE/);

// android_detect_ui 已注册为工具
assert.ok(server.tools.some((t) => t.name === 'android_detect_ui'), 'tools 应包含 android_detect_ui');
// android_click 的 schema 暴露 index，且不强制 x/y 同时必填
const click = server.tools.find((t) => t.name === 'android_click');
assert.ok(click.inputSchema.properties.index, 'android_click 应有 index 参数');
assert.ok(!click.inputSchema.required.includes('x') && !click.inputSchema.required.includes('y'),
  'android_click 的 x/y 不应同时必填（index 或 x/y 二选一）');

// parseDetectorOutput：坏 JSON / 坏形状 -> DETECT_OUTPUT_INVALID；正常 -> 数组
assert.throws(() => server.parseDetectorOutput('not json'), /DETECT_OUTPUT_INVALID/);
assert.throws(() => server.parseDetectorOutput('[1,2]'), /DETECT_OUTPUT_INVALID/);
assert.throws(() => server.parseDetectorOutput('[{"index":1,"cx":1.5,"cy":2}]'), /DETECT_OUTPUT_INVALID/);
assert.deepStrictEqual(
  server.parseDetectorOutput('[{"index":1,"cls":"TextButton","cx":10,"cy":20}]'),
  [{ index: 1, cls: 'TextButton', cx: 10, cy: 20 }],
);

// ---- 归一化坐标 0-1000 -> 像素（含 clamp 到屏内）----
assert.deepStrictEqual(server.normToPixels([500, 500], 1200, 2670), { x: 600, y: 1335 });
assert.deepStrictEqual(server.normToPixels([0, 1000], 1200, 2670), { x: 0, y: 2669 });
assert.throws(() => server.normToPixels([1001, 500], 1200, 2670), /INVALID_rel/);
assert.throws(() => server.normToPixels([500], 1200, 2670), /INVALID_rel/);
assert.throws(() => server.normToPixels([500, 500], 0, 0), /SCREEN_SIZE_UNKNOWN/); // 未截图不知尺寸

// ---- 动作后验判定（screenshot_exactly_same 反馈）----
assert.strictEqual(server.outcomeNote(null, 'h1', 'h1'), '', '无待结算动作不告警');
assert.strictEqual(server.outcomeNote({ label: 'click' }, null, 'h1'), '', '无上一帧不告警');
assert.strictEqual(server.outcomeNote({ label: 'click(index=3)' }, 'h1', 'h2'), '', '屏幕有变不告警');
assert.match(server.outcomeNote({ label: 'click(index=3)' }, 'h1', 'h1'), /后验.*screenshot_exactly_same/);

// ---- 硬边界（越界拒绝；未知尺寸不拦）----
assert.doesNotThrow(() => server.assertInScreen(100, 100, 1200, 2670));
assert.doesNotThrow(() => server.assertInScreen(1199, 2669, 1200, 2670));
assert.throws(() => server.assertInScreen(1200, 100, 1200, 2670), /OUT_OF_SCREEN/);
assert.throws(() => server.assertInScreen(100, 2670, 1200, 2670), /OUT_OF_SCREEN/);
assert.throws(() => server.assertInScreen(-1, 100, 1200, 2670), /OUT_OF_SCREEN/);
assert.doesNotThrow(() => server.assertInScreen(9999, 9999, 0, 0));

// android_click schema 暴露 rel（0-1000 归一化坐标入口）
assert.ok(click.inputSchema.properties.rel, 'android_click 应有 rel 归一化参数');

console.log('OK resolveClickIndex + parseDetectorOutput + normToPixels + outcomeNote + assertInScreen + tools schema');
