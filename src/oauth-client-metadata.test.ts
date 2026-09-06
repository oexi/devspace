import assert from "node:assert/strict";
import test from "node:test";
import { InvalidClientError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { chatGptClientMetadata, mockClientMetadataEndpoint } from "./test-support/oauth-client-metadata.test.js";
import {
  HttpsClientMetadataDocumentResolver,
  isPublicClientMetadataAddress,
  parseClientMetadataUrl,
} from "./oauth-client-metadata.js";

test("client metadata URLs require HTTPS, a non-root path, and public literal addresses", () => {
  assert.equal(parseClientMetadataUrl("https://client.example.com/oauth/client.json")?.href,
    "https://client.example.com/oauth/client.json");
  assert.equal(parseClientMetadataUrl("http://client.example.com/oauth/client.json"), undefined);
  assert.equal(parseClientMetadataUrl("https://client.example.com/"), undefined);
  assert.equal(parseClientMetadataUrl("https://127.0.0.1/client.json"), undefined);
  assert.equal(parseClientMetadataUrl("https://[::1]/client.json"), undefined);
});

test("client metadata SSRF guard rejects special-use IP ranges", () => {
  for (const address of [
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "192.0.2.1",
    "192.31.196.1",
    "192.52.193.1",
    "192.175.48.1",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2002::1",
    "3fff::1",
  ]) {
    assert.equal(isPublicClientMetadataAddress(address), false, address);
  }
  assert.equal(isPublicClientMetadataAddress("8.8.8.8"), true);
  assert.equal(isPublicClientMetadataAddress("2606:4700:4700::1111"), true);
});

test("client metadata resolver rejects hostnames that resolve to loopback", async () => {
  const resolver = new HttpsClientMetadataDocumentResolver();
  await assert.rejects(
    resolver.resolve("https://localhost/oauth/client.json"),
    /special-use address/,
  );
});

test("client metadata lookup supports Node's all-address callback and caches a resolved client", async (t) => {
  const endpoint = mockClientMetadataEndpoint(t, {
    body: { ...chatGptClientMetadata, token_endpoint_auth_method: "none" },
  });
  const resolver = new HttpsClientMetadataDocumentResolver();
  const client = await resolver.resolve(chatGptClientMetadata.client_id);
  assert.equal(client?.client_id, chatGptClientMetadata.client_id);
  assert.equal(await resolver.resolve(chatGptClientMetadata.client_id), client);
  assert.equal(endpoint.request.mock.callCount(), 1);
  assert.deepEqual(endpoint.resolvedAddresses, [[
    { address: "1.1.1.1", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ]]);
});

test("client metadata accepts ChatGPT's method list over its legacy preference", async (t) => {
  mockClientMetadataEndpoint(t, { lookupOptions: { all: false, family: 4 } });
  const client = await new HttpsClientMetadataDocumentResolver().resolve(chatGptClientMetadata.client_id);
  assert.equal(client?.token_endpoint_auth_method, "none");
});

test("client metadata lookup honors a requested address family", async (t) => {
  const endpoint = mockClientMetadataEndpoint(t, {
    body: { ...chatGptClientMetadata, token_endpoint_auth_method: "none" },
    lookupOptions: { all: false, family: 6 },
  });
  await new HttpsClientMetadataDocumentResolver().resolve(chatGptClientMetadata.client_id);
  assert.deepEqual(endpoint.resolvedAddresses, ["2606:4700:4700::1111"]);
});

test("client metadata rejects methods with no supported intersection", async (t) => {
  for (const fields of [
    { token_endpoint_auth_methods_supported: ["private_key_jwt"], token_endpoint_auth_method: "none" },
    { token_endpoint_auth_methods_supported: undefined, token_endpoint_auth_method: "private_key_jwt" },
    { token_endpoint_auth_methods_supported: [] },
  ]) {
    await t.test(JSON.stringify(fields), async (nested) => {
      mockClientMetadataEndpoint(nested, {
        body: { ...chatGptClientMetadata, ...fields },
        lookupOptions: { all: false },
      });
      await assert.rejects(
        new HttpsClientMetadataDocumentResolver().resolve(chatGptClientMetadata.client_id),
        InvalidClientError,
      );
    });
  }
});

test("client metadata lookup rejects mixed public and private DNS answers", async (t) => {
  mockClientMetadataEndpoint(t, { addresses: [
    { address: "1.1.1.1", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ] });
  await assert.rejects(
    new HttpsClientMetadataDocumentResolver().resolve(chatGptClientMetadata.client_id),
    { name: "InvalidClientError", message: /special-use address/ },
  );
});

test("client metadata network errors expose a safe actionable OAuth error", async (t) => {
  mockClientMetadataEndpoint(t, { dnsError: new Error("private diagnostic with a secret URL") });
  await assert.rejects(
    new HttpsClientMetadataDocumentResolver().resolve(chatGptClientMetadata.client_id),
    (error: unknown) => error instanceof ServerError
      && /DNS.*HTTPS/.test(error.message)
      && !error.message.includes("private diagnostic"),
  );
});

test("client metadata retrieval has a deadline even when DNS never resolves", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  mockClientMetadataEndpoint(t, { stallDns: true });
  const result = new HttpsClientMetadataDocumentResolver().resolve(chatGptClientMetadata.client_id);
  const rejected = assert.rejects(result, { name: "ServerError", message: /timed out/ });
  t.mock.timers.tick(5_000);
  await rejected;
});

test("client metadata rejects invalid HTTP responses and documents with OAuth errors", async (t) => {
  const cases = [
    { statusCode: 302 },
    { contentType: "text/html" },
    { rawBody: "not JSON" },
    { rawBody: " ".repeat(64 * 1024 + 1) },
    { body: { ...chatGptClientMetadata, client_id: "https://client.example.com/other.json" } },
  ];
  for (const [index, options] of cases.entries()) {
    await t.test(String(index), async (nested) => {
      mockClientMetadataEndpoint(nested, options);
      await assert.rejects(
        new HttpsClientMetadataDocumentResolver().resolve(chatGptClientMetadata.client_id),
        InvalidClientError,
      );
    });
  }
});
