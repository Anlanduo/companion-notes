// 探针 runner v3（2026-11-08）
// v2 只看"场景前缀"，v3 改成真正加载场景上下文文件，并加安全阀：
//   --dry-run        只打印报文，不联网
//   缺 ctx 文件      默认拒绝运行（负控会结构性假通过）
//   状态码非 2xx     记为错误，不当成模型回答
//   429/5xx          重试（最多 3 次，指数退避）
//   results/         结果落盘，不进仓库（.gitignore）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(fs.readFileSync(path.join(here, 'control.json'), 'utf8'));
const DRY = process.argv.includes('--dry-run');

const ENDPOINT = process.env.PROBE_ENDPOINT || '';
const KEY = process.env.PROBE_KEY || '';
const MODEL = process.env.PROBE_MODEL || '';
const CTX_DIR = process.env.PROBE_CONTEXT_DIR || path.join(here, 'ctx');
const SYSTEM_FILE = process.env.PROBE_SYSTEM_FILE || path.join(CTX_DIR, 'system.txt');
const ALLOW_MISSING = process.env.PROBE_ALLOW_MISSING_CONTEXT === '1';
const SEED = Number(process.env.PROBE_SEED || 42);

const readIf = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } };

if (!DRY && (!ENDPOINT || !KEY || !MODEL)) {
  console.error('缺环境变量：PROBE_ENDPOINT / PROBE_KEY / PROBE_MODEL（先 --dry-run 看报文）');
  process.exit(2);
}

const system = readIf(SYSTEM_FILE) || '你在扮演一个角色。按角色会说的话回答，不要解释你在做什么。';
const ctxCache = {};
const ctxOf = (name) => {
  if (name in ctxCache) return ctxCache[name];
  const file = path.join(CTX_DIR, `${name}.txt`);
  const text = readIf(file);
  ctxCache[name] = { text, file, ok: Boolean(text) };
  return ctxCache[name];
};

const missing = new Set();
for (const item of spec.items) if (!ctxOf(item.context || 'private').ok) missing.add(item.context || 'private');
if (missing.size && !ALLOW_MISSING) {
  console.error(`缺场景上下文：${[...missing].map((n) => `ctx/${n}.txt`).join('、')}`);
  console.error('负控在没有上下文时必然"通过"，那是结构性假通过。补齐后再跑。');
  console.error('（非要诊断：PROBE_ALLOW_MISSING_CONTEXT=1，但结果不能当隔离证据）');
  process.exit(3);
}
if (missing.size && ALLOW_MISSING) {
  console.warn(`⚠ 缺 ${[...missing].join('、')}，按允许缺失继续——结果只能作诊断，不能当隔离证据`);
}

const build = (item) => {
  const ctx = ctxOf(item.context || 'private').text;
  const parts = [];
  if (ctx) parts.push(`【当前上下文】\n${ctx}`);
  parts.push(`【提问】${item.question}`);
  return parts.join('\n\n');
};

const send = async (content) => {
  const t0 = Date.now();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        seed: SEED,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content },
        ],
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 3) { await new Promise((r) => setTimeout(r, attempt * 1500)); continue; }
    }
    const text = await res.text();
    if (!res.ok) return { answer: '', error: `HTTP ${res.status} ${text.slice(0, 120)}`, ms: Date.now() - t0 };
    let j = null;
    try { j = JSON.parse(text); } catch { return { answer: '', error: '响应不是 JSON', ms: Date.now() - t0 }; }
    const answer = j?.choices?.[0]?.message?.content ?? '';
    return { answer: String(answer).replace(/\s+/g, ' ').trim(), usage: j?.usage || null, ms: Date.now() - t0 };
  }
  return { answer: '', error: '重试耗尽', ms: Date.now() - t0 };
};

const rows = [];
for (const item of spec.items) {
  const content = build(item);
  if (DRY) {
    console.log(`\n=== ${item.id} ${item.axis}（context=${item.context}）===\n[system]\n${system}\n\n[user]\n${content}`);
    continue;
  }
  process.stdout.write(`${item.id} ${item.axis} … `);
  try {
    const r = await send(content);
    console.log(r.error ? `错误：${r.error}` : r.answer.slice(0, 60));
    rows.push({ ...item, contextText: ctxOf(item.context || 'private').text, answer: r.answer, error: r.error || '', usage: r.usage, ms: r.ms, model: MODEL, temperature: 0, seed: SEED });
  } catch (e) {
    console.log('失败：' + (e?.message ?? e));
    rows.push({ ...item, answer: '', error: String(e?.message ?? e) });
  }
}

if (DRY) { console.log('\n（dry-run：没有联网，没有写入结果）'); process.exit(0); }

const outDir = path.join(here, 'results');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = path.join(outDir, `probe-${stamp}.json`);
fs.writeFileSync(out, JSON.stringify({ at: Date.now(), model: MODEL, endpoint: ENDPOINT, ctxDir: CTX_DIR, rows }, null, 1), 'utf8');

console.log('\n题号 | 类型 | 场景 | 回答（截断） | 该判成什么（人工填）');
console.log('---|---|---|---|---');
for (const r of rows) console.log(`${r.id} | ${r.kind} | ${r.context} | ${(r.answer || r.error || '').slice(0, 36)} | 通过 / 失败`);
console.log(`\n结果：${out}`);
console.log('判分对照 control.json 的 expect / fail —— 脚本不替你判。');
