# AGH 执行日志与测试说明

## 日志文件
| 文件 | 内容 |
|------|------|
| `episodes.jsonl` | 每轮任务结束的汇总指标（耗时、人工/AGH 调用次数、成败）。由 `server.mjs` 自动追加。 |
| `agh_execution_log.jsonl` | 完整 AGH 轨迹：模型观察、工具调用、图像返回、模型决策、下一步动作。由各测试脚本追加。 |

## 记录字段（agh_execution_log.jsonl）
每行一条 JSON 对象：
- `timestamp` — 记录时间（UTC ISO）
- `scenario` — `normal` / `boundary` / `failure`（三场景测试脚本写入）；demo 脚本无此字段
- `script` — 产生该记录的脚本名
- `model` / `modelVersion` — 模型标识（`agnes-3.0-flash` / `3.0`）
- `modelObservation` — 模型初始观察与上下文
- `toolCalls[]` — 工具调用（`tool`、`params`、`httpStatus`、`error`、`timestamp`）
- `imageReturns[]` — 图像返回（`cameraId`、`mimeType`、`bytes`、`imageData`、`verification`）
- `modelDecision` — 模型推理、决策、下一步动作
- `executionTrace[]` — 逐步状态
- `status` — 最终 `ok` / `fail`

## 模型信息
见 [`MODEL_NOTES.md`](./MODEL_NOTES.md)。

## 运行方式
前提：安装 Node.js 与 Python 3（含 `requests`）。

```bash
# 方式 A：Node 三场景测试（自启服务、自关服务）
node agh_three_scenario_test.mjs

# 方式 B：Node 摄像头帧演示（自启服务、写一条完整轨迹）
node agh_camera_frame_demo.mjs

# 方式 C：Python 三场景测试（需先手动启动服务）
start.cmd            # 或 node server.mjs，保持终端开启
python test_agh.py   # 三条：normal / boundary / failure
```

## 三条测试记录对照
| 场景 | 工具 | 输入 | 预期 | 实际 |
|------|------|------|------|------|
| normal | `get_camera_frame` | `drone-cam-01`（已上传测试帧） | HTTP 200，返回 `imageData` | PASS |
| boundary | `get_camera_frame` | `ghost-cam-01`（未知 ID） | HTTP 409，`error=未知摄像头 ID` | PASS |
| failure | `dispatch_drone` | 沙尘等级 5（能见度 < 150m） | HTTP 409，`error=仿真安全约束` | PASS |

## test_agh.py 配置
- 默认地址 `http://127.0.0.1:8787`，可用环境变量 `BASE_URL` 覆盖。
- 依赖 `requests`（`pip install requests`）。
- 自动轮询 `/api/tools` 等待服务就绪（8s 超时）。
- 完成后向 `agh_execution_log.jsonl` 追加三条 scenario 记录，并按通过与否设置退出码（0/1）。
- Windows 控制台若出现中文乱码，用 `python -X utf8 test_agh.py` 运行。
