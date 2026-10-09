/** 每个进程只加载一次扩展；仅替代 Pi 宿主，网络和业务模块全部真实运行。 */
import { registerHooks } from "node:module";

// UI 不参与协议；必须在加载扩展及其依赖之前注册。TypeBox 优先使用已安装版本。
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@earendil-works/pi-tui") return { url: "fixture:ui", shortCircuit: true };
    if (specifier === "typebox") {
      try { return next(specifier, context); }
      catch (error) {
        if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
        return { url: "fixture:typebox", shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "fixture:ui") return { format: "module", shortCircuit: true, source: "export class Box {} export class Text {}" };
    if (url === "fixture:typebox") return { format: "module", shortCircuit: true, source: "export const Type = new Proxy({}, { get: () => (...args) => ({}) });" };
    return next(url, context);
  },
});

const emit = (kind, value) => process.send?.({ kind, value });
// 透明观测原生 WebSocket：不替换路由、帧、写入结果或任何传输逻辑。
const NativeWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends NativeWebSocket {
  constructor(...args) {
    super(...args);
    this.addEventListener("message", event => emit("received", JSON.parse(String(event.data))));
  }
  send(data) {
    const result = super.send(data);
    emit("sent", JSON.parse(String(data)));
    return result;
  }
};

const tools = new Map();
const handlers = new Map();
const messages = [];
const ctx = {
  ui: { notify() {}, setStatus() {}, confirm: async () => true },
  isIdle: () => true,
  sessionManager: { getBranch: () => [] },
};
const pi = {
  getFlag: () => undefined,
  registerFlag() {}, registerCommand() {}, registerEntryRenderer() {}, appendEntry() {},
  registerTool: tool => tools.set(tool.name, tool),
  on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
  sendMessage(message, options) {
    messages.push(message);
    emit("injected", { ...message, options });
  },
};
async function hook(name, event = {}) {
  for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
}
const extension = await import("../../index.ts");
extension.default(pi);
await hook("session_start");
let observed = 0;
process.on("message", async ({ id, op, calls }) => {
  try {
    let value;
    if (op === "tools") {
      // 同一请求的竞争也在子进程内真正用 Promise.all 执行。
      value = await Promise.all(calls.map(({ name, args }, i) => tools.get(name).execute(`${id}-${i}`, args, undefined, undefined, ctx)));
    } else if (op === "settle") {
      const end = messages.length;
      while (observed < end) await hook("message_end", { message: { role: "custom", ...messages[observed++] } });
      await hook("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Processed locally." }] } });
      await hook("agent_settled");
    } else if (op === "shutdown") {
      await hook("session_shutdown");
    } else throw new Error(`Unknown fixture operation: ${op}`);
    process.send({ id, value });
    if (op === "shutdown") process.disconnect();
  } catch (error) {
    process.send({ id, error: error.stack });
  }
});
emit("ready", { pid: process.pid });
