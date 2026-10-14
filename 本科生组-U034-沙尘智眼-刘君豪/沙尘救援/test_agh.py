#!/usr/bin/env python3
"""AGH 三场景测试：正常、边界、失败。

用法：
  1. 先启动服务（node server.mjs 或 start.cmd）
  2. 运行本脚本：python test_agh.py
  3. 脚本会自动完成正常/边界/失败三条测试，打印 PASS/FAIL。

配置说明：
  URL  — 服务地址，默认 http://127.0.0.1:8787（与 start.cmd 一致）。
  BASE_URL 环境变量可覆盖（例如 http://127.0.0.1:9000）。
  requests  — 需已安装：pip install requests
"""
import json
import os
import sys
import time
from datetime import datetime, timezone

try:
    import requests
except ImportError:
    print("请先安装 requests：pip install requests")
    sys.exit(1)

URL = os.environ.get("BASE_URL", "http://127.0.0.1:8787")
# 测试用 1×1 像素 PNG
TEST_PNG = "data:image/png;base64,iVBORw0KGgo="


def post(path, body=None, headers=None):
    """POST 并返回 (status_code, json_body)。"""
    r = requests.post(URL + path, json=body, headers=headers or {}, timeout=10)
    try:
        data = r.json()
    except Exception:
        data = {"_raw": r.text}
    return r.status_code, data


def wait_for_server(timeout=8):
    """轮询 /api/tools 直到服务就绪。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = requests.get(URL + "/api/tools", timeout=1)
            if r.ok:
                return True
        except requests.exceptions.ConnectionError:
            pass
        time.sleep(0.2)
    return False


def _ts():
    return datetime.now(timezone.utc).isoformat()


# ===== 场景 1：正常（get_camera_frame）=====
def test_normal():
    print("[normal] 上传测试帧...")
    _, up = post("/api/camera-frame",
                 {"cameraId": "drone-cam-01", "imageData": TEST_PNG, "source": "test-normal"})
    if not up.get("frame", {}).get("ok"):
        print(f"[normal] FAIL：帧上传失败 {up}")
        return False

    print("[normal] 调用 get_camera_frame...")
    status, data = post("/api/tool",
                        {"name": "get_camera_frame", "cameraId": "drone-cam-01"})
    image = data.get("toolResult", {}).get("data", {}).get("imageData")
    ok = status == 200 and image is not None
    print(f"[normal] {'PASS' if ok else 'FAIL'}：status={status}, mimeType={data.get('toolResult', {}).get('data', {}).get('mimeType')}")
    return ok


# ===== 场景 2：边界（未知摄像头 ID）=====
def test_boundary():
    print("[boundary] 调用 get_camera_frame（ghost-cam-01，预期 409）...")
    status, data = post("/api/tool",
                        {"name": "get_camera_frame", "cameraId": "ghost-cam-01"})
    ok = status == 409 and "error" in data
    print(f"[boundary] {'PASS' if ok else 'FAIL'}：status={status}, error={data.get('error')}")
    return ok


# ===== 场景 3：失败（低能见度时 dispatch_drone）=====
def test_failure():
    print("[failure] 设置沙尘等级 5（能见度 < 150m）...")
    status, _ = post("/api/control", {"level": 5})
    time.sleep(1.1)  # 等服务端 tick 生效

    print("[failure] 调用 dispatch_drone（预期 409 安全约束拒绝）...")
    status, data = post("/api/tool", {"name": "dispatch_drone"})
    ok = status == 409 and "error" in data
    print(f"[failure] {'PASS' if ok else 'FAIL'}：status={status}, error={data.get('error')}")

    # 恢复环境
    post("/api/control", {"reset": True})
    return ok


def main():
    print(f"目标：{URL}\n")

    if not wait_for_server():
        print("服务未就绪，请先运行 node server.mjs（或 start.cmd）")
        sys.exit(1)

    results = {}
    results["normal"] = test_normal()
    results["boundary"] = test_boundary()
    results["failure"] = test_failure()

    passed = sum(1 for v in results.values() if v)
    print(f"\n===== 结果：{passed}/{len(results)} 通过 =====")
    for name, ok in results.items():
        print(f"  {name:10s} {'PASS' if ok else 'FAIL'}")

    # 写入 agh_execution_log.jsonl
    log_file = os.path.join(os.path.dirname(__file__), "agh_execution_log.jsonl")
    try:
        with open(log_file, "a", encoding="utf-8") as f:
            for name, ok in results.items():
                f.write(json.dumps({
                    "timestamp": _ts(),
                    "scenario": name,
                    "script": "test_agh.py",
                    "model": "agnes-3.0-flash",
                    "status": "ok" if ok else "fail",
                }) + "\n")
        print(f"执行记录已追加到：{log_file}")
    except Exception as e:
        print(f"写入日志失败（不影响测试结果）：{e}")

    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
