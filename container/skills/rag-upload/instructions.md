---
name: rag-upload
description: RAG 知识库管理技能，负责文档的写入、更新、删除等管理操作。触发场景：用户说"上传到知识库"、"删除文档"、"更新知识库"、"管理知识库内容"、"把这个存进知识库"等写入/管理类动作。注意：查询类问题（如"如何做 X"、"X 的步骤"）不归本 skill，应由 remote-rag-expert 处理。
metadata:
  emoji: "📚"
---

# RAG 知识库操作规范

主要操作走 `exec` MCP tool（**不是** shell）。正确 JSON 形式：

```json
{
  "cmd": "python3",
  "args": ["/app/skills/rag-upload/bridge.py", "<action>", "<...flags>"]
}
```

**严禁** 把 `python3` 重复塞进 `args[0]` — exec 不走 shell，会把 `python3` 当 script 文件名找不到。

默认 RAG 后端是 `http://host.docker.internal:7001`（容器内）；可通过 env `RAG_BASE_URL` 覆盖。

## bridge.py 支持的 action

下面用 shell 表示法描述参数顺序，实际调用要按上面 JSON 形式拆 args 数组。

```bash
# 1. 添加短文本到知识库（无文件）
python3 /app/skills/rag-upload/bridge.py add --text "<纯文本内容>" [--doc-id <自定义ID>]

# 2. 上传文档文件
python3 /app/skills/rag-upload/bridge.py upload --file <FILE_PATH>

# 3. 重新上传（必须显式传 --doc-id；上游无 list-all 端点）
python3 /app/skills/rag-upload/bridge.py reupload --file <FILE_PATH> --doc-id <OLD_DOC_ID>

# 4. 删除指定文档（可选 --file 同步删本地文件）
python3 /app/skills/rag-upload/bridge.py delete --doc-id <DOC_ID> [--file <FILE_PATH>]

# 5. 搜索（与 remote-rag-expert 同源；通常归 remote-rag-expert 用）
#    stdout 命中 = 文本；未命中 = '__RAG_NO_HIT__: ...'；错误 = '__RAG_ERROR__: ...'
python3 /app/skills/rag-upload/bridge.py search --query "<query>" [--limit 3]
```

## 上游 API 端点（认 OpenAPI 为准）

| 操作 | 方法 | 端点 |
|------|------|------|
| 添加文本 | POST | `/api/knowledge/add` |
| 上传文件 | POST | `/api/knowledge/upload` (multipart) |
| 搜索 | POST | `/api/knowledge/search` |
| 删除 | DELETE | `/api/knowledge/document/{doc_id}` （**单数**） |

**注意**：上游**没有 list-all 端点**。不要尝试 list/index 一类的 action — bridge.py 也不接受。

## 注意事项

- 文件必须在容器可见路径下（`/workspace/...` 或 mount 进来的）
- `reupload` 必须显式传 `--doc-id`；无法靠文件名自动查找
- `delete` 不带 `--file` 时只清 RAG 后端记录，不动本地文件
- doc_id 由 RAG 后端返回，agent 在 reply 里要回传给 frontdesk 以便后续操作
