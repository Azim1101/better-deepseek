/**
 * Polyfills the subset of the chrome.* extension APIs that BDS uses,
 * routing every call through the Android native bridge.
 *
 * The rest of the codebase calls chrome.storage.local, chrome.runtime.sendMessage,
 * chrome.runtime.getURL, and chrome.storage.onChanged. Implementing those four
 * surfaces here lets the extension run inside an Android WebView without
 * modifying any feature code.
 */

import { AndroidStorage, AndroidFetch, AndroidAssetUrl, AndroidMcp } from "./android-bridge-shim.js";

/**
 * ── MCP over the native bridge ───────────────────────────────────────────────
 *
 * On desktop these two messages are handled by the background service worker
 * (src/background/index.js, "bds-mcp-list-tools" / "bds-mcp-call"). The Android
 * target does not build a background worker, so without this block every MCP
 * server configured in Settings fails with "Unsupported bridge message type".
 *
 * The protocol work is kept here in JS — the native side only performs one
 * POST and hands back the body — so the JSON-RPC handshake stays in one place
 * and can be exercised by the Playwright Android suite without an emulator.
 */

const MCP_PROTOCOL_VERSION = "2024-11-05";
const MCP_CLIENT_NAME = "better-deepseek-android";

/** Per-(url|apiKey) handshake state: session id + which auth header worked. */
const mcpSessions = new Map();
let mcpRequestId = 1;

/**
 * Parse an MCP response body.
 *
 * Streamable HTTP servers may answer a POST either with plain JSON or with an
 * SSE stream. OkHttp hands us the whole body, so an SSE answer is reduced to
 * its last `data:` frame — which is the JSON-RPC response, per the transport
 * spec.
 */
function parseMcpBody(text, contentType) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const looksLikeSse =
    String(contentType || "").includes("text/event-stream") ||
    raw.startsWith("event:") ||
    raw.startsWith("data:");
  if (!looksLikeSse) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  let last = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      last = JSON.parse(payload);
    } catch {
      /* ignore keep-alives and partial frames */
    }
  }
  return last;
}

async function mcpPost(serverUrl, jsonRpcBody, { apiKey = "", authMethod = "bearer", sessionId = "" } = {}) {
  const response = await AndroidMcp.post({
    url: serverUrl,
    body: JSON.stringify(jsonRpcBody),
    apiKey,
    authMethod,
    sessionId,
  });

  if (!response || response.ok !== true) {
    const error = new Error(response?.error || "MCP request failed");
    error.status = response?.status;
    throw error;
  }

  const parsed = parseMcpBody(response.body, response.contentType);
  if (!parsed) {
    throw new Error("MCP server returned an unparseable response");
  }
  if (parsed.error) {
    throw new Error(parsed.error.message || JSON.stringify(parsed.error));
  }
  return { result: parsed.result, sessionId: response.sessionId || sessionId };
}

/**
 * Initialize once per (url, apiKey), mirroring mcpEnsureInitialized() in the
 * background worker: try Bearer, then X-API-Key, then no auth header, and cache
 * whichever the server accepted.
 */
async function mcpEnsureInitialized(serverUrl, apiKey) {
  const key = `${serverUrl}|${apiKey}`;
  const cached = mcpSessions.get(key);
  if (cached) return cached.pending;

  const entry = { pending: null, sessionId: "", authMethod: "none" };
  mcpSessions.set(key, entry);

  entry.pending = (async () => {
    const initBody = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: MCP_CLIENT_NAME, version: "0.1" },
      },
    };

    const attempts = [];
    if (apiKey) {
      attempts.push("bearer", "x-api-key");
    }
    attempts.push("none");

    let lastError = null;
    for (const authMethod of attempts) {
      try {
        const { sessionId } = await mcpPost(serverUrl, initBody, {
          apiKey: authMethod === "none" ? "" : apiKey,
          authMethod,
        });
        entry.sessionId = sessionId || "";
        entry.authMethod = authMethod;
        lastError = null;
        break;
      } catch (err) {
        if (err.status !== 401 && err.status !== 403) throw err;
        lastError = err;
      }
    }
    if (lastError) {
      mcpSessions.delete(key);
      throw lastError;
    }

    // Required by the spec, and cheap; a server that ignores it is still fine.
    mcpPost(
      serverUrl,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { apiKey: entry.authMethod === "none" ? "" : apiKey, authMethod: entry.authMethod, sessionId: entry.sessionId }
    ).catch(() => {});

    return { sessionId: entry.sessionId, authMethod: entry.authMethod };
  })().catch((err) => {
    mcpSessions.delete(key);
    throw err;
  });

  return entry.pending;
}

async function mcpJsonRpc(serverUrl, method, params, apiKey) {
  const { sessionId, authMethod } = await mcpEnsureInitialized(serverUrl, apiKey);
  const body = { jsonrpc: "2.0", id: ++mcpRequestId, method, params: params || {} };
  const { result } = await mcpPost(serverUrl, body, {
    apiKey: authMethod === "none" ? "" : apiKey,
    authMethod,
    sessionId,
  });
  return result;
}

