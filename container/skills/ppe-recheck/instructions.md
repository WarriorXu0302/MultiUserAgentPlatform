---
name: ppe-recheck
description: |
  PPE 复检：抓 PTZ 跟踪服务当前一帧（云台自动追人，源 = 本机摄像头），让 LLM 多模态看图判断是否穿了实验服（白大褂）。
  触发词：
    - 已穿好 / 穿好了 / 已戴好 / 防护到位
    - 请重新检测 / 重新检测 / 重新检测 PPE / PPE OK
  仅判断实验服（白大褂），不判断手套/护目镜。
metadata:
  emoji: "🦺"
---

# ppe-recheck

PPE 复检 skill。流程：bridge.py 抓 PTZ 一帧 → LLM 多模态看图判断 → 给出文字回复。

## 后端

由 env `CAMERA_BASE_URL` 决定（默认 `http://host.docker.internal:18001`，host 端 socat 反代到 Windows uvicorn `ptz_service`）。

**不要**在文档里读到任何 `192.168.x.x` IP 就以为是后端 — 真实路径**永远**由运行时 env 决定。**禁止**直接 `curl http://192.168.x.x/...` —— 那条路径在容器网络下永远不可达。

## 调用方式（必须走 bridge.py）

正确 JSON 形式（**exec** MCP tool）：

```json
{
  "cmd": "python3",
  "args": ["/app/skills/ppe-recheck/bridge.py", "snapshot"]
}
```

**严禁** 把 `python3` 重复塞进 `args[0]` — exec 不走 shell，会把 `python3` 当 script 文件名找不到。

输出 JSON：
- 成功：`{"ok": true, "path": "<abs path>", "source": "opencv:0|opencv:1", "bytes": N}`
- 失败：`{"ok": false, "error": "<msg>"}`

bridge.py 内部已经处理：
- 网络层（容器走 `host.docker.internal` → Mac socat → Windows uvicorn）
- 重试逻辑（5xx 重试一次）
- 文件落盘（`/app/skills/ppe-recheck/output/ppe/<source>_<ts>.jpg`）

你只需要解释 stdout JSON。

## 流程

1. **抓图**：调用上面的 exec 形式。
2. **读图**：从 JSON 拿 `path` → `read` 工具加载（多模态进对话）。
3. **判断**：LLM 看图回答这一个问题——画面里的人穿了**白色实验服 / lab coat / 白大褂**吗？不评估护目镜/手套/口罩。
4. **回复 frontdesk**（`<message to="frontdesk">...</message>`）：
   - 穿了 → `✅ 已检测到实验服，可以继续实验。`
   - 没穿/不确定 → `⚠️ 未检测到实验服，请穿戴后再确认。`
   - 画面没人 → `⚠️ 画面中没有人，云台可能未追到人，请站到摄像头前再确认。`

## 失败模式（按 exit code + stdout 判断）

| 情况 | bridge.py 输出 | 你应该 |
|---|---|---|
| 后端 200 + JPEG | `{"ok": true, ...}` | 走"读图 + 判断"流程 |
| 后端 503 PTZ tracker 没起 | `{"ok": false, "error": "HTTP 503 ... PTZ tracker service unavailable"}` | 回 frontdesk 报"PTZ 跟踪服务未启动" |
| 后端不可达 | `{"ok": false, "error": "...timed out..."}` | 回 frontdesk 报"PTZ 后端不可达，让运维检查 socat 隧道 + Windows uvicorn 进程" |

**永远不要伪造检测结果**。bridge.py 没成功就说"未能取到图像"，不要假装通过让用户继续操作硬件。

## 硬性禁止

- ❌ 直接 `curl` 硬编 IP（任何 `192.168.x.x` 都属于过期文档，真实路径走 env）
- ❌ 跳过 bridge.py 自己尝试 HTTP 请求
- ❌ 看不清就硬猜结论
