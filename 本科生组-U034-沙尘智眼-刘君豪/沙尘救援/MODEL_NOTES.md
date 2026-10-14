# 模型信息、版本与调用方式

## 模型
| 项目 | 值 |
|------|-----|
| 名称 | Agnes 3.0 Flash |
| 标识 | `agnes-3.0-flash` |
| 版本 | 3.0 |
| 提供方 | Agnes Harness（AGH） |

## 调用方式

AGH 把本机虚拟环境服务（`server.mjs`）的工具接口包装给模型。两种入口：

### 1. 原生 AGH 工具（推荐）
AGH Harness 通过 `computer_use` 驱动真实浏览器 / 调用本地 HTTP 适配器，再回到模型。
工具在模型侧以工具注册形式暴露，例如：

```json
{ "name": "get_camera_frame", "cameraId": "drone-cam-01" }
```

成功时模型收到：

```json
{
  "ok": true,
  "tool": "get_camera_frame",
  "data": {
    "cameraId": "drone-cam-01",
    "mimeType": "image/png",
    "imageData": "data:image/png;base64,...",
    "timestamp": "...",
    "source": "threejs-browser",
    "bytes": 10208
  }
}
```

`imageData` 可直接作为多模态图片输入喂给模型。HTTP `409` 表示动作不满足仿真约束，AGH 把 `error` 原样传回模型重新决策。

### 2. HTTP 适配器（脚本直连）
`agh_camera_frame_demo.mjs` / `test_agh.py` 通过本机 HTTP 直接调用，等价于 AGH 工具包装的底层接口：

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/tools` | GET | 工具列表 + 约束 + 单位 |
| `/api/observations` | GET | 气象/车辆/无人机/救援车/路线 |
| `/api/tool` | POST | 调用设备工具（含 `get_camera_frame`） |
| `/api/agent-event` | POST | 写入 AGH 决策事件（不执行动作） |
| `/api/camera-frame` | POST/GET | 上传/读取摄像头帧 |
| `/api/state` | GET | 完整快照 + 事件 + 帧元数据 |

调用方式：

```
POST http://127.0.0.1:8787/api/tool
{ "name": "get_camera_frame", "cameraId": "drone-cam-01" }
```

- 请求必须与 origin 同 host（服务端做了跨源写保护）。
- 默认端口 `8787`，可用环境变量 `PORT` / `BASE_URL` 覆盖。

## 日志中的模型字段
`agh_execution_log.jsonl` 每条记录携带：
- `model`: `agnes-3.0-flash`
- `modelVersion`: `3.0`（由 demo 脚本写入）
- `callMethod`: 调用方式说明（由 demo 脚本写入）
- `script`: 产生该记录的脚本名（区分 `agh_camera_frame_demo.mjs` / `agh_three_scenario_test.mjs` / `test_agh.py`）
