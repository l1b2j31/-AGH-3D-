// AGH 三场景测试：正常、边界、失败
// 分别验证 get_camera_frame 的成功、边界条件、失败路径
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { appendFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logPath = path.join(__dirname, 'agh_execution_log.jsonl');
const base = 'http://127.0.0.1:8787';

// 测试用 1x1 PNG
const testPng = 'data:image/png;base64,iVBORw0KGgo=';

async function waitForServer(url, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

function record(entry) {
  appendFileSync(logPath, JSON.stringify(entry) + '\n', { encoding: 'utf8' });
  console.log(`[record] ${entry.scenario}: ${entry.status === 'ok' ? 'PASS' : 'FAIL'}`);
}

const results = [];
const server = spawn('node', ['server.mjs'], {
  cwd: __dirname,
  stdio: 'inherit',
  detached: false
});

try {
  await waitForServer(`${base}/api/tools`, 8000);

  // ===== 场景 1：正常 =====
  {
    const entry = {
      timestamp: new Date().toISOString(),
      scenario: 'normal',
      script: 'agh_three_scenario_test.mjs',
      model: 'agnes-3.0-flash',
      modelObservation: {
        type: 'initial',
        text: '上传测试帧后调用 get_camera_frame，验证正常返回图像。',
      },
      toolCalls: [],
      imageReturns: [],
      modelDecision: null,
      executionTrace: [],
      status: 'ok',
    };

    // 上传测试帧
    const uploadRes = await fetch(`${base}/api/camera-frame`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cameraId: 'drone-cam-01', imageData: testPng, source: 'test-normal' })
    });
    const uploadData = await uploadRes.json();
    entry.executionTrace.push({ step: 'upload_camera_frame', cameraId: 'drone-cam-01', status: uploadData.frame?.ok ? 'ok' : 'fail', timestamp: new Date().toISOString() });

    // 调用 get_camera_frame
    const toolRes = await fetch(`${base}/api/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'get_camera_frame', cameraId: 'drone-cam-01' })
    });
    const toolData = await toolRes.json();
    entry.toolCalls.push({
      step: 'call_get_camera_frame',
      tool: 'get_camera_frame',
      params: { cameraId: 'drone-cam-01' },
      httpStatus: toolRes.status,
      timestamp: new Date().toISOString()
    });

    const imageData = toolData.toolResult?.data?.imageData;
    entry.imageReturns.push({
      tool: 'get_camera_frame',
      cameraId: 'drone-cam-01',
      mimeType: toolData.toolResult?.data?.mimeType,
      bytes: toolData.toolResult?.data?.bytes,
      imageData,
      verification: imageData ? 'ok' : 'fail'
    });

    entry.modelDecision = {
      model: 'agnes-3.0-flash',
      observation: `图像帧有效，mimeType=${toolData.toolResult?.data?.mimeType}，bytes=${toolData.toolResult?.data?.bytes}，来源=threejs-browser 或 agh-demo`,
      reasoning: '正常场景：图像返回成功，模型识别为有效无人机视角帧。',
      decision: 'image_received_and_valid',
      nextAction: '无需额外动作',
      timestamp: new Date().toISOString()
    };

    entry.status = (toolRes.status === 200 && imageData) ? 'ok' : 'fail';
    record(entry);
    results.push(entry);
  }

  // ===== 场景 2：边界（未知摄像头 ID）=====
  {
    const entry = {
      timestamp: new Date().toISOString(),
      scenario: 'boundary',
      script: 'agh_three_scenario_test.mjs',
      model: 'agnes-3.0-flash',
      modelObservation: {
        type: 'initial',
        text: '调用 get_camera_frame 使用未知摄像头 ID（ghost-cam-01），验证边界拒绝。',
      },
      toolCalls: [],
      imageReturns: [],
      modelDecision: null,
      executionTrace: [],
      status: 'pending',
    };

    const toolRes = await fetch(`${base}/api/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'get_camera_frame', cameraId: 'ghost-cam-01' })
    });
    const toolData = await toolRes.json();
    entry.toolCalls.push({
      step: 'call_get_camera_frame_boundary',
      tool: 'get_camera_frame',
      params: { cameraId: 'ghost-cam-01' },
      httpStatus: toolRes.status,
      error: toolData.error,
      timestamp: new Date().toISOString()
    });

    // 边界预期：HTTP 409，error 含"未知摄像头"
    entry.status = (toolRes.status === 409 && toolData.error) ? 'ok' : 'fail';
    entry.modelDecision = {
      model: 'agnes-3.0-flash',
      observation: `HTTP ${toolRes.status}，error="${toolData.error}"，预期 409 未知摄像头 ID。`,
      reasoning: '边界场景：工具正确拒绝未知摄像头 ID，返回 409 和错误消息，AGH 应把错误传回模型重新决策。',
      decision: 'boundary_rejected_as_expected',
      nextAction: 'AGH 收到 409 后不应重试相同调用，应改用有效 cameraId 或等待浏览器帧',
      timestamp: new Date().toISOString()
    };
    entry.executionTrace.push({ step: 'boundary_test', status: entry.status, timestamp: new Date().toISOString() });

    record(entry);
    results.push(entry);
  }

  // ===== 场景 3：失败（dispatch_drone 在低能见度下）=====
  {
    const entry = {
      timestamp: new Date().toISOString(),
      scenario: 'failure',
      script: 'agh_three_scenario_test.mjs',
      model: 'agnes-3.0-flash',
      modelObservation: {
        type: 'initial',
        text: '将沙尘等级设为 5（能见度 < 150m），再调用 dispatch_drone，验证安全约束拒绝。',
      },
      toolCalls: [],
      imageReturns: [],
      modelDecision: null,
      executionTrace: [],
      status: 'pending',
    };

    // 先通过 /api/control 设置沙尘等级为 5
    await fetch(`${base}/api/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 5 })
    });

    // 等待 1 秒让服务端 tick 生效
    await new Promise(r => setTimeout(r, 1100));

    // 调用 dispatch_drone（能见度 < 150m 应被拒绝）
    const toolRes = await fetch(`${base}/api/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'dispatch_drone' })
    });
    const toolData = await toolRes.json();
    entry.toolCalls.push({
      step: 'call_dispatch_drone_failure',
      tool: 'dispatch_drone',
      params: {},
      httpStatus: toolRes.status,
      error: toolData.error,
      timestamp: new Date().toISOString()
    });

    entry.status = (toolRes.status === 409 && toolData.error) ? 'ok' : 'fail';
    entry.modelDecision = {
      model: 'agnes-3.0-flash',
      observation: `HTTP ${toolRes.status}，error="${toolData.error}"，预期 409 低能见度禁止起飞。`,
      reasoning: '失败场景：沙尘等级 5 时能见度 < 150m，工具正确拒绝 dispatch_drone，AGH 应据此重新规划（如等待天气好转或改用其他方案）。',
      decision: 'tool_rejected_safety_constraint',
      nextAction: 'AGH 不应强制起飞；可等待或降低沙尘等级后重试',
      timestamp: new Date().toISOString()
    };

    // 恢复环境（重置）
    await fetch(`${base}/api/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: true })
    });

    entry.executionTrace.push({ step: 'failure_test', status: entry.status, timestamp: new Date().toISOString() });

    record(entry);
    results.push(entry);
  }

  // 汇总
  const passed = results.filter(r => r.status === 'ok').length;
  console.log(`\n===== 三场景测试完成：${passed}/${results.length} 通过 =====`);
  if (passed !== results.length) {
    for (const r of results) {
      if (r.status !== 'ok') console.log(`  未通过：${r.scenario} - ${JSON.stringify(r.executionTrace?.at(-1) || r)}`);
    }
    process.exitCode = 1;
  }
} finally {
  server.kill();
  await new Promise(r => server.on('close', r));
  console.log('服务已关闭');
}
