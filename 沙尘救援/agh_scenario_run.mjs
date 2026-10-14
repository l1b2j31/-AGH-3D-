// 临时场景执行器：在已启动的 8787 服务上执行 normal/boundary/failure 三个场景，并输出最终结果。
const base = process.env.BASE_URL || 'http://127.0.0.1:8787';
const png = 'data:image/png;base64,iVBORw0KGgo=';
async function post(path, body) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data; try { data = await r.json(); } catch { data = {}; }
  return { status: r.status, data };
}
async function state() {
  const r = await fetch(base + '/api/state');
  return (await r.json()).state;
}
function toolResult(r) {
  return r.status === 200 ? 'accepted' : 'rejected: ' + (r.data.error || String(r.status));
}
function log(scene, obs, decision, tool, result, next) {
  console.log(JSON.stringify({ scene, observation: obs, decision, tool, result, next, timestamp: new Date().toISOString() }));
}
async function uploadFrames() {
  await post('/api/camera-frame', { cameraId: 'drone-cam-01', imageData: png, source: 'normal' });
  await post('/api/camera-frame', { cameraId: 'rescue-cam-01', imageData: png, source: 'normal' });
}

// 1. 正常：模型决策 -> AGH 工具调用 -> 救援完成
async function normal() {
  await post('/api/control', { reset: true });
  await uploadFrames();
  const ws = await post('/api/tool', { name: 'get_weather_station_status' });
  const v = await post('/api/tool', { name: 'get_vehicle_status' });
  const d = await post('/api/tool', { name: 'get_drone_status' });
  log('normal', `weather visibility=${ws.data.toolResult?.data?.visibility}m wind=${ws.data.toolResult?.data?.windSpeed}m/s`, '允许自救', 'get_weather_station_status', toolResult(ws), '调用 attempt_self_recovery');
  log('normal', `vehicle stuck=${v.data.toolResult?.data?.stuck} status=${v.data.toolResult?.data?.status}`, '车辆被困，尝试自救', 'get_vehicle_status', toolResult(v), '调用 attempt_self_recovery');
  const sr = await post('/api/tool', { name: 'attempt_self_recovery' });
  log('normal', `vehicle stuck=true visibility=${ws.data.toolResult?.data?.visibility}m`, '允许自救', 'attempt_self_recovery', toolResult(sr), '等待自救失败');
  for (let i = 0; i < 8; i++) { let s = await state(); if (s.phase === 'waiting' && s.vehicle.status === 'stuck') break; await new Promise(r => setTimeout(r, 1000)); }
  let s = await state();
  log('normal', `vehicle.status=${s.vehicle.status} after self-recovery`, '自救失败，停止车辆并准备无人机', 'attempt_self_recovery', 'feedback: vehicle stuck', 'stop_vehicle');
  const stop = await post('/api/tool', { name: 'stop_vehicle' });
  log('normal', `vehicle.status=${s.vehicle.status}`, '停止车辆', 'stop_vehicle', toolResult(stop), '判断无人机');
  const d2 = await post('/api/tool', { name: 'get_drone_status' });
  log('normal', `drone battery=${d2.data.toolResult?.data?.battery}% status=${d2.data.toolResult?.data?.status}`, '读取无人机状态', 'get_drone_status', toolResult(d2), '判断是否允许起飞');
  const dd = await post('/api/tool', { name: 'dispatch_drone' });
  log('normal', `wind=${ws.data.toolResult?.data?.windSpeed}m/s visibility=${ws.data.toolResult?.data?.visibility}m`, '允许无人机侦察', 'dispatch_drone', toolResult(dd), '等待无人机完成路线确认');
  for (let i = 0; i < 25; i++) { s = await state(); if (s.route?.known && s.route?.traversable) break; if (s.phase === 'completed') break; await new Promise(r => setTimeout(r, 1000)); }
  s = await state();
  log('normal', `route known=${s.route?.known} traversable=${s.route?.traversable}`, '确认备用路线', 'route_status', s.route?.traversable ? 'confirmed' : 'pending', '设置补光灯/诱导屏');
  const cam = await post('/api/tool', { name: 'get_camera_frame', cameraId: 'drone-cam-01' });
  log('normal', `drone-cam bytes=${cam.data.toolResult?.data?.bytes}`, '读取无人机摄像头', 'get_camera_frame(drone-cam-01)', toolResult(cam), '设置补光灯/诱导屏');
  const light = await post('/api/tool', { name: 'turn_light_on', deviceId: 'light-01', brightness: 80 });
  const vms = await post('/api/tool', { name: 'set_message', deviceId: 'vms-01', message: '前方救援，限速 30' });
  const limit = await post('/api/tool', { name: 'set_speed_limit', deviceId: 'vms-01', limit: 30 });
  log('normal', `light on=${light.data.toolResult?.ok} vms message set=${vms.data.toolResult?.ok} limit set=${limit.data.toolResult?.ok}`, '设置补光灯与诱导屏', 'turn_light_on/set_message/set_speed_limit', toolResult(light), '派遣救援车');
  const rescue = await post('/api/tool', { name: 'dispatch_rescue_vehicle' });
  log('normal', `route.traversable=${s.route?.traversable}`, '派遣救援车', 'dispatch_rescue_vehicle', toolResult(rescue), '读取救援车摄像头');
  if (rescue.status !== 200) return { ok: false, reason: toolResult(rescue) };
  const cam2 = await post('/api/tool', { name: 'get_camera_frame', cameraId: 'rescue-cam-01' });
  log('normal', `rescue-cam bytes=${cam2.data.toolResult?.data?.bytes}`, '读取救援车摄像头', 'get_camera_frame(rescue-cam-01)', toolResult(cam2), '等待牵引完成');
  for (let i = 0; i < 30; i++) { s = await state(); if (s.phase === 'completed') break; await new Promise(r => setTimeout(r, 1000)); }
  s = await state();
  const ok = s.phase === 'completed' && s.metrics.success === true && s.vehicle.status === 'safe';
  log('normal', `phase=${s.phase} vehicle=${s.vehicle.status} rescue=${s.rescueVehicle.status} success=${s.metrics.success}`, '救援完成', 'final_state', ok ? 'completed' : 'not completed', '结束');
  return { ok, state: { phase: s.phase, vehicle: s.vehicle.status, rescue: s.rescueVehicle.status, success: s.metrics.success } };
}

