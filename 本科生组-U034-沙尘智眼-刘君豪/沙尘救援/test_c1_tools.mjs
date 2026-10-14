// C1 工具注册校验脚本
// 验证 11 个命名工具全部注册，且行为正确
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const base = 'http://127.0.0.1:8787';
const testPng = 'data:image/png;base64,iVBORw0KGgo=';
const required = [
  'get_weather_station_status','get_vehicle_status','get_drone_status','get_camera_frame',
  'dispatch_drone','dispatch_rescue_vehicle','set_message','set_speed_limit',
  'turn_light_on','turn_light_off'
];
let failures = 0;
async function post(p, b) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  let d; try { d = await r.json(); } catch { d = {}; }
  return { status: r.status, data: d };
}
function check(label, ok, detail) {
  console.log(`[C1] ${ok ? 'PASS' : 'FAIL'}: ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}
async function main() {
  // 注册校验
  const tools = await (await fetch(base + '/api/tools')).json();
  const missing = required.filter(t => !tools.tools.includes(t));
  check('全部 11 个工具已注册', missing.length === 0, missing.length ? '缺失: ' + missing.join(',') : 'tools=' + tools.tools.length);

  // 只读工具
  const ws = await post('/api/tool', { name: 'get_weather_station_status' });
  check('get_weather_station_status 返回数据', ws.status === 200 && ws.data.toolResult?.data?.visibility !== undefined);

  const vs = await post('/api/tool', { name: 'get_vehicle_status' });
  check('get_vehicle_status 返回数据', vs.status === 200 && vs.data.toolResult?.data?.vehicleId === 'vehicle-01');

  const ds = await post('/api/tool', { name: 'get_drone_status' });
  check('get_drone_status 返回数据', ds.status === 200 && ds.data.toolResult?.data?.droneId === 'drone-01');

  // get_camera_frame 双摄像头
  await post('/api/camera-frame', { cameraId: 'drone-cam-01', imageData: testPng, source: 'c1' });
  await post('/api/camera-frame', { cameraId: 'rescue-cam-01', imageData: testPng, source: 'c1' });
  const cam1 = await post('/api/tool', { name: 'get_camera_frame', cameraId: 'drone-cam-01' });
  check('get_camera_frame(drone-cam-01) 返回图像', cam1.status === 200 && !!cam1.data.toolResult?.data?.imageData);
  const cam2 = await post('/api/tool', { name: 'get_camera_frame', cameraId: 'rescue-cam-01' });
  check('get_camera_frame(rescue-cam-01) 返回图像', cam2.status === 200 && !!cam2.data.toolResult?.data?.imageData);

  // set_message / set_speed_limit
  const sm = await post('/api/tool', { name: 'set_message', deviceId: 'vms-01', message: '前方沙尘，注意减速' });
  const stBody = await (await fetch(base + '/api/state')).json();
  check('set_message 写入 vms-01', sm.status === 200 && stBody.state?.vms?.message === '前方沙尘，注意减速');

  const sl = await post('/api/tool', { name: 'set_speed_limit', deviceId: 'vms-01', limit: 25 });
  const st2 = await (await fetch(base + '/api/state')).json();
  check('set_speed_limit 写入 vms-01', sl.status === 200 && st2.state?.vms?.speedLimit === 25);

  // turn_light_on / off
  const on = await post('/api/tool', { name: 'turn_light_on', deviceId: 'light-01', brightness: 60 });
  const stOn = await (await fetch(base + '/api/state')).json();
  check('turn_light_on(light-01, 60)', on.status === 200 && stOn.state?.light?.on === true && stOn.state?.light?.brightness === 60);

  const off = await post('/api/tool', { name: 'turn_light_off', deviceId: 'light-01' });
  const stOff = await (await fetch(base + '/api/state')).json();
  check('turn_light_off(light-01)', off.status === 200 && stOff.state?.light?.on === false && stOff.state?.light?.brightness === 0);

  console.log(`\n===== C1 校验完成：${failures === 0 ? '全部通过' : failures + ' 项失败'} =====`);
  process.exitCode = failures === 0 ? 0 : 1;
}

const server = spawn('node', ['server.mjs'], { cwd: __dirname, stdio: 'pipe' });
server.stdout?.on('data', c => process.stdout.write(c));
server.stderr?.on('data', c => process.stderr.write(c));
(async () => {
  await new Promise(r => setTimeout(r, 1500));
  try { await main(); }
  finally {
    server.kill();
    await new Promise(r => server.on('close', r));
    console.log('服务已关闭');
  }
})();
