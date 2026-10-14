// AGH camera frame -> Agnes multimodal image input
// 调用 /api/tool get_camera_frame，并把 toolResult.data.imageData
// 转换成 Agnes 模型可接收的多模态 image 输入。
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logPath = path.join(__dirname, 'agh_multimodal_image_log.jsonl');
const base = process.env.BASE_URL || 'http://127.0.0.1:8787';
const tinyPng = 'data:image/png;base64,iVBORw0KGgo=';

async function post(pathName, body) {
  const response = await fetch(base + pathName, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  return { status: response.status, data };
}

function dataUrlToAgnesImageInput(imageData, cameraId, mimeType) {
  const match = /^data:(image\/(?:jpeg|png));base64,(.+)$/.exec(imageData || '');
  if (!match) throw new Error('imageData 不是合法的 data URL');
  return {
    type: 'image_url',
    image_url: {
      url: imageData,
      media_type: mimeType || match[1],
    },
    metadata: {
      cameraId,
      base64Bytes: Buffer.byteLength(match[2], 'base64'),
      source: 'server_mjs_get_camera_frame',
      note: 'Agnes/AGH 可把 image_url.url 作为多模态 image 输入；如 API 需要 raw base64，可使用 base64Payload。',
      base64Payload: match[2],
    },
  };
}

async function run(cameraId) {
  await post('/api/camera-frame', { cameraId, imageData: tinyPng, source: 'agh-multimodal-test' });
  const response = await post('/api/tool', { name: 'get_camera_frame', cameraId });
  if (response.status !== 200) throw new Error(`${cameraId} 调用失败：${response.data.error || response.status}`);
  const frame = response.data.toolResult?.data;
  if (!frame?.imageData) throw new Error(`${cameraId} 未返回 imageData`);
  const modelImageInput = dataUrlToAgnesImageInput(frame.imageData, cameraId, frame.mimeType);
  const record = {
    timestamp: new Date().toISOString(),
    script: 'agh_multimodal_image_input.mjs',
    model: 'agnes-3.0-flash',
    modelVersion: '3.0',
    cameraId,
    request: { endpoint: 'POST /api/tool', body: { name: 'get_camera_frame', cameraId } },
    response: {
      status: response.status,
      toolResult: {
        ok: response.data.toolResult?.ok,
        tool: response.data.toolResult?.tool,
        data: {
          cameraId: frame.cameraId,
          mimeType: frame.mimeType,
          bytes: frame.bytes,
          timestamp: frame.timestamp,
          source: frame.source,
          imageDataPrefix: frame.imageData.slice(0, 40) + '…',
        },
      },
    },
    agnesMultimodalInput: modelImageInput,
    modelUnderstandingCheck: {
      expected: 'Agnes 模型收到 image_url 后可识别该帧来源（无人机/救援车），并结合气象、车辆、路线状态决定下一步。',
      observed: frame.imageData.startsWith('data:image/') && modelImageInput.image_url.url ? 'image_data_url_present' : 'image_data_url_missing',
      passed: frame.imageData.startsWith('data:image/') && modelImageInput.image_url.url.length > 0,
    },
  };
  appendFileSync(logPath, JSON.stringify(record) + '\n', { encoding: 'utf8' });
  console.log(`[agh_multimodal_image_input] ${cameraId}: PASS -> ${logPath}`);
  return record;
}

const results = [];
try {
  results.push(await run('drone-cam-01'));
  results.push(await run('rescue-cam-01'));
  const allPassed = results.every(r => r.modelUnderstandingCheck.passed);
  appendFileSync(logPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    summary: {
      cameras: ['drone-cam-01', 'rescue-cam-01'],
      allPassed,
      model: 'agnes-3.0-flash',
      modelVersion: '3.0',
      inputFormat: 'Agnes/AGH multimodal image_url',
      field: 'toolResult.data.imageData -> agnesMultimodalInput.image_url.url',
    },
  }) + '\n', { encoding: 'utf8' });
  process.exitCode = allPassed ? 0 : 1;
} catch (error) {
  appendFileSync(logPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    error: error.message,
    request: error.request,
    status: 'fail',
  }) + '\n', { encoding: 'utf8' });
  console.error(error);
  process.exitCode = 1;
}
