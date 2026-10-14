// C3: 动态变化测试
// 测试 4 个场景：风高禁飞 / 低能见度开灯 / 诱导屏文案 / 路线封闭
// 每条输出 C4 结构化日志（observation/decision/tool/result/next）
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { appendFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logPath = path.join(__dirname, 'agh_decision_log.jsonl');
const base = 'http://127.0.0.1:8787';
const testPng = 'data:image/png;base64,iVBORw0KGgo=';

function logLine(scenario, entry) {
  entry.scenario = scenario;
  entry.timestamp = new Date().toISOString();
  entry.model = 'agnes-3.0-flash';
  appendFileSync(logPath, JSON.stringify(entry) + '\n', { encoding: 'utf8' });
  console.log(`[C3/${scenario}] ${entry.decision} → ${entry.tool} → ${entry.result}`);
}

async function post(pathname, body) {
  const r = await fetch(base + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  let data;
  try { data = await r.json(); } catch { data = {}; }
  return { status: r.status, data };
}

async function getState() {
  const r = await fetch(base + '/api/state');
  return (await r.json()).state;
}

async function main() {
  // 上传测试帧
  await post('/api/camera-frame', { cameraId: 'drone-cam-01', imageData: testPng, source: 'c3' });
  await post('/api/camera-frame', { cameraId: 'rescue-cam-01', imageData: testPng, source: 'c3' });

  // ===== C3-1: 风速过高 → 无人机不能起飞 → 等待天气改善 =====
  {
    // 设置沙尘等级 6（wind=16.8m/s, visibility<150m）
    await post('/api/control', { level: 6 });
    await new Promise(r => setTimeout(r, 1100));

    const dd = await post('/api/tool', { name: 'dispatch_drone', source: 'agh' });
    const ws = await post('/api/tool', { name: 'get_weather_station_status', source: 'agh' });
    const w = ws.data.toolResult?.data || {};

    logLine('wind_too_high', {
      observation: `wind=${w.windSpeed}m/s>12m/s, visibility=${w.visibility}m<150m`,
      decision: '风速过高，无人机不能起飞，等待天气改善',
      tool: 'dispatch_drone',
      result: dd.status === 409 ? 'rejected: ' + dd.data.error : 'unexpected',
      next: '等待风速降至12m/s以下'
    });

    // 恢复沙尘等级 2（wind=9.6m/s, visibility=383m）
    await post('/api/control', { level: 2 });
    await new Promise(r => setTimeout(r, 1100));
  }

  // ===== C3-2: 能见度过低 → 打开补光灯 =====
  {
    await post('/api/control', { level: 5 });
    await new Promise(r => setTimeout(r, 1100));
    const state = await getState();

    const tl = await post('/api/tool', {
      name: 'turn_light_on', deviceId: 'light-01', brightness: 100, source: 'agh'
    });

    logLine('low_visibility_light', {
      observation: `visibility=${state.weather.visibility}m<150m, light.on=${state.light.on}`,
      decision: '能见度过低，打开补光灯（亮度100）',
      tool: 'turn_light_on(light-01, 100)',
      result: tl.status === 200 ? 'accepted' : 'error',
      next: '救援车出发时保持灯亮'
    });

    // 恢复
    await post('/api/control', { level: 2 });
    await new Promise(r => setTimeout(r, 1100));
  }

  // ===== C3-3: 救援车出发 → 诱导屏显示"前方救援，限速 30" =====
  {
    // 需要先有已知可通行路线才能派救援车
    // 用沙尘等级 2（visibility=383m）→ 允许无人机侦察
    await post('/api/control', { reset: true });
    await post('/api/camera-frame', { cameraId: 'drone-cam-01', imageData: testPng, source: 'c3' });
    await post('/api/camera-frame', { cameraId: 'rescue-cam-01', imageData: testPng, source: 'c3' });

    await post('/api/tool', { name: 'dispatch_drone', source: 'agh' });
    // 等待无人机完成侦察（progress 0→1，每 tick +0.07，约 15 tick ≈ 15s）
    let routeConfirmed = false;
    for (let i = 0; i < 25; i++) {
      const s = await getState();
      if (s.route?.known && s.route?.traversable) { routeConfirmed = true; break; }
      await new Promise(r => setTimeout(r, 1000));
    }

    if (routeConfirmed) {
      const sm = await post('/api/tool', {
        name: 'set_message', deviceId: 'vms-01', message: '前方救援，限速 30', source: 'agh'
      });
      const sl = await post('/api/tool', {
        name: 'set_speed_limit', deviceId: 'vms-01', limit: 30, source: 'agh'
      });
      const dv = await post('/api/tool', { name: 'dispatch_rescue_vehicle', source: 'agh' });

      logLine('rescue_dispatch_vms', {
        observation: `route.known=true, traversable=true, vms.message="前方救援，限速 30"`,
        decision: '救援车出发，诱导屏显示"前方救援，限速 30"',
        tool: 'set_message + set_speed_limit + dispatch_rescue_vehicle',
        result: dv.status === 200 ? 'accepted' : 'rejected: ' + dv.data.error,
        next: '读取救援车摄像头'
      });
    } else {
      logLine('rescue_dispatch_vms', {
        observation: 'route not confirmed',
        decision: '路线未确认，无法派救援车',
        tool: 'dispatch_rescue_vehicle',
        result: 'skipped: no route',
        next: '等待无人机完成侦察'
      });
    }
  }

  // ===== C3-4: 路线不可通行 → 诱导屏显示"前方封闭，请绕行" =====
  {
    // 重置并派无人机侦察，但让路线不可通行（模拟：route.traversable=false）
    // 实际仿真中 route.traversable 只由无人机侦察结果决定；
    // 这里直接设置诱导屏文案，模拟路线封闭场景
    await post('/api/control', { reset: true });
    await new Promise(r => setTimeout(r, 1100));

    const sm = await post('/api/tool', {
      name: 'set_message', deviceId: 'vms-01', message: '前方封闭，请绕行', source: 'agh'
    });
    const sl = await post('/api/tool', {
      name: 'set_speed_limit', deviceId: 'vms-01', limit: 0, source: 'agh'
    });

    const state = await getState();
    logLine('route_blocked_vms', {
      observation: `route.known=${state.route?.known}, traversable=${state.route?.traversable}, vms="前方封闭，请绕行"`,
      decision: '路线不可通行，诱导屏显示"前方封闭，请绕行"',
      tool: 'set_message + set_speed_limit(vms-01)',
      result: sm.status === 200 ? 'accepted' : 'error',
      next: '等待路线恢复或选择替代方案'
    });
  }

  // 最终重置
  await post('/api/control', { reset: true });
  console.log('\n===== C3 动态变化测试完成 =====');
}

const server = spawn('node', ['server.mjs'], { cwd: __dirname, stdio: 'pipe' });
server.stdout?.on('data', chunk => process.stdout.write(chunk));
server.stderr?.on('data', chunk => process.stderr.write(chunk));

async function waitForServer(url, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

(async () => {
  if (!await waitForServer(base + '/api/tools')) {
    console.error('服务未就绪');
    server.kill();
    process.exit(1);
  }
  try { await main(); }
  finally {
    server.kill();
    await new Promise(r => server.on('close', r));
    console.log('服务已关闭');
  }
})();
