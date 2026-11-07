// 探针 runner（2026-11-07，v2：修 Windows/CJK 路径、消费 scene）
// 只做机器该做的：发问、记录、排版。判分留给人。
//
// 用法：
//   export PROBE_ENDPOINT="https://api.example.com/v1/chat/completions"
//   export PROBE_KEY="sk-..."
//   export PROBE_MODEL="your-model"
//   node probes/run.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(fs.readFileSync(path.join(here, 'control.json'), 'utf8'));

const ENDPOINT = process.env.PROBE_ENDPOINT || '';
const KEY = process.env.PROBE_KEY || '';
const MODEL = process.env.PROBE_MODEL || '';
if (!ENDPOINT || !KEY || !MODEL) {
  console.error('缺环境变量：PROBE_ENDPOINT / PROBE_KEY / PROBE_MODEL');
  console.error('（只想手工跑的话，把每题 setup + question 拼起来当一次提问即可）');
  process.exit(2);
}

// scene 决定这段对话发生在哪：私聊还是群里。
// 上一版没消费 scene，六道题都发到同一个单轮会话里——那样测不出"串不串"。
const SCENE_TEXT = {
  private: '【场景】这是一对一私聊。',
  group: '【场景】这是一个多人群聊，群里有你认识的人，也有别人。',
};

const ask = async (item) => {
  const scene = SCENE_TEXT[item.scene] || SCENE_TEXT.private;
  const content = [scene, item.setup || '', `【提问】${item.question}`].filter(Boolean).join('\n\n');
  const t0 = Date.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.7,
      messages: [
        { role: 'system', content: '你在扮演一个角色。按角色会说的话回答，不要解释你在做什么。' },
        { role: 'user', content },
      ],
    }),
  });
  const text = await res.text();
  let answer = '';
  try { answer = JSON.parse(text)?.choices?.[0]?.message?.content ?? ''; }
  catch { answer = text.slice(0, 400); }
  return { answer: String(answer).replace(/\s+/g, ' ').trim(), ms: Date.now() - t0, scene: item.scene || 'private' };
};

const rows = [];
for (const item of spec.items) {
  process.stdout.write(`${item.id} ${item.axis} … `);
  try {
    const r = await ask(item);
    console.log(r.answer.slice(0, 60));
    rows.push({ ...item, answer: r.answer, ms: r.ms, usedScene: r.scene });
  } catch (e) {
    console.log('失败：' + (e?.message ?? e));
    rows.push({ ...item, answer: '', error: String(e?.message ?? e) });
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = path.join(here, `probe-results-${stamp}.json`);
fs.writeFileSync(out, JSON.stringify({ at: Date.now(), model: MODEL, rows }, null, 1), 'utf8');

console.log('\n题号 | 类型 | 场景 | 回答（截断） | 该判成什么（人工填）');
console.log('---|---|---|---|---');
for (const r of rows) {
  console.log(`${r.id} | ${r.kind} | ${r.usedScene || '-'} | ${(r.answer || r.error || '').slice(0, 36)} | 通过 / 失败`);
}
console.log(`\n原始记录：${out}`);
console.log('判分请对照 control.json 里的 expect / fail —— 脚本不替你判。');
