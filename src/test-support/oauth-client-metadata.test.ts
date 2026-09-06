import assert from "node:assert/strict";
import dns from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import https, { type RequestOptions } from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import type { TestContext } from "node:test";

export const chatGptClientMetadata = {
  client_id: "https://chatgpt.com/oauth/client.json",
  client_name: "ChatGPT",
  redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
  token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
  token_endpoint_auth_method: "private_key_jwt",
};

// Mock only outbound I/O: exercise the production DNS callback, HTTP reader,
// metadata validation and cache without relying on public network availability.
export function mockClientMetadataEndpoint(t: TestContext, options: {
  body?: unknown;
  rawBody?: string;
  statusCode?: number;
  contentType?: string;
  addresses?: LookupAddress[];
  lookupOptions?: LookupOptions;
  dnsError?: Error;
  stallDns?: boolean;
} = {}) {
  const addresses = options.addresses ?? [
    { address: "1.1.1.1", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ];
  const lookup = t.mock.method(dns, "lookup", (async () => {
    if (options.stallDns) return new Promise(() => {});
    if (options.dnsError) throw options.dnsError;
    return addresses;
  }) as unknown as typeof dns.lookup);
  const resolvedAddresses: Array<string | LookupAddress[]> = [];
  const request = t.mock.method(https, "request", ((
    url: URL,
    requestOptions: RequestOptions,
    onResponse: (response: IncomingMessage) => void,
  ) => {
    const req = new EventEmitter() as ClientRequest;
    req.setTimeout = () => req;
    req.destroy = (error?: Error) => {
      if (error) queueMicrotask(() => req.emit("error", error));
      return req;
    };
    req.end = (() => {
      const dnsOptions = options.lookupOptions ?? { all: true, family: 0 };
      requestOptions.lookup!(url.hostname, dnsOptions, (error, address, family) => {
        if (error) {
          req.destroy(error);
          return;
        }
        try {
          // Node's automatic family selection requires the list form when all=true.
          if (dnsOptions.all) assert.ok(Array.isArray(address), "lookup(all=true) must return an address list");
          else {
            assert.equal(typeof address, "string");
            assert.ok(family === 4 || family === 6);
          }
          resolvedAddresses.push(address);
          const response = new PassThrough() as unknown as IncomingMessage;
          response.statusCode = options.statusCode ?? 200;
          response.headers = { "content-type": options.contentType ?? "application/json" };
          onResponse(response);
          (response as unknown as PassThrough).end(options.rawBody ?? JSON.stringify(options.body ?? chatGptClientMetadata));
        } catch (caught) {
          req.destroy(caught as Error);
        }
      });
      return req;
    }) as ClientRequest["end"];
    return req;
  }) as typeof https.request);
  syncBuiltinESMExports();
  t.after(() => {
    request.mock.restore();
    lookup.mock.restore();
    syncBuiltinESMExports();
  });
  return { request, lookup, resolvedAddresses };
}
