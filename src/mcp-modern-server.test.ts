import assert from "node:assert/strict";
import test from "node:test";
import { registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  compileMcpRegistrationSurface,
  createModernMcpServerAdapter,
  modernMcpAdapterErrorLogFields,
} from "./mcp-modern-server.js";

test("strict modern handler answers the 2026-07-28 discovery probe", async (t) => {
  const handler = createMcpHandler(() => new McpServer(
    { name: "devspace-modern-test", version: "1.0.0" },
    { capabilities: { tools: {} } },
  ), { legacy: "reject" });
  t.after(async () => handler.close());

  const response = await handler.fetch(modernRequest("server/discover", {}));

  assert.equal(response.status, 200);
  const body = await response.json() as {
    result?: { supportedVersions?: string[] };
  };
  assert.ok(body.result?.supportedVersions?.includes("2026-07-28"));
});

test("modern registration adapter preserves tools and request metadata", async (t) => {
  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({
      name: "devspace-modern-test",
      version: "1.0.0",
    });
    registerAppTool(
      adapter.registrationTarget,
      "echo_scope",
      {
        description: "Echo the modern request scope.",
        inputSchema: { value: z.string() },
        _meta: {},
      },
      async ({ value }, { _meta }) => ({
        content: [{
          type: "text",
          text: `${value}:${String(_meta?.["openai/session"] ?? "missing")}`,
        }],
      }),
    );
    return adapter.server;
  }, { legacy: "reject" });
  t.after(async () => handler.close());

  const listed = await handler.fetch(modernRequest("tools/list", {}));
  assert.equal(listed.status, 200);
  const listBody = await listed.json() as {
    result?: { tools?: Array<{ name?: string }> };
  };
  assert.ok(listBody.result?.tools?.some((tool) => tool.name === "echo_scope"));

  const called = await handler.fetch(modernRequest("tools/call", {
    name: "echo_scope",
    arguments: { value: "ok" },
    _meta: { "openai/session": "modern-chat" },
  }));
  assert.equal(called.status, 200, await called.clone().text());
  const callBody = await called.json() as {
    result?: { content?: Array<{ text?: string }> };
  };
  assert.equal(callBody.result?.content?.[0]?.text, "ok:modern-chat");
});

test("modern registration adapter preserves progress notifications", async (t) => {
  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({
      name: "devspace-modern-test",
      version: "1.0.0",
    });
    registerAppTool(
      adapter.registrationTarget,
      "progress_echo",
      {
        inputSchema: {},
        _meta: {},
      },
      async (_input, { sendNotification }) => {
        await sendNotification({
          method: "notifications/progress",
          params: {
            progressToken: "modern-progress",
            progress: 1,
            total: 1,
          },
        });
        return { content: [{ type: "text", text: "done" }] };
      },
    );
    return adapter.server;
  }, { legacy: "reject" });
  t.after(async () => handler.close());

  const response = await handler.fetch(modernRequest("tools/call", {
    name: "progress_echo",
    arguments: {},
    _meta: { progressToken: "modern-progress" },
  }));

  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const messages = (await response.text())
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
  assert.ok(messages.some((message) => message.method === "notifications/progress"));
  assert.match(JSON.stringify(messages.at(-1)), /done/);
});

test("modern registration adapter preserves resources", async (t) => {
  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({
      name: "devspace-modern-test",
      version: "1.0.0",
    });
    registerAppResource(
      adapter.registrationTarget,
      "Test resource",
      "ui://devspace/test.html",
      {},
      async (_uri, { _meta }) => ({
        contents: [{
          uri: "ui://devspace/test.html",
          mimeType: "text/html",
          text: `resource-ok:${String(_meta?.["openai/session"] ?? "missing")}`,
        }],
      }),
    );
    return adapter.server;
  }, { legacy: "reject" });
  t.after(async () => handler.close());

  const response = await handler.fetch(modernRequest("resources/read", {
    uri: "ui://devspace/test.html",
    _meta: { "openai/session": "resource-chat" },
  }));

  assert.equal(response.status, 200, await response.clone().text());
  assert.match(await response.text(), /resource-ok:resource-chat/);
});

test("modern adapter publishes private cache hints and server identity", async (t) => {
  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({
      name: "devspace-modern-test",
      version: "1.2.3",
    });
    registerAppTool(
      adapter.registrationTarget,
      "cached_tool",
      { inputSchema: {}, _meta: {} },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    registerAppResource(
      adapter.registrationTarget,
      "Cached resource",
      "ui://devspace/cache-test.html",
      {},
      async () => ({
        contents: [{
          uri: "ui://devspace/cache-test.html",
          mimeType: "text/html",
          text: "cached",
        }],
      }),
    );
    return adapter.server;
  }, { legacy: "reject" });
  t.after(async () => handler.close());

  const cases: Array<[string, Record<string, unknown>]> = [
    ["server/discover", {}],
    ["tools/list", {}],
    ["resources/list", {}],
    ["resources/read", { uri: "ui://devspace/cache-test.html" }],
  ];

  for (const [method, params] of cases) {
    const response = await handler.fetch(modernRequest(method, params));
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as {
      result?: {
        ttlMs?: number;
        cacheScope?: string;
        _meta?: Record<string, unknown>;
      };
    };
    assert.equal(body.result?.ttlMs, 300_000, method);
    assert.equal(body.result?.cacheScope, "private", method);
    assert.deepEqual(
      body.result?._meta?.["io.modelcontextprotocol/serverInfo"],
      { name: "devspace-modern-test", version: "1.2.3" },
      method,
    );
  }
});

