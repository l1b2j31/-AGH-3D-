// C2 + C4: AGH 决策链脚本
// 按 C2 规定顺序执行 12 步，每步输出 C4 结构化日志（observation/decision/tool/result/next）
// 写入 agh_decision_log.jsonl
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { appendFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logPath = path.join(__dirname, 'agh_decision_log.jsonl');
const base = 'http://127.0.0.1:8787';
const testPng = 'data:image/png;base64,iVBORw0KGgo=';
const decisions = [];
let seq = 0;

function logLine(entry) {
  entry.timestamp = new Date().toISOString();
  entry.seq = ++seq;
  decisions.push(entry);
  appendFileSync(logPath, JSON.stringify(entry) + '\n', { encoding: 'utf8' });
  console.log(`[C4 #${entry.seq}] ${entry.decision} → ${entry.tool} → ${entry.result} → next: ${entry.next}`);
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

function fmtResult(r) {
  if (r.status === 200) return 'accepted';
  if (r.status === 409) return 'rejected: ' + (r.data.error || '409');
  return 'error: HTTP ' + r.status;
}

async function main() {
  // 上传两个测试帧，确保 get_camera_frame 可用
  await post('/api/camera-frame', { cameraId: 'drone-cam-01', imageData: testPng, source: 'c2-test' });
  await post('/api/camera-frame', { cameraId: 'rescue-cam-01', imageData: testPng, source: 'c2-test' });

  // 1. 读取气象站状态
  const ws = (await post('/api/tool', { name: 'get_weather_station_status', source: 'agh' }));
  const w = ws.data.toolResult?.data || {};
  logLine({
    observation: `visibility=${w.visibility}m, wind=${w.windSpeed}m/s, level=${w.sandstormLevel}`,
    decision: '读取气象站状态',
    tool: 'get_weather_station_status',
    result: fmtResult(ws),
    next: '读取车辆状态'
  });

  // 2. 读取车辆状态
  const vs = (await post('/api/tool', { name: 'get_vehicle_status', source: 'agh' }));
  const v = vs.data.toolResult?.data || {};
  const canSelfRecover = !v.stuck || v.status !== 'stuck';
  logLine({
    observation: `stuck=${v.stuck}, status=${v.status}, fuel=${v.fuel}%`,
    decision: v.stuck ? '车辆被困，尝试自救' : '车辆未被困，无需自救',
    tool: 'get_vehicle_status',
    result: fmtResult(vs),
    next: canSelfRecover ? '判断是否能自救' : '停止车辆'
  });

  // 3. 判断车辆能否自救
  if (v.stuck && w.visibility >= 150) {
    const sr = await post('/api/tool', { name: 'attempt_self_recovery', source: 'agh' });
    logLine({
      observation: `stuck=true, visibility=${w.visibility}m≥150m`,
      decision: '允许自救',
      tool: 'attempt_self_recovery',
      result: fmtResult(sr),
      next: '等待自救结果'
    });
  } else {
    logLine({
      observation: `stuck=${v.stuck}, visibility=${w.visibility}m`,
      decision: v.stuck ? '能见度<150m，禁止自救' : '无需自救',
      tool: 'attempt_self_recovery',
      result: 'skipped: ' + (v.stuck ? 'visibility<150m' : 'not stuck'),
      next: '停止车辆'
    });
  }

  // 4. 必要时停止车辆
  if (v.status === 'recovering' || v.status === 'stuck') {
    const sv = await post('/api/tool', { name: 'stop_vehicle', source: 'agh' });
    logLine({
      observation: `vehicle.status=${v.status}`,
      decision: '停止车辆',
      tool: 'stop_vehicle',
      result: fmtResult(sv),
      next: '判断无人机是否允许起飞'
    });
  }

  // 5. 读取无人机状态
  const dr = (await post('/api/tool', { name: 'get_drone_status', source: 'agh' }));
  const d = dr.data.toolResult?.data || {};
  logLine({
    observation: `drone.battery=${d.battery}%, status=${d.status}`,
    decision: '读取无人机状态',
    tool: 'get_drone_status',
    result: fmtResult(dr),
    next: '判断是否允许起飞'
  });

  // 6. 判断无人机是否允许起飞
  const canFly = w.windSpeed <= 12 && w.visibility >= 150 && d.battery >= 20;
  if (canFly) {
    // 7. 派遣无人机
    const dd = await post('/api/tool', { name: 'dispatch_drone', source: 'agh' });
    logLine({
      observation: `wind=${w.windSpeed}m/s≤12, visibility=${w.visibility}m≥150, battery=${d.battery}%≥20`,
      decision: '允许无人机侦察',
      tool: 'dispatch_drone',
      result: fmtResult(dd),
      next: '读取无人机摄像头'
    });
  } else {
    logLine({
      observation: `wind=${w.windSpeed}m/s, visibility=${w.visibility}m, battery=${d.battery}%`,
      decision: '不允许无人机起飞',
      tool: 'dispatch_drone',
      result: 'rejected: ' + (!canFly ? (w.windSpeed > 12 ? 'wind>12m/s' : 'visibility<150m') : 'battery<20%'),
      next: '等待天气改善'
    });
  }

  // 8. 读取无人机摄像头
  const cam1 = await post('/api/tool', { name: 'get_camera_frame', cameraId: 'drone-cam-01', source: 'agh' });
  logLine({
    observation: `drone-cam-01: ${cam1.data.toolResult?.data?.mimeType || 'no frame'}`,
    decision: '读取无人机摄像头',
    tool: 'get_camera_frame(drone-cam-01)',
    result: fmtResult(cam1),
    next: '确认备用路线'
  });

  // 9. 确认备用路线（等待无人机完成侦察）
  let route = null;
  for (let i = 0; i < 40; i++) {
    const s = (await fetch(base + '/api/state')).json();
    route = s.state?.route;
    if (route?.known && route?.traversable) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  logLine({
    observation: `route.known=${route?.known}, traversable=${route?.traversable}`,
    decision: route?.traversable ? '备用路线可通行' : '路线尚未确认',
    tool: 'get_route_status',
    result: route?.traversable ? 'confirmed' : 'pending',
    next: '设置补光灯'
  });

  // 10. 设置补光灯
  const tl = await post('/api/tool', { name: 'turn_light_on', deviceId: 'light-01', brightness: 80, source: 'agh' });
  logLine({
    observation: `visibility=${w.visibility}m, light needs to be on`,
    decision: '打开补光灯（亮度80）',
    tool: 'turn_light_on(light-01, 80)',
    result: fmtResult(tl),
    next: '设置诱导屏'
  });

  // 11. 设置诱导屏
  const sm = await post('/api/tool', { name: 'set_message', deviceId: 'vms-01', message: '前方救援，限速 30', source: 'agh' });
  const sl = await post('/api/tool', { name: 'set_speed_limit', deviceId: 'vms-01', limit: 30, source: 'agh' });
  logLine({
    observation: `vms message="${sm.data.toolResult?.ok ? 'set' : 'fail'}", limit=${sl.data.toolResult?.ok ? 30 : 'fail'}`,
    decision: '诱导屏显示"前方救援，限速 30"',
    tool: 'set_message + set_speed_limit',
    result: fmtResult(sm),
    next: '派遣救援车'
  });

  // 12. 派遣救援车
  const dr2 = await post('/api/tool', { name: 'dispatch_rescue_vehicle', source: 'agh' });
  logLine({
    observation: `route.traversable=${route?.traversable}, visibility=${w.visibility}m`,
    decision: '派遣救援车',
    tool: 'dispatch_rescue_vehicle',
    result: fmtResult(dr2),
    next: '读取救援车摄像头'
  });

  // 13. 读取救援车摄像头
  const cam2 = await post('/api/tool', { name: 'get_camera_frame', cameraId: 'rescue-cam-01', source: 'agh' });
  logLine({
    observation: `rescue-cam-01: ${cam2.data.toolResult?.data?.mimeType || 'no frame'}`,
    decision: '读取救援车摄像头',
    tool: 'get_camera_frame(rescue-cam-01)',
    result: fmtResult(cam2),
    next: '完成牵引'
  });

  // 14. 完成牵引（等待救援车到达并牵引）
  let towing = false;
  for (let i = 0; i < 30; i++) {
    const s2 = (await fetch(base + '/api/state')).json();
    if (s2.state?.rescueVehicle?.status === 'towing' || s2.state?.phase === 'completed') { towing = true; break; }
    await new Promise(r => setTimeout(r, 1000));
  }
  logLine({
    observation: towing ? 'rescueVehicle.status=towing' : '牵引未完成',
    decision: towing ? '牵引中，等待完成' : '牵引未确认',
    tool: 'towing_check',
    result: towing ? 'towing' : 'pending',
    next: '完成牵引'
  });

  console.log(`\n===== C2 决策链完成，共 ${decisions.length} 条 C4 日志 =====`);
}

// 启动服务
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
  try {
    await main();
  } finally {
    server.kill();
    await new Promise(r => server.on('close', r));
    console.log('服务已关闭');
  }
})();
