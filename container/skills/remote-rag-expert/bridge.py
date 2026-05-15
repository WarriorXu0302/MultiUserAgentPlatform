#!/usr/bin/env python3
"""
Remote RAG Expert — queries the RAG server resolved by $RAG_BASE_URL.

Default is `http://host.docker.internal:7001` because nano agents run in a
container; "localhost" inside the container is the container itself, not the
host. Operators can override via container.json env or by exporting
RAG_BASE_URL in the runtime environment. Schema documented at
{RAG_BASE_URL}/openapi.json.
"""
import os
import requests
import sys

BASE_URL = os.environ.get("RAG_BASE_URL", "http://host.docker.internal:7001")
NO_PROXY = {"http": None, "https": None}
TIMEOUT = 30


def call_rag(query, limit=3):
    """Query RAG and print result to stdout.

    Exit code contract (LLM-friendly):
      - exit 0: bridge ran cleanly. Inspect stdout for content:
                  * '__RAG_NO_HIT__' prefix → knowledge base had no match;
                  * anything else → real search result text.
      - exit 1: backend unreachable / HTTP error. stdout has '__RAG_ERROR__: <reason>'.

    Rationale for unifying hit/miss into exit 0: python interpreter itself
    returns exit 2 when it can't open the script file, which made downstream
    LLMs (MiniMax chat-completions) mis-classify their own bad `python3
    python3 …` invocations as "RAG miss" and silently fall back to web search.
    Forcing miss/hit through a stdout marker removes that ambiguity.
    """
    try:
        resp = requests.post(
            f"{BASE_URL}/api/knowledge/search",
            json={"query": query, "limit": limit},
            proxies=NO_PROXY,
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        answer = (data.get("result") or "").strip()
        if answer:
            print(answer)
        else:
            print(f"__RAG_NO_HIT__: 本地 RAG 知识库未检索到与 query={query!r} 相关的内容")
    except Exception as e:
        print(f"__RAG_ERROR__: RAG 后端不可达或返回错误: {e}")
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        call_rag(sys.argv[1])
    else:
        sys.exit("usage: bridge.py <query>")
