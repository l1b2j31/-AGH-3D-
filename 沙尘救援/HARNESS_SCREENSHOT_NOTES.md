# Harness 执行截图证据

## 截图来源
本次 AGH 会话中，`computer_use` 工具在启动 Edge 时返回了 Harness 轨迹页截图。截图内容为 Agnes Harness 的“轨迹”标签页，可见以下内容：

- 会话标题：调试沙尘救援3项目
- 状态：正在执行 · 执行工具
- 工具调用记录：shell、read、computer_use 等
- 工具返回：图像帧数据、工具调用结果、决策写入等

## 截图文件位置
`computer_use` 返回的截图 artifact：
- artifact ID: `b80c164c22456a329cdea73ff5476629ace1eb8bb22ed0781d37d4d8820ab1f1`
- 会话：`aghs-camera-frame-demo`
- 时间：2026-10-14T11:22:14Z 前后

## 说明
本包不包含将 Harness 截图另存为独立 PNG 的脚本。如需导出，可从 Agnes Harness 轨迹页直接“另存为”截图。截图内容证明模型实际调用 AGH 工具（`computer_use`、`shell`、`read`、`write`、`edit`）并接收返回结果。

## 与 AGH 执行日志的关系
- Harness 截图 = 可视化执行轨迹（人工检查用）
- `agh_execution_log.jsonl` = 机器可读执行记录（自动化验证用）
- 两者互补：截图展示“发生了什么”，日志展示“参数和返回值是什么”。