// 2. 边界：恶劣天气下无人机被阻止或任务等待
async function boundary() {
  await post('/api/control', { reset: true });
  await post('/api/control', { level: 6 });
  await new Promise(r => setTimeout(r, 1100));
  const ws = await post('/api/tool', { name: 'get_weather_station_status' });
  const dd = await post('/api/tool', { name: 'dispatch_drone' });
  const s = await (await (await fetch(base + '/api/state')).json()).state;
  log('boundary', `visibility=${ws.data.toolResult?.data?.visibility}m wind=${ws.data.toolResult?.data?.windSpeed}m/s level=${ws.data.toolResult?.data?.sandstormLevel}`, '风速/能见度超过飞行限制，无人机阻止起飞', 'dispatch_drone', toolResult(dd), '等待天气改善');
  const ok = dd.status === 409 && /禁止起飞|无法|约束/.test(dd.data.error || '');
  log('boundary', `drone.status=${s.drone.status} vms=${s.vms.message || 'none'}`, '任务进入等待状态', 'dispatch_drone', ok ? 'blocked-as-expected' : 'unexpected', '恢复天气后重试');
  return { ok, response: { status: dd.status, error: dd.data.error, droneStatus: s.drone.status } };
}

// 3. 失败：工具返回错误后 AGH 如何处理
async function failure() {
  await post('/api/control', { reset: true });
  const unknown = await post('/api/tool', { name: 'get_camera_frame', cameraId: 'ghost-cam-99' });
  log('failure', `unknown camera id ghost-cam-99`, '工具返回未知摄像头错误', 'get_camera_frame', toolResult(unknown), 'AGH 将 error 返回模型并选择有效摄像头');
  const badLimit = await post('/api/tool', { name: 'set_speed_limit', deviceId: 'vms-01', limit: 'fast' });
  log('failure', `limit parameter=fast`, '工具返回参数错误', 'set_speed_limit', toolResult(badLimit), 'AGH 将 error 返回模型并修正参数');
  const weather = await post('/api/control', { level: 5 });
  await new Promise(r => setTimeout(r, 1100));
  const drone = await post('/api/tool', { name: 'dispatch_drone' });
  log('failure', `visibility=${(await post('/api/tool',{name:'get_weather_station_status'})).data.toolResult?.data?.visibility}m`, '工具返回安全约束错误', 'dispatch_drone', toolResult(drone), 'AGH 不强制起飞，保持等待或恢复天气');
  const ok = unknown.status === 409 && badLimit.status === 409 && drone.status === 409;
  return { ok, responses: { unknownCamera: { status: unknown.status, error: unknown.data.error }, badLimit: { status: badLimit.status, error: badLimit.data.error }, droneRejected: { status: drone.status, error: drone.data.error } } };
}

(async () => {
  const n = await normal();
  const b = await boundary();
  const f = await failure();
  console.log(JSON.stringify({ normal: n, boundary: b, failure: f, allPassed: n.ok && b.ok && f.ok }));
  process.exitCode = (n.ok && b.ok && f.ok) ? 0 : 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