/** Same response shapes the background worker returns, so shared code is untouched. */
async function handleMcpMessage(message) {
  const serverUrl = String(message.serverUrl || "");
  const apiKey = String(message.apiKey || "");
  try {
    if (message.type === "bds-mcp-list-tools") {
      return { ok: true, tools: await mcpJsonRpc(serverUrl, "tools/list", {}, apiKey) };
    }
    return {
      ok: true,
      result: await mcpJsonRpc(
        serverUrl,
        "tools/call",
        { name: message.toolName, arguments: message.args || {} },
        apiKey
      ),
    };
  } catch (err) {
    const error = String((err && err.message) || err);
    // A 404/400 usually means the session was dropped; retry once from scratch.
    if (err && (err.status === 404 || err.status === 400)) {
      mcpSessions.delete(`${serverUrl}|${apiKey}`);
    }
    return { ok: false, error };
  }
}

function isMcpMessage(message) {
  return Boolean(
    message &&
      (message.type === "bds-mcp-list-tools" || message.type === "bds-mcp-call")
  );
}

export function installChromePolyfill() {
  if (typeof window === "undefined") return;
  if (window.chrome && window.chrome.__bdsAndroidPolyfill) return;

  const changeListeners = new Set();

  function fireChange(changes) {
    if (!changes || Object.keys(changes).length === 0) return;
    for (const listener of changeListeners) {
      try {
        listener(changes, "local");
      } catch (err) {
        console.error("[BDS] chrome.storage.onChanged listener error:", err);
      }
    }
  }

  function readKeys(keys) {
    const result = {};
    for (const key of keys) {
      const value = AndroidStorage.get(key);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }

  const storageLocal = {
    get(query) {
      let keys = [];
      let defaults = {};

      if (query === null || query === undefined) {
        return Promise.resolve({});
      }
      if (typeof query === "string") {
        keys = [query];
      } else if (Array.isArray(query)) {
        keys = query.map(String);
      } else if (typeof query === "object") {
        keys = Object.keys(query);
        defaults = query;
      }

      const values = readKeys(keys);
      const merged = { ...defaults, ...values };
      return Promise.resolve(merged);
    },

    set(items) {
      if (!items || typeof items !== "object") {
        return Promise.resolve();
      }
      const changes = {};
      for (const [key, newValue] of Object.entries(items)) {
        const oldValue = AndroidStorage.get(key);
        AndroidStorage.set(key, newValue);
        changes[key] = { oldValue, newValue };
      }
      fireChange(changes);
      return Promise.resolve();
    },

    remove(keys) {
      const list = Array.isArray(keys) ? keys.map(String) : [String(keys)];
      const changes = {};
      for (const key of list) {
        const oldValue = AndroidStorage.get(key);
        AndroidStorage.remove(key);
        changes[key] = { oldValue, newValue: undefined };
      }
      fireChange(changes);
      return Promise.resolve();
    },

    clear() {
      // Not implemented for Android in Phase 1 — nothing in BDS calls it today.
      return Promise.resolve();
    },
  };

  const onChanged = {
    addListener(listener) {
      if (typeof listener === "function") changeListeners.add(listener);
    },
    removeListener(listener) {
      changeListeners.delete(listener);
    },
    hasListener(listener) {
      return changeListeners.has(listener);
    },
  };

  /**
   * sendMessage supports both the promise form (await chrome.runtime.sendMessage(msg))
   * and the callback form (chrome.runtime.sendMessage(msg, cb)) used by pricing.js.
   */
  function sendMessage(message, callback) {
    runtimeApi.lastError = null;

    // MCP has no service worker on Android: run the JSON-RPC handshake here.
    const promise = (isMcpMessage(message) ? handleMcpMessage(message) : AndroidFetch.send(message)).catch((err) => ({
      ok: false,
      error: String((err && err.message) || err),
    }));

    if (typeof callback === "function") {
      promise.then(
        (response) => {
          try {
            callback(response);
          } catch (err) {
            console.error("[BDS] sendMessage callback error:", err);
          }
        },
        (err) => {
          runtimeApi.lastError = { message: String(err && err.message) };
          try {
            callback(undefined);
          } catch (e) {
            console.error("[BDS] sendMessage callback error:", e);
          }
        }
      );
      return undefined;
    }

    return promise;
  }

  function getURL(path) {
    return AndroidAssetUrl.resolve(path);
  }

  // Service-worker style listener registration is a no-op on Android — the
  // background entry isn't built for this target. Surfacing a stub keeps any
  // accidental call safe.
  const onMessage = {
    addListener() {},
    removeListener() {},
    hasListener() {
      return false;
    },
  };

  const runtimeApi = {
    sendMessage,
    getURL,
    onMessage,
    lastError: null,
    id: "better-deepseek-android",
  };

  const chromeShim = {
    __bdsAndroidPolyfill: true,
    storage: {
      local: storageLocal,
      onChanged,
    },
    runtime: runtimeApi,
  };

  // Don't clobber a real chrome global if (somehow) one is present — merge.
  const existing = window.chrome;
  if (existing && typeof existing === "object") {
    window.chrome = Object.assign({}, existing, chromeShim);
  } else {
    window.chrome = chromeShim;
  }
}
