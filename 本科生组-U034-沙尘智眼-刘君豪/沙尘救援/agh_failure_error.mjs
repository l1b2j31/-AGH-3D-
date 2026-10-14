// 失败场景：工具返回错误后，AGH 如何处理
// 覆盖三类错误：
//   1. 未知摄像头 ID（参数错误）
//   2. 非法限速值（类型错误）
//   3. 安全约束拒绝（恶劣天气下 dispatch_drone）
// 每类错误都记录 AGH 的处理策略（修正参数 / 选择有效设备 / 等待恢复），并保存日志。
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logPath = path.join(__dirname, 'agh_failure_error_log.jsonl');
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
  entry.scene = 'failure';
  records.push(entry);
  appendFileSync(logPath, JSON.stringify(entry) + '\n', { encoding: 'utf8' });
  console.log(`[failure #${records.length}] ${entry.decision} -> ${entry.tool} -> ${entry.result} -> next: ${entry.next}`);
}

async function main() {
  await post('/api/control', { reset: true });

  // ===== 错误 1：未知摄像头 ID =====
  {
    const bad = await post('/api/tool', { name: 'get_camera_frame', cameraId: 'ghost-cam-99', source: 'agh' });
    const blocked = bad.status === 409 && /未知摄像头/.test(bad.data.error || '');
    step({
      observation: `cameraId=ghost-cam-99`,
      decision: blocked ? '工具返回未知摄像头错误，AGH 不把错误当成功' : '工具未返回预期错误',
      tool: 'get_camera_frame(ghost-cam-99)',
      result: tr(bad),
      next: 'AGH 将 error 传回模型，改用有效摄像头 drone-cam-01'
    });

    const good = await post('/api/camera-frame', { cameraId: 'drone-cam-01', imageData: 'data:image/png;base64,iVBORw0KGgo=', source: 'failure-retry' });
    const retry = await post('/api/tool', { name: 'get_camera_frame', cameraId: 'drone-cam-01', source: 'agh' });
    const recovered = retry.status === 200 && !!retry.data.toolResult?.data?.imageData;
    step({
      observation: `cameraId=drone-cam-01 retry`,
      decision: recovered ? 'AGH 修正参数后成功读取无人机摄像头' : 'AGH 修正参数后仍失败',
      tool: 'get_camera_frame(drone-cam-01)',
      result: tr(retry),
      next: recovered ? '继续正常流程' : '上报失败'
    });
    if (!blocked || !recovered) {
      const summary = { timestamp: new Date().toISOString(), scene: 'failure', model: 'agnes-3.0-flash', ok: false, failedCheck: 'unknown_camera', totalSteps: records.length };
      appendFileSync(logPath, JSON.stringify(summary) + '\n', { encoding: 'utf8' });
      process.exitCode = 1;
      return;
    }
  }

  // ===== 错误 2：非法限速值（非数字）=====
  {
    const bad = await post('/api/tool', { name: 'set_speed_limit', deviceId: 'vms-01', limit: 'fast', source: 'agh' });
    const rejected = bad.status === 409 && /必须是数字/.test(bad.data.error || '');
    step({
      observation: `set_speed_limit limit="fast"`,
      decision: rejected ? '工具返回参数类型错误，AGH 不写入非法值' : '工具未返回预期参数错误',
      tool: 'set_speed_limit(vms-01, "fast")',
      result: tr(bad),
      next: 'AGH 将 error 传回模型，修正为合法数字 30'
    });

    const fixed = await post('/api/tool', { name: 'set_speed_limit', deviceId: 'vms-01', limit: 30, source: 'agh' });
    const state = await getState();
    const recovered = fixed.status === 200 && state.vms.speedLimit === 30;
    step({
      observation: `set_speed_limit limit=30 vms.speedLimit=${state.vms.speedLimit}`,
      decision: recovered ? 'AGH 修正参数为数字 30 后成功' : 'AGH 修正参数后仍失败',
      tool: 'set_speed_limit(vms-01, 30)',
      result: tr(fixed),
      next: recovered ? '继续正常流程' : '上报失败'
    });
    if (!rejected || !recovered) {
      const summary = { timestamp: new Date().toISOString(), scene: 'failure', model: 'agnes-3.0-flash', ok: false, failedCheck: 'bad_limit', totalSteps: records.length };
      appendFileSync(logPath, JSON.stringify(summary) + '\n', { encoding: 'utf8' });
      process.exitCode = 1;
      return;
    }
  }

  // ===== 错误 3：安全约束（恶劣天气下 dispatch_drone 被拒）=====
  {
    await post('/api/control', { level: 6 });
    await new Promise(r => setTimeout(r, 1200));
    const ws = await post('/api/tool', { name: 'get_weather_station_status', source: 'agh' });
    const bad = await post('/api/tool', { name: 'dispatch_drone', source: 'agh' });
    const rejected = bad.status === 409 && /禁止起飞/.test(bad.data.error || '');
    const s1 = await getState();
    step({
      observation: `visibility=${ws.data.toolResult?.data?.visibility}m wind=${ws.data.toolResult?.data?.windSpeed}m/s level=${ws.data.toolResult?.data?.sandstormLevel}`,
      decision: rejected ? '工具返回安全约束错误，AGH 不强制起飞' : '工具未返回预期安全约束',
      tool: 'dispatch_drone',
      result: tr(bad),
      next: rejected ? 'AGH 保持等待并检查无人机状态是否 standby' : '上报异常'
    });

    const d = await post('/api/tool', { name: 'get_drone_status', source: 'agh' });
    const stillStandby = d.data.toolResult?.data?.status === 'standby';
    step({
      observation: `drone.status=${d.data.toolResult?.data?.status}`,
      decision: stillStandby ? 'AGH 确认无人机未被误派遣，任务等待' : 'AGH 检测到无人机状态异常',
      tool: 'get_drone_status',
      result: stillStandby ? 'standby_confirmed' : 'unexpected',
      next: '恢复天气后重试'
    });

    await post('/api/control', { level: 2 });
    await new Promise(r => setTimeout(r, 1200));
    const retry = await post('/api/tool', { name: 'dispatch_drone', source: 'agh' });
    const s2 = await getState();
    const recovered = retry.status === 200;
    step({
      observation: `visibility=${ws.data.toolResult?.data?.visibility}m restored level=2`,
      decision: recovered ? 'AGH 等待天气恢复后重试成功' : 'AGH 等待后重试仍失败',
      tool: 'dispatch_drone(retry)',
      result: tr(retry),
      next: recovered ? '等待无人机完成侦察' : '上报失败'
    });
    if (!rejected || !stillStandby || !recovered) {
      const summary = { timestamp: new Date().toISOString(), scene: 'failure', model: 'agnes-3.0-flash', ok: false, failedCheck: 'safety_constraint', totalSteps: records.length };
      appendFileSync(logPath, JSON.stringify(summary) + '\n', { encoding: 'utf8' });
      process.exitCode = 1;
      return;
    }
  }

  // ===== 汇总 =====
  const summary = {
    timestamp: new Date().toISOString(),
    scene: 'failure',
    model: 'agnes-3.0-flash',
    modelVersion: '3.0',
    ok: true,
    checks: {
      unknownCameraError: 'rejected + retry_ok',
      badLimitError: 'rejected + fixed_ok',
      safetyConstraintError: 'rejected + standby + retry_ok',
    },
    aghHandling: {
      unknownCamera: 'error -> model -> select valid cameraId -> retry',
      badLimit: 'error -> model -> coerce param to number -> retry',
      safetyConstraint: 'error -> model -> hold task / wait weather -> retry after recovery',
    },
    totalSteps: records.length,
    logFile: logPath,
  };
  appendFileSync(logPath, JSON.stringify(summary) + '\n', { encoding: 'utf8' });
  console.log('\n===== 失败场景汇总 =====');
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = 0;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
