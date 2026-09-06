import assert from "node:assert/strict";
import test from "node:test";
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
