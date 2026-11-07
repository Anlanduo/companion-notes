// 探针 runner v2（2026-11-07 修订）
// 只做机器该做的：发问、记录、排版。判分留给人。
//
// 用法：
//   export PROBE_ENDPOINT="https://api.example.com/v1/chat/completions"
//   export PROBE_KEY="sk-..."
//   export PROBE_MODEL="your-model"
//   node probes/run.mjs                 # 正常跑
//   node probes/run.mjs --dry-run       # 只打印将要发出去的完整报文，不联网
//
// 可选：
//   PROBE_SYSTEM_FILE=path   用真实线上 system prompt 文件覆盖内置的两句（保真度关键）
//   PROBE_CONTEXT_FILE=path  追加一段"当前上下文"块，模拟线上记忆段/未读队列
//   PROBE_CONTEXT_DIR=dir    按题目 scene 取上下文：<dir>/group.txt、<dir>/private.txt
//                            —— 负控只有这样才能"成立"：先证明 private 场景下答得出，再证明 group 场景下答不出
//   PROBE_ALLOW_MISSING_CONTEXT=1  场景文件缺失时仍然跑（默认拒绝，因为缺上下文时负控必然通过）
//   PROBE_TIMEOUT_MS=45000   单题超时
//   PROBE_RETRY=2            429/5xx 重试次数
//   PROBE_SEED=20261107      固定采样（服务端支持才生效，不支持会被忽略）
//   PROBE_TEMPERATURE=0      默认 0：探针要可复现，不要 0.7
//
// v2 相对 v1 改了什么（每条都对应一次"假通过"风险）：
//   1. fileURLToPath 取路径：v1 用 URL.pathname，中文/空格目录会被 percent-encode，直接崩
//   2. 检查 res.ok：v1 不看状态码，401 的错误体被当成"答案"记进结果——最典型的假通过
//   3. 超时 + 重试：v1 单题挂住会拖死整轮，且拿不到失败证据
//   4. temperature 默认 0 + 可选 seed：探针必须可复现
//   5. 支持 PROBE_SYSTEM_FILE / PROBE_CONTEXT_FILE：让题目跑在"线上同构"的提示词结构里
//   6. 结果落 results/ 子目录，并在 stdout 提醒加 .gitignore（v1 写在 probes/ 根，容易连测试词一起提交）
//   7. --dry-run：判分口径必须在跑之前写死，先看报文能避免"事后解释"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(fs.readFileSync(path.join(here, 'control.json'), 'utf8'));

const DRY = process.argv.includes('--dry-run');
const ENDPOINT = process.env.PROBE_ENDPOINT || '';
const KEY = process.env.PROBE_KEY || '';
const MODEL = process.env.PROBE_MODEL || '';
const TIMEOUT = Number(process.env.PROBE_TIMEOUT_MS || 45000);
const RETRY = Math.max(0, Number(process.env.PROBE_RETRY || 2));
const TEMPERATURE = Number(process.env.PROBE_TEMPERATURE || 0);
const SEED = process.env.PROBE_SEED ? Number(process.env.PROBE_SEED) : undefined;

const readIf = (p) => (p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const systemFile = readIf(process.env.PROBE_SYSTEM_FILE);
const contextFile = readIf(process.env.PROBE_CONTEXT_FILE);
const ctxDir = process.env.PROBE_CONTEXT_DIR || path.join(here, 'ctx');
const allowMissingCtx = process.env.PROBE_ALLOW_MISSING_CONTEXT === '1';

// 场景上下文：负控的价值全在这里。缺了它，"群里问不到私聊的事"是必然的——
// 因为上下文里根本没有那件事，跟隔离是否生效无关。
const contextFor = (item) => {
  if (!ctxDir) return contextFile;
  const scene = item.scene || 'private';
  const p = path.join(ctxDir, `${scene}.txt`);
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  if (allowMissingCtx) {
    console.log(`  ⚠ 缺 ${scene}.txt，本题上下文为空 → 负控必然通过，结果无信息量`);
    return '';
  }
  throw new Error(`缺少场景上下文 ${p}。缺上下文时负控必然通过，拒绝产出假结果。\n` +
    `（确要跑请设 PROBE_ALLOW_MISSING_CONTEXT=1，且别把结果当隔离证据）`);
};

const defaultSystem = [
  '你在扮演一个角色。下面会给出一段"当前上下文"，然后是一个提问。',
  '请只按角色会说的话回答，不要解释你在做什么。',
].join('\n');
const systemPrompt = systemFile || defaultSystem;

// ctxDir 模式下，scene 必须显式声明。缺省 private 会让"无场景"的题被塞进私聊上下文，
// 判分就从"没注入"悄悄变成"注入错了场景"——比缺文件更难发现。
if (ctxDir) {
  const noScene = spec.items.filter((i) => !i.scene);
  if (noScene.length) {
    console.error(`ctxDir 模式下每题必须显式写 scene，缺的是：${noScene.map((i) => i.id).join(', ')}`);
    console.error('（缺省的题会被塞进 private 上下文，判分基准就错了）');
    process.exit(3);
  }
}

// 配对完整性：正控和负控要指向同一个测试对象，否则"成对"只是口号。
const pairMap = new Map();
for (const it of spec.items) {
  if (!it.pair) continue;
  if (!pairMap.has(it.pair)) pairMap.set(it.pair, []);
  pairMap.get(it.pair).push(it);
}
const pairRows = [...pairMap.entries()].map(([name, its]) => ({
  name,
  ids: its.map((x) => x.id),
  hasPositive: its.some((x) => x.kind === 'positive'),
  hasNegative: its.some((x) => x.kind === 'negative'),
}));
const incomplete = pairRows.filter((p) => !p.hasPositive || !p.hasNegative);
console.log(`配对检查：${pairRows.length} 组，完整 ${pairRows.length - incomplete.length} 组，不完整 ${incomplete.length} 组`);
for (const p of pairRows) {
  console.log(`  ${p.name}: [${p.ids.join(', ')}] ${p.hasPositive ? '正控✓' : '正控✗'} ${p.hasNegative ? '负控✓' : '负控✗'}`);
}
if (incomplete.length) {
  console.log(`  → 不完整：${incomplete.map((p) => p.name).join(', ')}；这些组本轮只能作单向观察，不能当"该对隔离成立"的证据。`);
}
console.log('');

if (!DRY && (!ENDPOINT || !KEY || !MODEL)) {
  console.error('缺环境变量：PROBE_ENDPOINT / PROBE_KEY / PROBE_MODEL');
  console.error('（只想看报文：node probes/run.mjs --dry-run）');
  console.error('（只想手工跑：把每题 setup + question 拼起来当一次提问即可）');
  process.exit(2);
}

const buildMessages = (item) => {
  const parts = [];
  const ctx = contextFor(item);
  if (ctx && ctx.trim()) parts.push(ctx.trim());
  if (item.setup) parts.push(item.setup);
  parts.push(`【提问】${item.question}`);
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: parts.join('\n\n') },
  ];
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const postOnce = async (messages) => {
  const body = { model: MODEL, messages };
  body.temperature = TEMPERATURE;
  if (SEED !== undefined) body.seed = SEED;
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('响应不是 JSON：' + text.slice(0, 200)); }
  const c = j?.choices?.[0]?.message?.content;
  const answer = Array.isArray(c)
    ? c.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('')
    : (c ?? '');
  if (!answer) throw new Error('响应里没有 choices[0].message.content：' + text.slice(0, 200));
  return { answer: String(answer).replace(/\s+/g, ' ').trim(), usage: j?.usage ?? null };
};

