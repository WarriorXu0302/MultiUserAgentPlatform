// One-shot test battery for migrated skills, knowledge category.
// Sends each prompt sequentially, waits for outbound seq to advance,
// captures timing + response + tool-trigger evidence from container logs.

const net = require('net');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SOCK = 'data/cli.sock';
const SESS_DIR = 'data/v2-sessions/ag-1778488029905-vpov75/sess-1778488612901-hbpu91';
const OUT_DB = path.join(SESS_DIR, 'outbound.db');
const FEISHU_TO = {
  channelType: 'feishu',
  platformId: 'feishu:p2p:ou_a01c96646f754c0da729d6ff3ee5557d',
  threadId: null,
};

const PROMPTS = [
  {
    id: 'K1',
    category: '论文搜索 (arxiv)',
    text: '帮我搜一下 2025 年 LLM safety / jailbreak 方向最有代表性的 3 篇论文，给出标题 + arxiv id + 一句话核心贡献。',
  },
  {
    id: 'K2',
    category: '学术综述 (semantic-scholar)',
    text: '在 Semantic Scholar 上 retrieval-augmented generation (RAG) 这个方向，过去半年最高引用的论文都做了什么？列前 3 篇。',
  },
  {
    id: 'K3',
    category: '业界热点 (websearch)',
    text: '帮我了解一下 2025 年 AI Agent 框架领域的最新进展，列 3-5 个最热门的项目或新发布。',
  },
  {
    id: 'K4',
    category: '主题论文清单',
    text: '我想做一个研究综述，主题是"长上下文模型评估"。帮我列出该方向最重要的 5 篇论文及一句话简介。',
  },
  {
    id: 'K5',
    category: '开放问题',
    text: '当前 LLM 在科学发现（drug discovery / materials science）领域的热点研究方向有哪些？给 3 个方向 + 各方向代表性工作。',
  },
];

function sqliteLatest() {
  const out = execSync(
    `sqlite3 "${OUT_DB}" "SELECT seq FROM messages_out ORDER BY seq DESC LIMIT 1;"`,
    { encoding: 'utf8' },
  ).trim();
  return parseInt(out, 10) || 0;
}

function sqliteRow(seq) {
  const out = execSync(
    `sqlite3 -separator '|||' "${OUT_DB}" "SELECT id, timestamp, content FROM messages_out WHERE seq = ${seq};"`,
    { encoding: 'utf8' },
  ).trim();
  const [id, ts, content] = out.split('|||');
  return { id, ts, content };
}

function inject(text) {
  return new Promise((resolve, reject) => {
    const s = net.connect(SOCK);
    s.on('connect', () => {
      s.write(JSON.stringify({ text, to: FEISHU_TO }) + '\n');
      setTimeout(() => s.end(), 500);
    });
    s.on('error', reject);
    s.on('close', resolve);
  });
}

async function waitForSeq(target, timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (sqliteLatest() >= target) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout waiting for seq ${target}`);
}

(async () => {
  const results = [];
  for (const p of PROMPTS) {
    console.error(`\n=== ${p.id}: ${p.category} ===`);
    const baseSeq = sqliteLatest();
    const sendTs = Date.now();
    await inject(p.text);
    try {
      // outbound rows come at even seq in this session pattern (assistant rows)
      await waitForSeq(baseSeq + 2);
    } catch (e) {
      console.error('TIMEOUT', e.message);
      results.push({ ...p, error: e.message, latency_ms: Date.now() - sendTs });
      continue;
    }
    const finishTs = Date.now();
    const replySeq = sqliteLatest();
    const row = sqliteRow(replySeq);
    let body = row.content;
    try { body = JSON.parse(row.content).text || row.content; } catch {}
    results.push({
      ...p,
      reply_seq: replySeq,
      reply: body,
      reply_msg_id: row.id,
      latency_ms: finishTs - sendTs,
    });
    console.error(`reply (${finishTs - sendTs}ms):`, body.slice(0, 200).replace(/\n/g, ' '));
    // small pause to keep things sequential and let any tool-status calm
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(JSON.stringify(results, null, 2));
})();
