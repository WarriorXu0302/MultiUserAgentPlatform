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

> **Canonical doc is `instructions.md`** — it's what nano fragment compose loads into the LLM prompt. This SKILL.md is a human-readable mirror; if they disagree, instructions.md wins.

# ppe-recheck

PPE 复检 skill：bridge.py 抓 PTZ 帧 → LLM 多模态看图 → 给出文字回复。

后端地址由 **env `CAMERA_BASE_URL`** 决定（默认 `http://host.docker.internal:18001`，host 端 socat 反代到 LAN 的 uvicorn）。文档里**不再硬编**任何 `192.168.x.x` IP — 真实路径永远走运行时 env。

## 调用

通过 `exec` MCP tool，**不是** shell：

```json
{ "cmd": "python3", "args": ["/app/skills/ppe-recheck/bridge.py", "snapshot"] }
```

bridge.py 已经处理：从 env 读后端 → GET /api/v1/ptz-tracker/snapshot → 落盘 → 输出 JSON。

## 输出契约

```json
// 成功
{"ok": true, "path": "/app/skills/ppe-recheck/output/ppe/<source>_<ts>.jpg", "source": "opencv:0|opencv:1", "bytes": N}

// 失败
{"ok": false, "error": "<HTTP code | timeout | 503 PTZ not ready>"}
```

## 流程

1. 用上面 JSON 调用 bridge.py。
2. 拿到 `path` → `read` 工具加载（多模态进对话）。
3. LLM 看图判断画面里的人有没有穿**白色实验服 / lab coat / 白大褂**。不评估护目镜/手套/口罩。
4. 回 frontdesk：
   - 穿了 → `✅ 已检测到实验服，可以继续实验。`
   - 没穿/不确定 → `⚠️ 未检测到实验服，请穿戴后再确认。`
   - 画面没人 → `⚠️ 画面中没有人，云台可能未追到人，请站到摄像头前再确认。`

## 失败模式

| bridge.py 输出 | 含义 | 你应该 |
|---|---|---|
| `ok=true` | 拿到 JPEG | 走判断流程 |
| `ok=false, error=...503...` | PTZ tracker service 没起 | 回 frontdesk「PTZ 服务未启动」 |
| `ok=false, error=...timed out...` | 后端不可达 | 回 frontdesk「PTZ 后端不可达，让运维查 socat 隧道 + LAN uvicorn 进程」 |

## 硬性禁止

- ❌ 直接 `curl http://192.168.x.x/...`（容器网络不可达；任何硬编 IP 都是过期文档）
- ❌ 跳过 bridge.py 自己尝试 HTTP 请求
- ❌ 看不清就硬猜结论 — 失败就报失败
- ❌ 不评估手套/护目镜/口罩
