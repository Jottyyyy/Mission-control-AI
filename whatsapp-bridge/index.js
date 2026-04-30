const PLUGIN_ID = "whatsapp-bridge";
const DEFAULT_ENDPOINT = "http://127.0.0.1:8001/whatsapp/event";
const DEFAULT_TIMEOUT_MS = 5000;

const log = (level, message, extra) => {
  const line = extra
    ? `[${PLUGIN_ID}] ${message} ${JSON.stringify(extra)}`
    : `[${PLUGIN_ID}] ${message}`;
  if (level === "error") console.error(line);
  else console.log(line);
};

const resolveBridgeConfig = (cfg, pluginConfig) => {
  const hookEntry = cfg?.hooks?.internal?.entries?.[PLUGIN_ID] ?? {};
  const fromPlugin = pluginConfig ?? {};
  const endpoint =
    (typeof fromPlugin.endpoint === "string" && fromPlugin.endpoint.trim()) ||
    (typeof hookEntry.endpoint === "string" && hookEntry.endpoint.trim()) ||
    DEFAULT_ENDPOINT;
  const timeoutMs =
    typeof fromPlugin.timeoutMs === "number" && fromPlugin.timeoutMs > 0
      ? fromPlugin.timeoutMs
      : typeof hookEntry.timeoutMs === "number" && hookEntry.timeoutMs > 0
        ? hookEntry.timeoutMs
        : DEFAULT_TIMEOUT_MS;
  return { endpoint, timeoutMs };
};

const buildPayload = (event, ctx) => ({
  channelId: ctx?.channelId ?? null,
  accountId: ctx?.accountId ?? null,
  conversationId: ctx?.conversationId ?? event?.channel ?? null,
  sessionKey: ctx?.sessionKey ?? null,
  senderId: ctx?.senderId ?? null,
  timestamp:
    typeof event?.timestamp === "number"
      ? new Date(event.timestamp).toISOString()
      : new Date().toISOString(),
  body: event?.body ?? null,
  bodyForAgent: event?.bodyForAgent ?? null,
  content: event?.content ?? null,
  isGroup: Boolean(event?.isGroup),
});

const forwardToMissionControl = async (event, ctx, config) => {
  const { endpoint, timeoutMs } = resolveBridgeConfig(config?.cfg, config?.pluginConfig);
  const payload = buildPayload(event, ctx);
  const charCount = (payload.bodyForAgent ?? payload.body ?? payload.content ?? "").length;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - startedAt;
    if (!res.ok) {
      log("error", "forward non-2xx", {
        endpoint,
        status: res.status,
        statusText: res.statusText,
        chars: charCount,
        elapsedMs,
      });
      return;
    }
    log("info", "forwarded", {
      endpoint,
      from: payload.senderId,
      chars: charCount,
      isGroup: payload.isGroup,
      elapsedMs,
    });
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const message =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    log("error", "forward failed", {
      endpoint,
      chars: charCount,
      elapsedMs,
      err: message,
    });
  } finally {
    clearTimeout(timer);
  }
};

const emptyConfigSchema = {
  validate: () => ({ ok: true }),
};

const pluginEntry = {
  id: PLUGIN_ID,
  name: "WhatsApp Bridge",
  description:
    "Forward inbound WhatsApp messages to Mission Control's FastAPI and suppress OpenClaw's default agent so Jackson owns the reply path.",
  get configSchema() {
    return emptyConfigSchema;
  },
  register(api) {
    const cfg = api?.config;
    const pluginConfig = api?.pluginConfig;

    api.on("before_dispatch", async (event, ctx) => {
      try {
        if (ctx?.channelId !== "whatsapp") return;

        log("info", "intercepted before_dispatch", {
          channelId: ctx.channelId,
          conversationId: ctx.conversationId,
          senderId: ctx.senderId,
          isGroup: Boolean(event?.isGroup),
          chars: (event?.body ?? event?.content ?? "").length,
        });

        await forwardToMissionControl(event, ctx, { cfg, pluginConfig });
      } catch (err) {
        const message =
          err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        log("error", "before_dispatch handler crashed", { err: message });
      }
      return { handled: true };
    });
  },
};

export default pluginEntry;
