// 边界场景：恶劣天气下无人机被阻止或任务等待
// 写入 agh_boundary_drone_log.jsonl
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logPath = path.join(__dirname, 'agh_boundary_drone_log.jsonl');
const base = process.env.BASE_URL || 'http://127.0.0.1:8787';
const records = [];

async function post(path, body) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data; try { data = await r.json(); } catch { data = {}; }
  return { status: r.status, data };
}
async function getState() {
  const r = await fetch(base + '/api/state');
  return (await r.json()).state;
}
function tr(r) { return r.status === 200 ? 'accepted' : 'rejected: ' + (r.data.error || String(r.status)); }
function step(entry) {
  entry.timestamp = new Date().toISOString();
  entry.model = 'agnes-3.0-flash';
  entry.scene = 'boundary';
  records.push(entry);
  appendFileSync(logPath, JSON.stringify(entry) + '\n', { encoding: 'utf8' });
  console.log(`[boundary #${records.length}] ${entry.decision} -> ${entry.tool} -> ${entry.result} -> next: ${entry.next}`);
}

async function main() {
  await post('/api/control', { reset: true });

  // 1. 读取当前气象站
  let ws = await post('/api/tool', { name: 'get_weather_station_status', source: 'agh' });
  step({
    observation: `visibility=${ws.data.toolResult?.data?.visibility}m wind=${ws.data.toolResult?.data?.windSpeed}m/s level=${ws.data.toolResult?.data?.sandstormLevel}`,
    decision: '读取气象站状态',
    tool: 'get_weather_station_status',
    result: tr(ws),
    next: '设置沙尘等级 6 模拟恶劣天气'
  });

  // 2. 设置沙尘等级 6（visibility≈56m, wind≈16.8m/s，超出飞行限制）
  await post('/api/control', { level: 6 });
  await new Promise(r => setTimeout(r, 1200));
  ws = await post('/api/tool', { name: 'get_weather_station_status', source: 'agh' });
  step({
    observation: `level=6 visibility=${ws.data.toolResult?.data?.visibility}m wind=${ws.data.toolResult?.data?.windSpeed}m/s`,
    decision: '恶劣天气已建立（能见度<150m，风速>12m/s）',
    tool: 'set_sandstorm_level(6)',
    result: 'weather_set',
    next: '读取车辆状态'
  });

  // 3. 读取车辆
  const v = await post('/api/tool', { name: 'get_vehicle_status', source: 'agh' });
  step({
    observation: `vehicle stuck=${v.data.toolResult?.data?.stuck} status=${v.data.toolResult?.data?.status}`,
    decision: '车辆被困，需要救援，但天气恶劣',
    tool: 'get_vehicle_status',
    result: tr(v),
    next: '读取无人机状态'
  });

  // 4. 读取无人机
  const d = await post('/api/tool', { name: 'get_drone_status', source: 'agh' });
  step({
    observation: `drone battery=${d.data.toolResult?.data?.battery}% status=${d.data.toolResult?.data?.status}`,
    decision: '读取无人机状态',
    tool: 'get_drone_status',
    result: tr(d),
    next: '判断是否允许起飞'
  });

  // 5. 尝试派遣无人机（预期 409 被拒）
  const dd = await post('/api/tool', { name: 'dispatch_drone', source: 'agh' });
  const s1 = await getState();
  const blocked = dd.status === 409;
  step({
    observation: `wind=${ws.data.toolResult?.data?.windSpeed}m/s>12 visibility=${ws.data.toolResult?.data?.visibility}m<150`,
    decision: blocked ? '恶劣天气阻止无人机起飞，任务进入等待' : '无人机被允许起飞（不符合预期）',
    tool: 'dispatch_drone',
    result: tr(dd),
    next: blocked ? '等待天气改善或降低沙尘等级' : '继续侦察'
  });

  // 6. 验证无人机状态保持 standby（未被派遣）
  const d2 = await post('/api/tool', { name: 'get_drone_status', source: 'agh' });
  const stillStandby = d2.data.toolResult?.data?.status === 'standby';
  step({
    observation: `drone.status=${d2.data.toolResult?.data?.status}`,
    decision: stillStandby ? '无人机保持 standby，任务等待' : '无人机状态异常',
    tool: 'get_drone_status',
    result: stillStandby ? 'standby_confirmed' : 'unexpected',
    next: stillStandby ? '恢复天气后重试' : '检查仿真逻辑'
  });

  // 7. 恢复天气（沙尘等级 2，visibility=383m）
  await post('/api/control', { level: 2 });
  await new Promise(r => setTimeout(r, 1200));
  const ws2 = await post('/api/tool', { name: 'get_weather_station_status', source: 'agh' });
  step({
    observation: `visibility=${ws2.data.toolResult?.data?.visibility}m wind=${ws2.data.toolResult?.data?.windSpeed}m/s level=${ws2.data.toolResult?.data?.sandstormLevel}`,
    decision: '天气改善，恢复可飞行条件',
    tool: 'set_sandstorm_level(2)',
    result: 'weather_restored',
    next: '重试派遣无人机'
  });

  // 8. 重试派遣无人机（应被接受）
  const dd2 = await post('/api/tool', { name: 'dispatch_drone', source: 'agh' });
  const s2 = await getState();
  const retriedOk = dd2.status === 200;
  step({
    observation: `visibility=${ws2.data.toolResult?.data?.visibility}m wind=${ws2.data.toolResult?.data?.windSpeed}m/s`,
    decision: retriedOk ? '天气改善后允许无人机起飞' : '天气改善后仍被拒绝（不符合预期）',
    tool: 'dispatch_drone',
    result: tr(dd2),
    next: retriedOk ? '等待无人机完成侦察' : '进一步排查'
  });

  // 9. 汇总
  const ok = blocked && stillStandby && retriedOk;
  const summary = {
    timestamp: new Date().toISOString(),
    scene: 'boundary',
    model: 'agnes-3.0-flash',
    modelVersion: '3.0',
    ok,
    checks: {
      droneBlockedInBadWeather: blocked,
      droneStaysStandby: stillStandby,
      droneAllowedAfterWeatherRestore: retriedOk,
    },
    finalState: {
      weather: ws2.data.toolResult?.data,
      drone: d2.data.toolResult?.data,
    },
    totalSteps: records.length,
    logFile: logPath,
  };
  appendFileSync(logPath, JSON.stringify(summary) + '\n', { encoding: 'utf8' });
  console.log('\n===== 边界场景汇总 =====');
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = ok ? 0 : 1;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
