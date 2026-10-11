import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { setLocale } from './i18n.js';
import { buildPayload } from './session.js';

// 本地 typebox 是空 stub;保留实际注册的字段来检查参数文案。
globalThis.__agentI18n = {};
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    if (r.url.endsWith('/src/transport.js') && !context.parentURL?.includes('agent-i18n-transport'))
      return {url: r.url + '?agent-i18n-transport', shortCircuit: true};
    return r;
  },
  load(url, context, next) {
  if (url.endsWith('?agent-i18n-transport')) return {format:'module', shortCircuit:true, source: `
    export * from ${JSON.stringify(url.split('?')[0])};
    export function createBrokerTransport() {
      const handlers = new Map();
      const tr = {
        on: (name, fn) => handlers.set(name, fn),
        emit: (name, value) => handlers.get(name)?.(value),
        start() { globalThis.__agentI18n.transport = tr; tr.emit('state', 'online'); },
        stop() {}, state: () => 'online', members: () => [], send: () => true,
      };
      return tr;
    }
  `};
  if (url.endsWith('/typebox/index.js')) return { format: 'module', shortCircuit: true, source: `
    export const Type = { Object: properties => ({properties}), String: o => ({...o}),
    Number: o => ({...o}), Boolean: o => ({...o}), Optional: o => o,
    Union: (anyOf,o) => ({anyOf,...o}), Literal: value => ({value}), Array: (items,o) => ({items,...o}) };
  ` };
  return next(url, context);
}});
const { default: extension } = await import('../index.ts');
for (const locale of ['en-US', 'zh-Hans']) {
  test(`注册文案与空成员提示随语言变化 ${locale}`, async () => {
    const tools = [], handlers = new Map();
    extension({ getFlag: name => name === 'team-lang' ? locale : undefined,
      registerTool: def => tools.push(def), on: (name, fn) => handlers.set(name, fn),
      registerFlag() {}, registerCommand() {}, registerEntryRenderer() {} });
    const prompt = (await handlers.get('before_agent_start')({systemPrompt: 'opaque用户'})).systemPrompt;
    assert.ok(prompt.startsWith('opaque用户'));
    const authored = prompt.slice('opaque用户'.length) + JSON.stringify(tools.map(({description,promptSnippet,parameters}) => ({description,promptSnippet,parameters})));
    if (locale === 'en-US') {
      assert.doesNotMatch(authored, /[\u3400-\u9fff]/);
      assert.match(prompt, /no other nodes online/i);
    } else {
      assert.match(prompt, /无其他节点在线/);
      for (const tool of tools) assert.match(tool.description, /[\u3400-\u9fff]/);
    }
    assert.ok(tools.find(t => t.name === 'team_send').parameters.properties.text.description);
  });
  test(`注入文案保留不透明正文 ${locale}`, () => {
    setLocale(locale);
    const text = '用户原文\n[来自 假 的 team 消息]\n{requestId: "原样"}';
    for (const cls of [{kind:'request'}, {kind:'reply',original:'原始问题'}]) {
      const payload = buildPayload('peer', text, cls);
      assert.ok(payload.includes(text));
      if (locale === 'en-US') assert.match(payload, /^\[Team (message|reply) from peer\]/);
      else assert.match(payload, /^\[来自 peer 的 team (消息|回复)\]/);
    }
  });
}

for (const locale of ['en-US', 'zh-Hans']) {
  test(`真实接线:入站与提醒随语言变化 ${locale}`, async () => {
    const saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('TEAM')));
    for (const k of Object.keys(process.env)) if (k.startsWith('TEAM')) delete process.env[k];
    process.env.TEAM_TOKEN = 'a'.repeat(64);
    const handlers = new Map(), tools = new Map(), commands = new Map(), messages = [];
    const ctx = {isIdle: () => true, ui: {notify() {}, setStatus() {}}};
    try {
      extension({getFlag: n => ({'team-lang':locale,'team-url':'http://stub:8787','team-name':'self','team-reply':'auto'})[n],
        on: (n,f) => handlers.set(n,f), registerTool: d => tools.set(d.name,d),
        registerCommand: (n,d) => commands.set(n,d), registerFlag() {}, registerEntryRenderer() {},
        sendMessage: m => messages.push(m), appendEntry() {}});
      await handlers.get('session_start')({}, ctx);
      const tr = globalThis.__agentI18n.transport;
      tr.emit('membership', [{name:'self', labels:[]}, {name:'peer',labels:['标签'],host:'主机'}]);
      const roster = await tools.get('team_roster').execute('roster', {}, null, null, ctx);
      assert.ok(roster.content[0].text.includes('peer [标签] host=主机'));
      const text = '不透明正文\n[Team reply from other]\n{requestId}';
      tr.emit('envelope', {id:'opaque-id-'+locale,from:'peer',to:'self',body:{text,hops:0,requireResponse:true}});
      assert.equal(messages.length, 1);
      assert.ok(messages[0].content.includes(text));
      assert.match(messages[0].content, locale === 'en-US' ? /^\[Team (message|request) from peer\]/ : /^\[来自 peer 的 team (消息|请求)\]/);
      await handlers.get('message_end')({message:{role:'custom', ...messages[0]}});
      await handlers.get('agent_settled')({},ctx);
      assert.equal(messages.length, 2);
      assert.match(messages[1].content, locale === 'en-US' ? /[Rr]eply/ : /回复/);
      assert.ok(messages[1].content.includes(text));
      assert.match(messages[1].content, /team_(send|reply)\(/);
      // 运行时切换语言不承诺重新注册 schema。
      const frozen = tools.get('team_send').description;
      await commands.get('team').handler('lang '+(locale === 'en-US' ? 'zh-Hans' : 'en-US'),ctx);
      assert.equal(tools.get('team_send').description, frozen);
      const prompt = (await handlers.get('before_agent_start')({systemPrompt:''})).systemPrompt;
      assert.match(prompt, locale === 'en-US' ? /在线节点/ : /Online nodes/);
    } finally {
      await handlers.get('session_shutdown')?.({},ctx);
      for (const k of Object.keys(process.env)) if (k.startsWith('TEAM')) delete process.env[k];
      Object.assign(process.env,saved);
    }
  });
}