const ask = async (item) => {
  const messages = buildMessages(item);
  if (DRY) {
    return { answer: '(dry-run，未发送)', ms: 0, messages };
  }
  const t0 = Date.now();
  let lastErr;
  for (let attempt = 0; attempt <= RETRY; attempt++) {
    try {
      const r = await postOnce(messages);
      return { ...r, ms: Date.now() - t0, attempts: attempt + 1 };
    } catch (e) {
      lastErr = e;
      const retryable = e?.status === 429 || (e?.status >= 500 && e?.status < 600) || e?.name === 'TimeoutError';
      if (!retryable || attempt === RETRY) break;
      await sleep(700 * (attempt + 1));
    }
  }
  throw lastErr;
};

const rows = [];
for (const item of spec.items) {
  process.stdout.write(`${item.id} ${item.axis} … `);
  try {
    const r = await ask(item);
    console.log(DRY ? '(dry-run)' : r.answer.slice(0, 60));
    if (DRY) {
      console.log(JSON.stringify(r.messages, null, 1));
      rows.push({ ...item, answer: '', ms: 0, dryRun: true });
    } else {
      rows.push({ ...item, answer: r.answer, ms: r.ms, attempts: r.attempts, usage: r.usage });
    }
  } catch (e) {
    console.log('失败：' + (e?.message ?? e));
    rows.push({ ...item, answer: '', error: String(e?.message ?? e) });
  }
}

if (DRY) {
  console.log('\n--dry-run 结束：报文在上面，未联网、未写结果文件。');
  console.log('对照每题的 expect / fail 先把判分口径写死，再跑真请求。');
  process.exit(0);
}

const outDir = path.join(here, 'results');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = path.join(outDir, `probe-results-${stamp}.json`);
const meta = {
  at: new Date().toISOString(),
  model: MODEL,
  temperature: TEMPERATURE,
  seed: SEED ?? null,
  systemPromptSource: systemFile ? 'PROBE_SYSTEM_FILE' : 'builtin',
  contextSource: ctxDir ? `PROBE_CONTEXT_DIR(${path.basename(ctxDir)})` : (contextFile ? 'PROBE_CONTEXT_FILE' : 'none'),
  specName: spec.name,
  specVersion: spec.version,
  pairCheck: pairRows.map((p) => ({ ...p })),
  pairIncomplete: incomplete.map((p) => p.name),
  // 保真度自检：直连模型跑出来的结论，不能直接当"线上隔离成立"的证据
  fidelityNote: (ctxDir || contextFile)
    ? '已注入场景上下文；正控需证明答得出，负控才算有意义'
    : '未注入场景上下文：负控必然通过，本次结果不含隔离证据',
};
fs.writeFileSync(out, JSON.stringify({ ...meta, rows }, null, 1), 'utf8');

console.log('\n题号 | 类型 | 回答（截断） | 该判成什么（人工填）');
console.log('---|---|---|---');
for (const r of rows) {
  console.log(`${r.id} | ${r.kind} | ${(r.answer || r.error || '').slice(0, 40)} | 通过 / 失败`);
}
console.log(`\n用时：${rows.map((r) => r.ms || 0).reduce((a, b) => a + b, 0)} ms（合计）`);
console.log(`原始记录：${out}`);
if (!ctxDir && !contextFile) {
  console.log('⚠ 未注入场景上下文：本次结果只证明"模型在被单一提问时会怎样"，不证明线上注入链路是隔离的。');
}
console.log('判分请对照 control.json 里的 expect / fail —— 脚本不替你判。');
console.log('提醒：results/ 要进 .gitignore，别把测试词连同结果一起提交。');
