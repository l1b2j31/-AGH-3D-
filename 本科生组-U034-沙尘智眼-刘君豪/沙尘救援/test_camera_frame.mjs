// 验证摄像头帧上传、原始图像读取和 AGH 工具返回。
// 使用前请先启动 server.mjs；真实浏览器帧由 index.html 自动上传。
const base = process.env.BASE_URL || 'http://127.0.0.1:8787';
const tinyPng = 'data:image/png;base64,iVBORw0KGgo=';
const post = async (path, body) => {
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
};
const tools = await (await fetch(base + '/api/tools')).json();
if (!tools.tools.includes('get_camera_frame')) throw new Error('get_camera_frame 未注册');
const uploaded = await post('/api/camera-frame', { cameraId: 'drone-cam-01', imageData: tinyPng, source: 'test' });
if (uploaded.status !== 200 || !uploaded.data.frame.ok) throw new Error('上传摄像头帧失败');
const returned = await post('/api/tool', { name: 'get_camera_frame', cameraId: 'drone-cam-01' });
if (returned.status !== 200 || returned.data.toolResult?.data?.imageData !== tinyPng) throw new Error('AGH 工具未返回原始图像');
const raw = await fetch(base + '/api/camera-frame?cameraId=drone-cam-01');
if (!raw.ok || raw.headers.get('content-type') !== 'image/png') throw new Error('原始图像读取失败');
console.log('camera frame test: PASS');
