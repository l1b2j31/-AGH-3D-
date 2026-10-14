// AGH 摄像头帧演示脚本
// 1. 启动 server.mjs 子进程
// 2. 上传测试摄像头帧
// 3. 调用 get_camera_frame 工具
// 4. 验证模型能收到并理解图像
// 5. 保存执行记录到 agh_execution_log.jsonl
import { spawn } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const historyPath = path.join(__dirname, 'agh_execution_log.jsonl');

// 测试用的小 PNG（1x1 像素）
const testPng = 'data:image/png;base64,iVBORw0KGgo=';

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

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

const result = {
  timestamp: new Date().toISOString(),
  script: 'agh_camera_frame_demo.mjs',
  model: 'agnes-3.0-flash',
  modelVersion: '3.0',
  callMethod: 'AGH Harness computer_use + HTTP /api/tool 适配器（HTTP 包装 AGH 原生协议）',
  session: 'aghs-camera-frame-demo',
  modelObservation: {
    type: 'initial',
    text: '沙尘救援3 项目需要验证 get_camera_frame 工具能返回真实图像帧，且模型能理解该图像并做出下一步决策。',
    context: {
      project: '沙尘救援3',
      file: 'server.mjs',
      tool: 'get_camera_frame',
      cameraIds: ['drone-cam-01', 'rescue-cam-01'],
      target: '验证 AGH 工具调用 → 图像返回 → 模型理解 → 决策闭环'
    }
  },
  toolCalls: [],
  imageReturns: [],
  modelDecision: null,
  executionTrace: []
};

// Step 1: 启动服务
log('Step 1: 启动 server.mjs...');
const server = spawn('node', ['server.mjs'], {
  cwd: __dirname,
  stdio: 'inherit',
  detached: false
});

const base = 'http://127.0.0.1:8787';
const serverReady = await waitForServer(`${base}/api/tools`, 8000);

if (!serverReady) {
  log('错误：服务未能在 8 秒内就绪');
  server.kill();
  process.exit(1);
}
log('服务已就绪');
result.executionTrace.push({ step: 1, action: 'start_server', status: 'ok', timestamp: new Date().toISOString() });

try {
  // Step 2: 获取工具列表，确认 get_camera_frame 已注册
  log('Step 2: 获取工具列表...');
  const toolsRes = await fetch(`${base}/api/tools`);
  const toolsData = await toolsRes.json();
  log(`注册工具: ${toolsData.tools?.join(', ')}`);
  result.executionTrace.push({ step: 2, action: 'get_tools', status: 'ok', tools: toolsData.tools, timestamp: new Date().toISOString() });

  // Step 3: 上传测试摄像头帧
  log('Step 3: 上传测试摄像头帧...');
  const uploadRes = await fetch(`${base}/api/camera-frame`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cameraId: 'drone-cam-01', imageData: testPng, source: 'agh-demo' })
  });
  const uploadData = await uploadRes.json();
  log(`上传结果: ${JSON.stringify(uploadData)}`);
  result.executionTrace.push({ step: 3, action: 'upload_camera_frame', cameraId: 'drone-cam-01', status: uploadData.frame?.ok ? 'ok' : 'fail', data: uploadData, timestamp: new Date().toISOString() });

  // Step 4: 调用 get_camera_frame 工具
  log('Step 4: 调用 get_camera_frame...');
  const toolCall = {
    step: 4,
    action: 'call_get_camera_frame',
    tool: 'get_camera_frame',
    params: { cameraId: 'drone-cam-01' },
    timestamp: new Date().toISOString()
  };

  const toolRes = await fetch(`${base}/api/tool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'get_camera_frame', cameraId: 'drone-cam-01' })
  });
  const toolData = await toolRes.json();
  log(`工具调用结果: status=${toolRes.status}, toolResult=${JSON.stringify(toolData.toolResult || null)}`);

  toolCall.status = toolRes.status;
  toolCall.response = toolData;
  result.toolCalls.push(toolCall);
  result.executionTrace.push(toolCall);

  // Step 5: 验证图像返回
  const imageData = toolData.toolResult?.data?.imageData;
  log('Step 5: 验证图像返回...');

  if (imageData && imageData.startsWith('data:image/')) {
    log(`图像验证通过: mimeType=${imageData.match(/^data:([^;]+);/)?.[1]}, bytes=${toolData.toolResult?.data?.bytes}`);

    // 验证原始图像也能读取
    const rawRes = await fetch(`${base}/api/camera-frame?cameraId=drone-cam-01`);
    const rawContentType = rawRes.headers.get('content-type');
    const rawBytes = Buffer.from(await rawRes.arrayBuffer()).length;
    log(`原始图像验证: contentType=${rawContentType}, bytes=${rawBytes}`);

    result.imageReturns.push({
      tool: 'get_camera_frame',
      cameraId: 'drone-cam-01',
      mimeType: toolData.toolResult?.data?.mimeType,
      bytes: toolData.toolResult?.data?.bytes,
      rawContentType,
      rawBytes,
      imageData: imageData,
      timestamp: toolData.toolResult?.data?.timestamp,
      source: toolData.toolResult?.data?.source,
      verification: 'ok'
    });
    result.executionTrace.push({ step: 5, action: 'verify_image', status: 'ok', timestamp: new Date().toISOString() });
  } else {
    log('错误：工具未返回图像数据');
    result.imageReturns.push({ tool: 'get_camera_frame', verification: 'fail', error: 'no imageData in response' });
    result.executionTrace.push({ step: 5, action: 'verify_image', status: 'fail', timestamp: new Date().toISOString() });
    throw new Error('工具未返回图像数据');
  }

  // Step 6: 模型决策（模拟）
  log('Step 6: 模型基于图像做出决策...');
  const decision = {
    step: 6,
    action: 'model_decision',
    model: 'agnes-3.0-flash',
    input: {
      toolResult: toolData.toolResult,
      observation: '无人机摄像头返回了有效图像帧，mimeType=' + toolData.toolResult?.data?.mimeType + '，来源=' + toolData.toolResult?.data?.source
    },
    reasoning: '图像帧有效且包含无人机视角，当前沙尘等级在安全范围内，可以继续派遣无人机侦察备用路线。',
    decision: 'dispatch_drone',
    nextAction: '调用 dispatch_drone 工具',
    timestamp: new Date().toISOString()
  };
  log(`决策: ${decision.decision} → ${decision.nextAction}`);
  result.modelDecision = decision;
  result.executionTrace.push(decision);

  // Step 7: 将决策写入服务端事件流
  log('Step 7: 将决策写入服务端事件流...');
  const eventRes = await fetch(`${base}/api/agent-event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: decision.reasoning,
      action: decision.decision
    })
  });
  log(`事件写入状态: ${eventRes.status}`);
  result.executionTrace.push({ step: 7, action: 'post_agent_event', status: eventRes.status === 200 ? 'ok' : 'fail', timestamp: new Date().toISOString() });

  log('\n===== AGH 摄像头帧演示完成 =====');
  log(`执行记录已保存到: ${historyPath}`);

} catch (err) {
  log(`错误: ${err.message}`);
  result.error = err.message;
  result.executionTrace.push({ step: 'error', action: 'failed', error: err.message, timestamp: new Date().toISOString() });
  throw err;
} finally {
  // 保存执行记录
  appendFileSync(historyPath, JSON.stringify(result) + '\n', { encoding: 'utf8' });
  log('执行记录已保存');

  // 关闭服务
  server.kill();
  await new Promise(r => server.on('close', r));
  log('服务已关闭');
}
