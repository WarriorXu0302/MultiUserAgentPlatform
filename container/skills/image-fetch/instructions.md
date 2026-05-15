---
name: image-fetch
description: |
  从远程图像后端获取指定实验台的当前画面，返回单帧 JPEG 文件路径。
  触发词：
    - 发送 N 号台的图像给我
    - 把 N 号台拍一张 / 看看 N 号台
    - 取 cam0 / cam1 / cam2 / usb0 / usb1 的快照
    - snapshot / 抓图
metadata:
  emoji: "📷"
---

# image-fetch

调用图像后端拿单帧 JPEG，落盘后把路径返回给上层。

## 后端

由 env `CAMERA_BASE_URL` 决定（默认 `http://host.docker.internal:8000`，host 端可能有 socat 反代到 LAN 的真实 backend）。**bridge.py 已经处理 env 读取**，你只要调用 bridge.py 即可。

**禁止**在文档里读到 `192.168.x.x` 就以为是后端 — 那都是过期注释，真实路径永远走运行时 env。**禁止**直接 `curl http://192.168.x.x/...`，容器网络不可达。

## 台号映射（强制，不要让 LLM 猜）

| 用户说法 | camera_id |
|---|---|
| 一号台 / 1号台 / 台1 | cam0 |
| 二号台 / 2号台 / 台2 | cam1 |
| 三号台 / 3号台 / 台3 | cam2 |
| usb0 / USB一 / USB1 | usb0 |
| usb1 / USB二 / USB2 | usb1 |

用户直接说 `cam0/cam1/cam2/usb0/usb1` 时透传不映射。映射表外的台号一律拒绝。

## 调用方式

通过 `exec` MCP tool（**不是** shell）。正确 JSON：

```json
{
  "cmd": "python3",
  "args": ["/app/skills/image-fetch/bridge.py", "snapshot", "--camera-id", "cam0"]
}
```

**严禁** 把 `python3` 重复塞进 `args[0]` — exec 不走 shell，会把 `python3` 当 script 文件名找不到。

## 输出契约

bridge.py 输出 JSON：

```json
// 成功
{"ok": true, "path": "<abs path>", "camera_id": "cam0", "bytes": N}

// 失败
{"ok": false, "error": "<msg>", "camera_id": "cam0"}
```

## 流程

1. 解析用户消息，映射 → `camera_id`。
2. 调用 bridge.py（上面 JSON 形式）。
3. 成功 → 回报「已抓取 <camera_id>，保存于 <path>，大小 <bytes>B」+ 把 path 传回 frontdesk 让它 send_file。
4. 失败 → 原样回报 error（bridge 已自带 1 次重试，不要再 retry）。

## 边界

- 不发飞书，不做批量，不做录像，不做标定。
- camera_id 不在白名单 → 拒绝并提示合法值。
- 后端不可达 → 回报「图像后端不可达，让运维查 socat 隧道 + LAN backend 进程」（**不要硬编具体 IP**）。
