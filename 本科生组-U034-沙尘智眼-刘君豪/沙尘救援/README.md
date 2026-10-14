# 沙尘智眼：3D 救援指挥台（独立升级包）

此包不覆盖原工程。包含网页、Node.js 虚拟环境服务和启动脚本；无需 npm install。3D 引擎首次加载需要联网访问 jsDelivr 或 unpkg。没有真实 AGH 接入前，只展示环境和人工事件。

## 启动

安装 Node.js 后双击 start.cmd，保持终端开启。打开 http://127.0.0.1:8787 。不要直接双击 index.html：设备 API 需要服务。

如果浏览器先于服务打开，请刷新。端口被占用时先关闭旧终端，再启动。服务只监听本机 127.0.0.1；C 的 AGH 最好运行在同一台电脑。

## 人工验收（先关闭自动天气）

1. 设置沙尘等级 2，点击尝试自救：5 秒后收到环境反馈，自救失败。
2. 点击侦察路线：约 15 秒后获得备用路线，无人机返航。
3. 点击派遣救援：救援车到达后牵引车辆，最终显示成功，统计来自服务。
4. 重置，设置沙尘等级 6，再点击侦察：工具应拒绝，不能无条件起飞。
5. 降回等级 2，重新侦察并派遣救援，检查恢复链路。
6. 开启自动天气，读数、雾和粒子变化；天气不会自行生成 AGH 决策。

## C 的接入协议

本包提供 HTTP 适配接口，不声称已实现 AGH Harness/MHS 原生协议。C 应用实际 Harness 的工具注册方法包装这些接口。

- GET /api/observations：气象站、车辆、无人机、救援车和已观测路线。
- GET /api/tools：工具名称、仿真约束和单位。
- POST /api/tool：调用设备工具，例如 {"name":"dispatch_drone"}。
- POST /api/agent-event：传递实际 AGH 决策，例如 {"message":"根据气象站风速和能见度，当前允许无人机侦察。","action":"dispatch_drone"}。
- GET /api/state：网页完整快照和事件，同时返回最近摄像头帧的元数据。
- POST /api/camera-frame：浏览器上传当前设备视角的 JPEG/PNG 帧。
- GET /api/camera-frame?cameraId=drone-cam-01：读取最近一帧原始图像。

工具：attempt_self_recovery、stop_vehicle、dispatch_drone、return_drone、dispatch_rescue_vehicle、change_vms、toggle_light、get_camera_frame、get_weather_station_status、get_vehicle_status、get_drone_status、set_message、set_speed_limit、turn_light_on、turn_light_off。

C1 新增 7 个命名工具（已在 `/api/tools` 注册，通过 `/api/tool` 调用）：
- `get_weather_station_status()` — 只读，返回能见度/风速/沙尘等级/温度。
- `get_vehicle_status()` — 只读，返回车辆位置/油量/打滑/被困/自救次数。
- `get_drone_status()` — 只读，返回无人机位置/电量/状态/进度/摄像头 ID。
- `get_camera_frame("drone-cam-01")` / `get_camera_frame("rescue-cam-01")` — 返回 base64 图像帧。
- `set_message("vms-01", message)` — 设置诱导屏文案（仅支持 vms-01）。
- `set_speed_limit("vms-01", limit)` — 设置诱导屏限速（仅支持 vms-01，limit 须为数字）。
- `turn_light_on("light-01", brightness)` / `turn_light_off("light-01")` — 开/关补光灯（仅支持 light-01）。

状态读取与工具结果都应返回给模型。HTTP 409 表示动作不满足条件，应把 error 返回给 AGH 重新决策。发布 decision 事件不执行动作，必须另调用工具。页面的人工按钮调用 /api/control，与 /api/tool 来源分开计数。

气象数据单位：能见度 m、风速 m/s、温度 °C。位置是场景米制坐标，油量和电量为百分比。沙尘等级 1–6 是演示内部尺度。飞行和救援阈值是仿真规则，不用于真实作业。

路线初始未知，只有无人机完成侦察后可获取。无人机在恶劣天气中自动返航；救援车在低能见度时保护停车。C 可将环境事件作为下一轮观察，决定等待或重新规划。

## 交付与指标

已实现：场景几何模型、沙丘道路、监测点、气象站、车辆、无人机、救援车、视角切换、沙尘动画、设备面板、真实来源日志、天气控制、工具执行和反馈。

成功任务保存到 episodes.jsonl，包含耗时、人工动作、AGH 工具调用和失败调用次数。重置会清除本轮事件，不删除历史文件。记录仅是经验数据，尚未实现 RSI 或策略学习。未完成任务也会持续计时。

当前限制：简化几何和运动，不是物理引擎；设备帧是浏览器 Three.js 仿真渲染而非真实摄像头；接口没有远程鉴权，因此仅开放本机。AGH 原生协议、经验检索和策略验证仍由 C 后续完成。

## 图像观测回传

页面会把无人机和救援车两个设备视角以 JPEG data URL 上传到服务端，默认每秒更新一次；页面仍可切换显示其中一个视角。AGH 或其他适配器可调用：

```json
POST /api/tool
{"name":"get_camera_frame","cameraId":"drone-cam-01"}
```

成功响应中的 `toolResult.data.imageData` 是可作为多模态图片输入的 `data:image/jpeg;base64,...`；同时提供 `cameraId`、`mimeType`、`timestamp`、`source` 和 `bytes`。救援车视角使用 `rescue-cam-01`。浏览器必须保持页面打开，服务端才会有最新帧。该图像来自 Three.js 仿真渲染，不是真实硬件摄像头；AGH 适配器仍需把 `imageData` 转换成其模型 API 所需的图片输入格式。

## 模型、测试与日志

- 模型信息、版本与调用方式见 `MODEL_NOTES.md`（Agnes 3.0 Flash，`agnes-3.0-flash`）。
- AGH 执行日志说明与三条测试对照见 `AGH_LOG_NOTES.md`。
- 三条测试（正常 / 边界 / 失败）可用以下任一脚本运行，结果追加到 `agh_execution_log.jsonl`：
  - `node agh_three_scenario_test.mjs`（自启服务）
  - `python test_agh.py`（需先启动服务，可用 `BASE_URL` 覆盖地址）
- C2 决策链（12 步完整流程，C4 结构化日志）：`node agh_decision_chain.mjs`，结果追加到 `agh_decision_log.jsonl`。
- C3 动态变化（风高禁飞 / 低能见度开灯 / 诱导屏文案 / 路线封闭）：`node agh_c3_dynamic_test.mjs`，结果追加到 `agh_decision_log.jsonl`。
- C1 工具注册与行为校验（11 个命名工具 + 参数拒绝）：`node test_c1_tools.mjs`。

## 代码验证说明

生成时本机命令和 Node 执行工具发生初始化故障，尚未实际运行服务或完成浏览器验收。请按人工验收步骤检查；不要将此版本标为已测试或已接入 AGH。
