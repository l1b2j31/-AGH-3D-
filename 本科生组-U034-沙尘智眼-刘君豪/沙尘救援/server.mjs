import http from 'node:http';
import { readFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const htmlPath = new URL('./index.html', import.meta.url);
const historyPath = new URL('./episodes.jsonl', import.meta.url);
const port = Number(process.env.PORT || 8787);
const tools = ['attempt_self_recovery','stop_vehicle','dispatch_drone','return_drone','dispatch_rescue_vehicle','change_vms','toggle_light','get_camera_frame',
  'get_weather_station_status','get_vehicle_status','get_drone_status',
  'set_message','set_speed_limit','turn_light_on','turn_light_off'];
const cameraIds = new Set(['drone-cam-01','rescue-cam-01']);
const maxCameraFrameBytes = 2 * 1024 * 1024;
let state, events = [], sequence = 0;
const cameraFrames = new Map();
function event(source, type, message, extra = {}) {
  const e = { id: ++sequence, timestamp: new Date().toISOString(), source, type, message, ...extra };
  events.push(e); events = events.slice(-120); return e;
}
function weather(level) {
  state.weather.sandstormLevel = level;
  state.weather.visibility = Math.round(1000 * Math.exp(-level * .48));
  state.weather.windSpeed = Math.round((6 + level * 1.8) * 10) / 10;
  state.weather.timestamp = new Date().toISOString();
}
function reset() {
  state = { episodeId: Date.now().toString(), elapsed: 0, phase: 'waiting', autoWeather: false,
    weather: { sandstormLevel: 2, visibility: 383, windSpeed: 9.6, temperature: 38, timestamp: new Date().toISOString() },
    vehicle: { id: 'vehicle-01', position: [5,0,2], fuel: 32, wheelSlip: .88, stuck: true, status: 'stuck', attempts: 0 },
    drone: { id: 'drone-01', position: [-10,0,-10], battery: 76, status: 'standby', progress: 0, camId:'drone-cam-01' },
    rescueVehicle: { id: 'rescue-01', position: [-24,0,2], fuel: 78, status: 'standby', progress: 0 ,camId:'rescue-cam-01'},
    vms: { id: 'vms-01', message: '', speedLimit: null },
    light: { id: 'light-01', on: false, brightness: 0 },
    route: { known: false, traversable: false, inspectedAt: null },
    metrics: { manualInterventions: 0, agentToolCalls: 0, failedToolCalls: 0, success: false },
    connection: { lastAgentEvent: null }, lastAction: null };
  events = []; cameraFrames.clear(); event('environment','status','仿真已重置，等待操作或 AGH 接入。');
}
reset();
const cameraFrameMetadata = () => Object.fromEntries([...cameraFrames].map(([cameraId, frame]) => [cameraId, frame ? {
  cameraId: frame.cameraId, mimeType: frame.mimeType, timestamp: frame.timestamp, source: frame.source, bytes: frame.bytes,
} : null]));
const snapshot = () => ({ state, events, toolNames: tools, cameraFrames: cameraFrameMetadata() });
function validateCameraId(cameraId) {
  if (!cameraIds.has(cameraId)) throw new Error('未知摄像头 ID: ' + cameraId + '，可用 drone-cam-01 / rescue-cam-01');
  return cameraId;
}
function storeCameraFrame(body) {
  const cameraId = validateCameraId(String(body.cameraId || ''));
  const imageData = body.imageData;
  const match = typeof imageData === 'string' && imageData.match(/^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('imageData 必须是 PNG 或 JPEG data URL');
  const bytes = Buffer.byteLength(match[2], 'base64');
  if (bytes <= 0 || bytes > maxCameraFrameBytes) throw new Error('摄像头帧大小必须在 1B–2MB 之间');
  const frame = { cameraId, mimeType: match[1], imageData, timestamp: new Date().toISOString(), source: String(body.source || 'browser'), bytes };
  cameraFrames.set(cameraId, frame);
  return { ok: true, cameraId, mimeType: frame.mimeType, timestamp: frame.timestamp, bytes, source: frame.source };
}
function action(name, source, body) {
    const { vehicle: v, drone: d, rescueVehicle: r, weather: w } = state;

    // ---- C1: 只读状态工具（不修改状态、不计入 metrics）----
    if (name === 'get_weather_station_status') {
      return { ok: true, tool: name, data: {
        stationId: 'ws-01',
        sandstormLevel: w.sandstormLevel, visibility: w.visibility, windSpeed: w.windSpeed,
        temperature: w.temperature, timestamp: w.timestamp
      }};
    }
    if (name === 'get_vehicle_status') {
      return { ok: true, tool: name, data: {
        vehicleId: v.id, position: v.position, fuel: v.fuel, wheelSlip: v.wheelSlip,
        stuck: v.stuck, status: v.status, attempts: v.attempts
      }};
    }
    if (name === 'get_drone_status') {
      return { ok: true, tool: name, data: {
        droneId: d.id, position: d.position, battery: d.battery, status: d.status,
        progress: d.progress, camId: d.camId
      }};
    }

    // ---- C1: 诱导屏 / 补光灯 命名工具 ----
    if (name === 'change_vms') {
      state.vms.message = body.message || '前方沙尘，注意减速';
      state.vms.speedLimit = body.speed || 40;
    }
    if (name === 'set_message') {
      const device = body.deviceId === 'vms-01' || !body.deviceId;
      if (!device) throw new Error('set_message 仅支持 vms-01');
      state.vms.message = body.message;
    }
    if (name === 'set_speed_limit') {
      if (body.deviceId && body.deviceId !== 'vms-01') throw new Error('set_speed_limit 仅支持 vms-01');
      const limit = Number(body.limit);
      if (!Number.isFinite(limit)) throw new Error('limit 必须是数字');
      state.vms.speedLimit = limit;
    }
    if (name === 'toggle_light') {
      state.light.on = body.on !== false;
      state.light.brightness = body.brightness || 100;
    }
    if (name === 'turn_light_on') {
      if (body.deviceId && body.deviceId !== 'light-01') throw new Error('turn_light_on 仅支持 light-01');
      state.light.on = true;
      state.light.brightness = body.brightness || 100;
    }
    if (name === 'turn_light_off') {
      if (body.deviceId && body.deviceId !== 'light-01') throw new Error('turn_light_off 仅支持 light-01');
      state.light.on = false;
      state.light.brightness = 0;
    }

  if (!tools.includes(name)) throw new Error('Unknown tool');
  if (name === 'get_camera_frame') {
    const cameraId = validateCameraId(String(body.cameraId || ''));
    const frame = cameraFrames.get(cameraId);
    if (!frame) throw new Error(cameraId + ' 尚未收到浏览器帧，请先打开对应设备视角');
    source === 'agh' ? state.metrics.agentToolCalls++ : state.metrics.manualInterventions++;
    state.lastAction = { name, source, timestamp: new Date().toISOString() };
    event(source, 'tool', name + ' 已返回 ' + cameraId + ' 图像');
    return { ok: true, tool: name, data: { cameraId, mimeType: frame.mimeType, imageData: frame.imageData, timestamp: frame.timestamp, source: frame.source, bytes: frame.bytes } };
  }
  if (state.phase === 'completed') throw new Error('任务已完成，请先重置');
  if (name === 'attempt_self_recovery') {
    if (!v.stuck || v.status === 'recovering') throw new Error('车辆无需自救或已在尝试');
    if (w.visibility < 150) throw new Error('仿真安全约束：能见度低于150米，禁止自救');
    v.status = 'recovering'; v.attempts++; v.actionTime = 0; state.phase = 'self_recovery';
  }
  if (name === 'stop_vehicle') { v.status = v.stuck ? 'stopped' : 'safe'; state.phase = 'waiting'; }
  if (name === 'dispatch_drone') {
    if (d.status !== 'standby') throw new Error('无人机当前不在待命状态');
    if (w.windSpeed > 12 || w.visibility < 150) throw new Error('仿真安全约束：风速>12m/s或能见度<150米，禁止起飞');
    if (d.battery < 20) throw new Error('无人机电量不足');
    d.status = 'scouting'; d.progress = 0; state.phase = 'scouting';
  }
  if (name === 'return_drone') { if (d.status !== 'scouting') throw new Error('无人机未在空中'); d.status = 'returning'; }
  if (name === 'dispatch_rescue_vehicle') {
    if (r.status !== 'standby') throw new Error('救援车辆已在执行任务');
    if (!state.route.known || !state.route.traversable) throw new Error('需先侦察并确认备用路线可通行');
    if (w.visibility < 100) throw new Error('仿真安全约束：能见度低于100米，救援车等待');
    r.status = 'enroute'; r.progress = 0; state.phase = 'rescuing';
  }
  source === 'agh' ? state.metrics.agentToolCalls++ : state.metrics.manualInterventions++;
  state.lastAction = { name, source, timestamp: new Date().toISOString() };
  event(source,'tool',name + ' 已接受');
  return { ok: true, tool: name };
}
setInterval(() => {
  if (state.phase !== 'completed') state.elapsed++;
  if (state.autoWeather) weather(Math.round((3 + 2 * Math.sin(state.elapsed / 18)) * 10) / 10);
  state.weather.timestamp = new Date().toISOString();
  const { drone: d, vehicle: v, rescueVehicle: r } = state;
  if (v.status === 'recovering') {
    v.actionTime++; v.fuel = Math.max(0,v.fuel - .1);
    if (v.actionTime >= 5) {
      v.status = 'stuck'; state.phase = 'waiting';
      event('environment','feedback','自救失败：松软沙地导致车轮持续打滑，车辆仍被困。');
    }
  }
  if (d.status === 'scouting') {
    d.battery = Math.max(0,d.battery - .15);
    if (state.weather.windSpeed > 12 || state.weather.visibility < 150) {
      d.status = 'returning'; event('environment','warning','风速或能见度超出仿真飞行限制，无人机保护返航。');
    } else {
      d.progress = Math.min(1,d.progress + .07);
      d.position = [-10 + 15*d.progress, 5, -10 + 9*d.progress];
      if (d.progress >= 1) {
        state.route = { known: true, traversable: true, inspectedAt: new Date().toISOString(), name: '北侧硬质路肩', source: 'drone-01' };
        d.status = 'returning'; event('environment','feedback','无人机观测：北侧硬质路肩可通行，发现备用救援路线。');
      }
    }
  }
  if (d.status === 'returning') {
    d.position = d.position.map((p,i) => p + ([-10,0,-10][i]-p)*.25);
    if (Math.hypot(d.position[0]+10,d.position[1],d.position[2]+10) < .5) { d.position = [-10,0,-10]; d.status = 'standby'; }
  }
  if (r.status === 'enroute') {
    if (state.weather.visibility < 100) {
      r.status = 'paused'; event('environment','warning','能见度过低，救援车自动停车等待。');
    } else {
      r.progress = Math.min(1,r.progress + .045); r.fuel -= .08;
      r.position = [-24+27*r.progress,0,2];
      if (r.progress >= 1) { r.status='towing'; r.towTime=0; event('environment','feedback','救援车到达，开始牵引被困车辆。'); }
    }
  }
  if (r.status === 'paused' && state.weather.visibility >= 100) { r.status='enroute'; event('environment','feedback','能见度恢复，救援车继续沿已确认路线行驶。'); }
  if (r.status === 'towing') {
    r.towTime++; v.position[0] -= .5; r.position[0] -= .5;
    if (r.towTime >= 8) {
      v.stuck=false; v.status='safe'; r.status='completed'; state.phase='completed'; state.metrics.success=true;
      event('environment','result','救援完成，车辆已转移至安全路段。');
      appendFile(historyPath,JSON.stringify({episodeId:state.episodeId,duration:state.elapsed,...state.metrics})+'\n').catch(e=>event('environment','warning','记录保存失败：'+e.message));
    }
  }
},1000);
const server = http.createServer(async (req,res) => {
  const respond = (code,data) => {res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  const url = new URL(req.url,'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') {res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(await readFile(htmlPath));return;}
    if (req.method === 'GET' && url.pathname === '/api/state') return respond(200,snapshot());
    if (req.method === 'GET' && url.pathname === '/api/observations') return respond(200,{weather:state.weather,vehicle:state.vehicle,drone:state.drone,rescueVehicle:state.rescueVehicle,route:state.route});
    if (req.method === 'GET' && url.pathname === '/api/tools') return respond(200,{tools, limits:{droneMaxWind:12,droneMinVisibility:150,rescueMinVisibility:100},units:{visibility:'m',windSpeed:'m/s',fuel:'percent',position:'scene metres'}});
    if (req.method === 'GET' && url.pathname === '/api/camera-frame') {
      const cameraId = validateCameraId(String(url.searchParams.get('cameraId') || ''));
      const frame = cameraFrames.get(cameraId);
      if (!frame) return respond(404,{error:cameraId + ' 尚未收到浏览器帧'});
      const payload = Buffer.from(frame.imageData.slice(frame.imageData.indexOf(',') + 1), 'base64');
      res.writeHead(200,{'Content-Type':frame.mimeType,'Content-Length':payload.length,'Cache-Control':'no-store','X-Camera-Id':cameraId,'X-Camera-Timestamp':frame.timestamp});
      res.end(payload); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/camera-frame') {
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return respond(403,{error:'Cross-origin writes disabled'});
      let raw=''; for await (const chunk of req) {raw += chunk;if(Buffer.byteLength(raw)>maxCameraFrameBytes*1.4)return respond(413,{error:'Camera frame too large'});}
      const body=JSON.parse(raw || '{}');
      return respond(200,{frame:storeCameraFrame(body),cameraFrames:cameraFrameMetadata()});
    }
    if (req.method === 'POST') {
      if (!['/api/control','/api/tool','/api/agent-event'].includes(url.pathname)) return respond(404,{error:'Not found'});
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return respond(403,{error:'Cross-origin writes disabled'});
      let raw=''; for await (const chunk of req) {raw += chunk;if(Buffer.byteLength(raw)>32768)return respond(413,{error:'Body too large'});}
      const body=JSON.parse(raw || '{}');
      if (url.pathname === '/api/agent-event') {
        if (typeof body.message !== 'string' || !body.message.trim()) return respond(400,{error:'message required'});
        state.connection.lastAgentEvent = new Date().toISOString();
        event('agh','decision',body.message.slice(0,2000),{action:body.action || null});
      } else if (url.pathname === '/api/tool') {
        try {const toolResult=action(body.name,'agh',body);state.connection.lastAgentEvent=new Date().toISOString();return respond(200,{...snapshot(),toolResult});}
        catch(e) {state.metrics.failedToolCalls++;event('agh','rejected',e.message,{action:body.name});return respond(409,{error:e.message,state});}
      } else if (body.reset) reset();
      else if ('level' in body) {const n=Number(body.level);if(!Number.isFinite(n)||n<1||n>6)return respond(400,{error:'level must be 1–6'});state.autoWeather=false;weather(n);event('manual','weather','手动设置仿真沙尘等级：'+n);}
      else if ('autoWeather' in body) state.autoWeather=Boolean(body.autoWeather);
      else action(body.name,'manual');
      return respond(200,snapshot());
    }
    respond(404,{error:'Not found'});
  } catch(e) { respond(400,{error:e.message}); }
});
server.on('error',e=>{console.error('启动失败：',e.message);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log('沙尘智眼：http://127.0.0.1:'+port+'\n虚拟环境服务已启动，等待网页或 AGH 工具调用。'));