test("modern handler rejects routing headers that disagree with the body", async (t) => {
  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({
      name: "devspace-modern-test",
      version: "1.0.0",
    });
    registerAppTool(
      adapter.registrationTarget,
      "echo",
      { inputSchema: {}, _meta: {} },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    return adapter.server;
  }, { legacy: "reject" });
  t.after(async () => handler.close());

  const methodMismatch = await handler.fetch(modernRequest(
    "tools/list",
    {},
    { headerMethod: "tools/call" },
  ));
  assert.equal(methodMismatch.status, 400);
  assert.match(await methodMismatch.text(), /headers and body disagree/i);

  const nameMismatch = await handler.fetch(modernRequest(
    "tools/call",
    { name: "echo", arguments: {} },
    { headerName: "different-tool" },
  ));
  assert.equal(nameMismatch.status, 400);
  assert.match(await nameMismatch.text(), /headers and body disagree/i);
});

test("concurrent modern requests keep request metadata isolated", async (t) => {
  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({
      name: "devspace-modern-test",
      version: "1.0.0",
    });
    registerAppTool(
      adapter.registrationTarget,
      "echo_scope",
      {
        inputSchema: { value: z.string() },
        _meta: {},
      },
      async ({ value }, { _meta }) => {
        await new Promise((resolve) => setTimeout(resolve, value.length % 3));
        return {
          content: [{
            type: "text",
            text: `${value}:${String(_meta?.["openai/session"] ?? "missing")}`,
          }],
        };
      },
    );
    return adapter.server;
  }, { legacy: "reject" });
  t.after(async () => handler.close());

  const responses = await Promise.all(
    Array.from({ length: 12 }, async (_, index) => {
      const value = `value-${index}`;
      const scope = `chat-${index}`;
      const response = await handler.fetch(modernRequest("tools/call", {
        name: "echo_scope",
        arguments: { value },
        _meta: { "openai/session": scope },
      }));
      assert.equal(response.status, 200, await response.clone().text());
      const body = await response.json() as {
        result?: { content?: Array<{ text?: string }> };
      };
      return body.result?.content?.[0]?.text;
    }),
  );

  assert.deepEqual(
    responses,
    Array.from({ length: 12 }, (_, index) => `value-${index}:chat-${index}`),
  );
});

test("modern request abort propagates into tool handlers", async (t) => {
  let observedAbort = false;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({
      name: "devspace-modern-test",
      version: "1.0.0",
    });
    registerAppTool(
      adapter.registrationTarget,
      "wait_for_abort",
      { inputSchema: {}, _meta: {} },
      async (_input, { signal }) => {
        markStarted();
        return new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            observedAbort = true;
            reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      },
    );
    return adapter.server;
  }, { legacy: "reject" });
  t.after(async () => handler.close());

  const controller = new AbortController();
  const responsePromise = handler.fetch(modernRequest(
    "tools/call",
    { name: "wait_for_abort", arguments: {} },
    { signal: controller.signal },
  ));
  await started;
  controller.abort(new Error("client disconnected"));

  const response = await responsePromise;
  assert.equal(response.status, 499);
  assert.equal(observedAbort, true);
});

test("compiled registration surface reuses static tool and resource definitions", async (t) => {
  let registrationBuilds = 0;
  const bindRegistrationSurface = compileMcpRegistrationSurface((target) => {
    registrationBuilds += 1;
    registerAppTool(
      target,
      "cached_echo",
      {
        inputSchema: { value: z.string() },
        _meta: {},
      },
      async ({ value }) => ({
        content: [{ type: "text", text: value }],
      }),
    );
    registerAppResource(
      target,
      "Cached resource",
      "ui://devspace/cached.html",
      {},
      async () => ({
        contents: [{
          uri: "ui://devspace/cached.html",
          mimeType: "text/html",
          text: "cached-resource",
        }],
      }),
    );
  });
  assert.equal(registrationBuilds, 1);

  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({
      name: "devspace-modern-test",
      version: "1.0.0",
    });
    bindRegistrationSurface(adapter.registrationTarget);
    return adapter.server;
  }, { legacy: "reject" });
  t.after(async () => handler.close());

  const firstList = await handler.fetch(modernRequest("tools/list", {}));
  const secondList = await handler.fetch(modernRequest("tools/list", {}));
  assert.equal(firstList.status, 200, await firstList.clone().text());
  assert.equal(secondList.status, 200, await secondList.clone().text());
  assert.equal(registrationBuilds, 1);

  const resource = await handler.fetch(modernRequest("resources/read", {
    uri: "ui://devspace/cached.html",
  }));
  assert.equal(resource.status, 200, await resource.clone().text());
  assert.match(await resource.text(), /cached-resource/);
  assert.equal(registrationBuilds, 1);
});

test("modern adapter error logging preserves error and cause identity", () => {
  const fields = modernMcpAdapterErrorLogFields(
    new Error("outer failure", { cause: new TypeError("inner failure") }),
  );
  assert.deepEqual(fields, {
    error: "outer failure",
    errorName: "Error",
    cause: {
      name: "TypeError",
      message: "inner failure",
    },
  });
});

function modernRequest(
  method: string,
  params: Record<string, unknown>,
  options: {
    headerMethod?: string;
    headerName?: string;
    signal?: AbortSignal;
  } = {},
): Request {
  const mcpName = typeof params.name === "string"
    ? params.name
    : typeof params.uri === "string"
      ? params.uri
      : undefined;
  return new Request("https://example.test/mcp", {
    method: "POST",
    signal: options.signal,
    headers: {
      "content-type": "application/json",
      "mcp-method": options.headerMethod ?? method,
      "mcp-protocol-version": "2026-07-28",
      ...(options.headerName || mcpName
        ? { "mcp-name": options.headerName ?? mcpName! }
        : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `modern-${method}`,
      method,
      params: {
        ...params,
        _meta: {
          ...objectValue(params._meta),
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
