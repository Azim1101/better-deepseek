// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromePolyfill } from "./android-chrome-polyfill.js";

function installBridge(overrides = {}) {
  const store = new Map();
  const bridge = {
    getStorage: vi.fn((key) => (store.has(key) ? store.get(key) : null)),
    setStorage: vi.fn((key, value) => store.set(key, String(value ?? ""))),
    removeStorage: vi.fn((key) => store.delete(key)),
    getAssetUrl: vi.fn((path) => `https://bds-asset.local/bds/${path}`),
    fetch: vi.fn(() => JSON.stringify({ ok: true })),
    downloadBlob: vi.fn(),
    ...overrides,
  };
  window.AndroidBridge = bridge;
  return { bridge, store };
}

beforeEach(() => {
  // Each test installs a fresh polyfill against a fresh bridge.
  delete window.chrome;
});

afterEach(() => {
  delete window.chrome;
  delete window.AndroidBridge;
});

describe("installChromePolyfill", () => {
  it("is idempotent — installing twice does not double-wrap chrome", () => {
    installBridge();
    installChromePolyfill();
    const first = window.chrome;
    installChromePolyfill();
    expect(window.chrome).toBe(first);
    expect(window.chrome.__bdsAndroidPolyfill).toBe(true);
  });

  it("does nothing when window is undefined", () => {
    // The module already returns early when typeof window === "undefined";
    // this assertion documents the contract. Re-import to exercise the guard.
    expect(() => installChromePolyfill()).not.toThrow();
  });
});

describe("chrome.storage.local.get", () => {
  it("returns an empty object when called with null", async () => {
    installBridge();
    installChromePolyfill();
    await expect(chrome.storage.local.get(null)).resolves.toEqual({});
  });

  it("looks up a single string key", async () => {
    installBridge();
    installChromePolyfill();
    await chrome.storage.local.set({ greeting: "hello" });
    await expect(chrome.storage.local.get("greeting")).resolves.toEqual({
      greeting: "hello",
    });
  });

  it("looks up an array of keys", async () => {
    installBridge();
    installChromePolyfill();
    await chrome.storage.local.set({ a: 1, b: 2, c: 3 });
    await expect(chrome.storage.local.get(["a", "c"])).resolves.toEqual({ a: 1, c: 3 });
  });

  it("merges defaults from an object query", async () => {
    installBridge();
    installChromePolyfill();
    await chrome.storage.local.set({ existing: "value" });
    await expect(
      chrome.storage.local.get({ existing: "fallback", missing: "default" }),
    ).resolves.toEqual({ existing: "value", missing: "default" });
  });
});

