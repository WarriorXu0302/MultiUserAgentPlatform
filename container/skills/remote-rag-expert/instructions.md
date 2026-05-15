---
name: remote-rag-expert
description: 【查询类问题优先调用】科研知识查询专家，用于回答实验室 SOP、化学实验步骤、氧气制取、学术知识、实验室操作规程等专业查询问题。触发场景：用户询问"如何进行 X 实验"、"X 的步骤是什么"、"X 的操作规程"、"X 原理"等任何查询类问题。本 skill 通过 RAG 检索实验室知识库并返回权威答案。收到此类问题时必须先调用本 skill，禁止直接用内置知识回答。
metadata:
  emoji: "🔬"
---

# 科研助手技能操作规范

## 运行流程

调用 `exec` MCP tool（**不是** shell！）。正确 JSON 形式：

```json
{
  "cmd": "python3",
  "args": ["/app/skills/remote-rag-expert/bridge.py", "<user_query>"]
}
```

**严禁** 把 `python3` 重复塞进 `args[0]`（会变成 `python3 python3 ...`，python 把 `python3` 当 script 文件名找不到，exit 2，看着像"未命中"实际是命令错）。

默认 RAG 后端是 `http://host.docker.internal:7001`（容器内）；可通过 env `RAG_BASE_URL` 覆盖。

## stdout / exit code 判读契约（必读）

bridge.py 用 **stdout marker** 区分 hit/miss/error，**不**用 exit code 区分 hit vs miss：

| 情况 | exit | stdout 开头 | 你应该 |
|---|---|---|---|
| **命中** | 0 | 直接是检索文本（前 N 个片段） | 按"结果二次加工要求"整理后回 frontdesk |
| **未命中** | 0 | `__RAG_NO_HIT__: ...` | 明确告知 frontdesk "本地 RAG 未命中"。**禁止**用模型训练知识冒充 RAG 结果。**禁止**自己改用 web_fetch 降级 |
| **后端异常** | 1 | `__RAG_ERROR__: ...` | 上报 "RAG 服务不可达 + 错误原因"，让 frontdesk 通知管理员。不要自己降级 |

判读优先看 stdout 文本，不要看 exit code：未命中和命中都是 exit 0，唯一区分就是 `__RAG_NO_HIT__` marker。

## 结果二次加工要求

拿到原始回答后：

1. **通俗化处理**：复杂化学方程式 / 专业术语后面附简单"白话解释"。
2. **格式排版**：用 Markdown 列表（1./2./3.）让步骤清晰。
3. **固定后缀**：回答最后另起一行加："💡 本回复基于实验室 RAG 知识库"。
4. **保留原数据**：禁止直接透传原始 JSON；但**必须保留核心步骤、参数、安全注意事项**原文。

## 注意事项

- 优先级：本地 RAG > 模型自身知识。仅在 RAG exit 2 且 frontdesk 显式允许时才用模型知识补充。
- 化学/实验类查询，"安全注意事项"段必须完整保留，不得为了简洁删掉。
