// 正常场景：模型决策 -> 调用工具 -> 救援完成
// 写入 agh_normal_rescue_log.jsonl
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logPath = path.join(__dirname, 'agh_normal_rescue_log.jsonl');
const base = process.env.BASE_URL || 'http://127.0.0.1:8787';
const png = 'data:image/png;base64,iVBORw0KGgo=';
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
  records.push(entry);
  appendFileSync(logPath, JSON.stringify(entry) + '\n', { encoding: 'utf8' });
  console.log(`[normal #${records.length}] ${entry.decision} -> ${entry.tool} -> ${entry.result} -> next: ${entry.next}`);
}

async function main() {
  await post('/api/control', { reset: true });
  await post('/api/camera-frame', { cameraId: 'drone-cam-01', imageData: png, source: 'normal-rescue' });
  await post('/api/camera-frame', { cameraId: 'rescue-cam-01', imageData: png, source: 'normal-rescue' });

  // 1. 读取气象站
  const ws = await post('/api/tool', { name: 'get_weather_station_status', source: 'agh' });
  step({ scene: 'normal', observation: `visibility=${ws.data.toolResult?.data?.visibility}m wind=${ws.data.toolResult?.data?.windSpeed}m/s`, decision: '读取气象站状态', tool: 'get_weather_station_status', result: tr(ws), next: '读取车辆状态' });

  // 2. 读取车辆
  const v = await post('/api/tool', { name: 'get_vehicle_status', source: 'agh' });
  step({ scene: 'normal', observation: `vehicle stuck=${v.data.toolResult?.data?.stuck} status=${v.data.toolResult?.data?.status} fuel=${v.data.toolResult?.data?.fuel}%`, decision: '车辆被困，需要救援', tool: 'get_vehicle_status', result: tr(v), next: '尝试自救' });

  // 3. 尝试自救
  const sr = await post('/api/tool', { name: 'attempt_self_recovery', source: 'agh' });
  step({ scene: 'normal', observation: 'vehicle stuck=true visibility=383m>=150m', decision: '允许自救', tool: 'attempt_self_recovery', result: tr(sr), next: '等待自救反馈' });

  // 4. 等待自救失败
  let s;
  for (let i = 0; i < 10; i++) {
    s = await getState();
    if (s.phase === 'waiting' && s.vehicle.status === 'stuck') break;
    await new Promise(r => setTimeout(r, 1000));
  }
  s = await getState();
  step({ scene: 'normal', observation: `vehicle.status=${s.vehicle.status} phase=${s.phase}`, decision: '自救失败，停止车辆', tool: 'environment_feedback', result: s.vehicle.status === 'stuck' ? 'stuck_confirmed' : 'unexpected', next: 'stop_vehicle' });

  // 5. 停止车辆
  const stop = await post('/api/tool', { name: 'stop_vehicle', source: 'agh' });
  step({ scene: 'normal', observation: `vehicle.status=${s.vehicle.status}`, decision: '停止车辆', tool: 'stop_vehicle', result: tr(stop), next: '读取无人机状态' });

  // 6. 读取无人机
  const d = await post('/api/tool', { name: 'get_drone_status', source: 'agh' });
  step({ scene: 'normal', observation: `drone battery=${d.data.toolResult?.data?.battery}% status=${d.data.toolResult?.data?.status}`, decision: '读取无人机状态', tool: 'get_drone_status', result: tr(d), next: '判断是否允许起飞' });

  // 7. 派遣无人机
  const dd = await post('/api/tool', { name: 'dispatch_drone', source: 'agh' });
  step({ scene: 'normal', observation: `wind=${ws.data.toolResult?.data?.windSpeed}m/s visibility=${ws.data.toolResult?.data?.visibility}m battery=${d.data.toolResult?.data?.battery}%`, decision: '允许无人机侦察', tool: 'dispatch_drone', result: tr(dd), next: '等待路线确认' });

  // 8. 等待无人机完成路线确认
  for (let i = 0; i < 30; i++) {
    s = await getState();
    if (s.route?.known && s.route?.traversable) break;
    if (s.phase === 'completed') break;
    await new Promise(r => setTimeout(r, 1000));
  }
  s = await getState();
  step({ scene: 'normal', observation: `route known=${s.route?.known} traversable=${s.route?.traversable}`, decision: '确认备用路线', tool: 'route_status', result: s.route?.traversable ? 'confirmed' : 'pending', next: '读取无人机摄像头' });

  // 9. 读取无人机摄像头
  const cam1 = await post('/api/tool', { name: 'get_camera_frame', cameraId: 'drone-cam-01', source: 'agh' });
  step({ scene: 'normal', observation: `drone-cam-01 bytes=${cam1.data.toolResult?.data?.bytes} mimeType=${cam1.data.toolResult?.data?.mimeType}`, decision: '读取无人机摄像头', tool: 'get_camera_frame(drone-cam-01)', result: tr(cam1), next: '设置补光灯和诱导屏' });

  // 10. 打开补光灯
  const light = await post('/api/tool', { name: 'turn_light_on', deviceId: 'light-01', brightness: 80, source: 'agh' });
  step({ scene: 'normal', observation: 'visibility=383m light needs to be on', decision: '打开补光灯(亮度80)', tool: 'turn_light_on(light-01, 80)', result: tr(light), next: '设置诱导屏' });

  // 11. 设置诱导屏
  const sm = await post('/api/tool', { name: 'set_message', deviceId: 'vms-01', message: '前方救援，限速 30', source: 'agh' });
  const sl = await post('/api/tool', { name: 'set_speed_limit', deviceId: 'vms-01', limit: 30, source: 'agh' });
  step({ scene: 'normal', observation: 'vms ready', decision: '诱导屏显示"前方救援，限速 30"', tool: 'set_message + set_speed_limit(vms-01)', result: tr(sm), next: '派遣救援车' });

  // 12. 派遣救援车
  const rescue = await post('/api/tool', { name: 'dispatch_rescue_vehicle', source: 'agh' });
  step({ scene: 'normal', observation: `route.traversable=${s.route?.traversable} visibility=${ws.data.toolResult?.data?.visibility}m`, decision: '派遣救援车', tool: 'dispatch_rescue_vehicle', result: tr(rescue), next: '读取救援车摄像头' });

  // 13. 读取救援车摄像头
  const cam2 = await post('/api/tool', { name: 'get_camera_frame', cameraId: 'rescue-cam-01', source: 'agh' });
  step({ scene: 'normal', observation: `rescue-cam-01 bytes=${cam2.data.toolResult?.data?.bytes} mimeType=${cam2.data.toolResult?.data?.mimeType}`, decision: '读取救援车摄像头', tool: 'get_camera_frame(rescue-cam-01)', result: tr(cam2), next: '等待牵引完成' });

  // 14. 等待牵引完成
  for (let i = 0; i < 35; i++) {
    s = await getState();
    if (s.phase === 'completed') break;
    await new Promise(r => setTimeout(r, 1000));
  }
  s = await getState();
  const ok = s.phase === 'completed' && s.metrics.success === true && s.vehicle.status === 'safe' && s.rescueVehicle.status === 'completed';
  step({ scene: 'normal', observation: `phase=${s.phase} vehicle=${s.vehicle.status} rescue=${s.rescueVehicle.status} success=${s.metrics.success}`, decision: '救援完成', tool: 'final_state', result: ok ? 'completed' : 'not_completed', next: '结束' });

  const summary = {
    timestamp: new Date().toISOString(),
    scene: 'normal',
    model: 'agnes-3.0-flash',
    modelVersion: '3.0',
    ok,
    finalState: { phase: s.phase, vehicle: s.vehicle.status, rescue: s.rescueVehicle.status, success: s.metrics.success },
    totalSteps: records.length,
    logFile: logPath
  };
  appendFileSync(logPath, JSON.stringify(summary) + '\n', { encoding: 'utf8' });
  console.log('\n===== 正常场景汇总 =====');
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = ok ? 0 : 1;
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