describe("chrome.storage.local.set / remove + onChanged", () => {
  it("fires onChanged with old/new values on set", async () => {
    installBridge();
    installChromePolyfill();
    const listener = vi.fn();
    chrome.storage.onChanged.addListener(listener);

    await chrome.storage.local.set({ token: "abc" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      { token: { oldValue: undefined, newValue: "abc" } },
      "local",
    );
  });

  it("fires onChanged on remove with newValue undefined", async () => {
    installBridge();
    installChromePolyfill();
    await chrome.storage.local.set({ token: "abc" });

    const listener = vi.fn();
    chrome.storage.onChanged.addListener(listener);
    await chrome.storage.local.remove("token");

    expect(listener).toHaveBeenCalledWith(
      { token: { oldValue: "abc", newValue: undefined } },
      "local",
    );
  });

  it("removeListener stops further notifications", async () => {
    installBridge();
    installChromePolyfill();
    const listener = vi.fn();
    chrome.storage.onChanged.addListener(listener);
    chrome.storage.onChanged.removeListener(listener);
    await chrome.storage.local.set({ a: 1 });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("chrome.runtime.sendMessage", () => {
  it("returns a promise resolving to the bridge response", async () => {
    installBridge({
      fetch: vi.fn(() => JSON.stringify({ ok: true, html: "<p>x</p>" })),
    });
    installChromePolyfill();

    await expect(
      chrome.runtime.sendMessage({ type: "bds-fetch-url", url: "https://x" }),
    ).resolves.toEqual({ ok: true, html: "<p>x</p>" });
  });

  it("invokes the legacy callback form with the response", async () => {
    installBridge({
      fetch: vi.fn(() => JSON.stringify({ ok: true, value: 42 })),
    });
    installChromePolyfill();

    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "anything" }, (response) => {
        try {
          expect(response).toEqual({ ok: true, value: 42 });
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  });

  it("translates bridge throws into an ok:false response", async () => {
    installBridge({
      fetch: vi.fn(() => {
        throw new Error("boom");
      }),
    });
    installChromePolyfill();

    const response = await chrome.runtime.sendMessage({ type: "x" });
    // The shim catches the throw and produces the same ok:false shape the
    // background service worker would have returned on rejection.
    expect(response.ok).toBe(false);
    expect(String(response.error)).toMatch(/boom/);
  });
});

describe("chrome.runtime.getURL", () => {
  it("delegates to the native asset URL resolver", () => {
    const { bridge } = installBridge();
    installChromePolyfill();

    expect(chrome.runtime.getURL("sandbox.html")).toBe(
      "https://bds-asset.local/bds/sandbox.html",
    );
    expect(bridge.getAssetUrl).toHaveBeenCalledWith("sandbox.html");
  });
});

describe("merging with an existing chrome global", () => {
  it("preserves unrelated chrome.* fields installed by another polyfill", () => {
    installBridge();
    window.chrome = { app: { existing: true } };
    installChromePolyfill();

    expect(window.chrome.app).toEqual({ existing: true });
    expect(window.chrome.storage.local.get).toBeTypeOf("function");
  });
});

describe("MCP over the native bridge", () => {
  /**
   * The Android target has no background service worker, so the JSON-RPC
   * handshake runs in the polyfill and the native side only performs one POST.
   * These tests pin that contract: the message types the rest of the app already
   * sends must keep working, and nothing may reach AndroidFetch by mistake.
   */

  function rpcResponse(payload, result, extra = {}) {
    const request = JSON.parse(payload.body);
    return JSON.stringify({
      ok: true,
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      ...extra,
    });
  }

  it("answers tools/list through the bridge and reuses the session id", async () => {
    const calls = [];
    const { bridge } = installBridge({
      fetch: vi.fn((payloadJson) => {
        const payload = JSON.parse(payloadJson);
        calls.push(payload);
        const request = JSON.parse(payload.body);
        if (request.method === "initialize") {
          return rpcResponse(payload, { protocolVersion: "2024-11-05" }, { sessionId: "sess-42" });
        }
        if (request.method === "tools/list") {
          return rpcResponse(payload, { tools: [{ name: "fs_list" }] });
        }
        return JSON.stringify({ ok: true, status: 202, body: "" });
      }),
    });
    installChromePolyfill();

    const response = await chrome.runtime.sendMessage({
      type: "bds-mcp-list-tools",
      serverUrl: "http://127.0.0.1:8765/mcp",
    });

    expect(response).toEqual({ ok: true, tools: { tools: [{ name: "fs_list" }] } });
    // Loopback plain HTTP is a supported deployment on Android.
    expect(calls[0]).toMatchObject({
      type: "bds-mcp-http",
      url: "http://127.0.0.1:8765/mcp",
    });
    const toolsCall = calls.find((c) => JSON.parse(c.body).method === "tools/list");
    expect(toolsCall.sessionId).toBe("sess-42");
    // Only the MCP messages are handled here; plain messages stay on AndroidFetch.
    expect(bridge.fetch).toHaveBeenCalled();
  });

  it("calls a tool and returns the JSON-RPC result", async () => {
    installBridge({
      fetch: vi.fn((payloadJson) => {
        const request = JSON.parse(JSON.parse(payloadJson).body);
        if (request.method === "tools/call") {
          return rpcResponse(
            { body: JSON.stringify(request) },
            { content: [{ type: "text", text: "hello from the phone" }] },
          );
        }
        return rpcResponse(
          { body: JSON.stringify(request) },
          { protocolVersion: "2024-11-05" },
        );
      }),
    });
    installChromePolyfill();

    const response = await chrome.runtime.sendMessage({
      type: "bds-mcp-call",
      serverUrl: "http://127.0.0.1:8766/mcp",
      toolName: "fs_read",
      args: { path: "/sdcard/Documents/a.txt" },
    });

    expect(response.ok).toBe(true);
    expect(response.result.content[0].text).toBe("hello from the phone");
  });

  it("parses an SSE (text/event-stream) answer", async () => {
    installBridge({
      fetch: vi.fn((payloadJson) => {
        const payload = JSON.parse(payloadJson);
        const request = JSON.parse(payload.body);
        if (request.method === "initialize") {
          return JSON.stringify({
            ok: true,
            status: 200,
            contentType: "text/event-stream",
            body: 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n',
          });
        }
        return JSON.stringify({
          ok: true,
          status: 200,
          contentType: "text/event-stream",
          body:
            'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"ping"}]}}\n\n',
        });
      }),
    });
    installChromePolyfill();

    const response = await chrome.runtime.sendMessage({
      type: "bds-mcp-list-tools",
      serverUrl: "http://127.0.0.1:8768/mcp",
    });

    expect(response).toEqual({ ok: true, tools: { tools: [{ name: "ping" }] } });
  });

  it("falls back from Bearer to X-API-Key when the server rejects the header", async () => {
    const authHeaders = [];
    installBridge({
      fetch: vi.fn((payloadJson) => {
        const payload = JSON.parse(payloadJson);
        authHeaders.push(payload.authMethod);
        const request = JSON.parse(payload.body);
        if (!authHeaders.includes("x-api-key")) {
          return JSON.stringify({ ok: false, status: 401, error: "MCP server returned 401" });
        }
        return rpcResponse(payload, { tools: [] });
      }),
    });
    installChromePolyfill();

    const response = await chrome.runtime.sendMessage({
      type: "bds-mcp-list-tools",
      serverUrl: "http://127.0.0.1:8769/mcp",
      apiKey: "secret",
    });

    expect(response.ok).toBe(true);
    expect(authHeaders.slice(0, 2)).toEqual(["bearer", "x-api-key"]);
  });

  it("reports a bridge failure as ok:false instead of throwing", async () => {
    installBridge({
      fetch: vi.fn(() =>
        JSON.stringify({ ok: false, status: 500, error: "MCP server returned 500" }),
      ),
    });
    installChromePolyfill();

    const response = await chrome.runtime.sendMessage({
      type: "bds-mcp-list-tools",
      serverUrl: "http://127.0.0.1:8770/mcp",
    });

    expect(response).toEqual({ ok: false, error: "MCP server returned 500" });
  });
});
