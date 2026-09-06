import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { LookupAddress } from "node:dns";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import ipaddr from "ipaddr.js";
import * as z from "zod/v4";

const MAX_METADATA_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const MAX_CACHE_TTL_MS = 60 * 60 * 1_000;

const clientMetadataSchema = z.object({
  client_id: z.url(),
  client_name: z.string().trim().min(1),
  redirect_uris: z.array(z.url()).min(1),
  token_endpoint_auth_method: z.literal("none").optional().default("none"),
  grant_types: z.array(z.string()).optional().default(["authorization_code", "refresh_token"]),
  response_types: z.array(z.string()).optional().default(["code"]),
  client_uri: z.url().optional(),
  logo_uri: z.union([z.url(), z.literal("")]).optional(),
  scope: z.string().optional(),
  contacts: z.array(z.string()).optional(),
  tos_uri: z.union([z.url(), z.literal("")]).optional(),
  policy_uri: z.string().optional(),
  software_id: z.string().optional(),
  software_version: z.string().optional(),
});

export interface ClientMetadataDocumentResolver {
  resolve(clientId: string): Promise<OAuthClientInformationFull | undefined>;
}

interface CachedClientMetadata {
  client: OAuthClientInformationFull;
  expiresAtMs: number;
}

export class HttpsClientMetadataDocumentResolver implements ClientMetadataDocumentResolver {
  private readonly cache = new Map<string, CachedClientMetadata>();

  constructor(private readonly now: () => number = Date.now) {}

  async resolve(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const clientUrl = parseClientMetadataUrl(clientId);
    if (!clientUrl) return undefined;

    const cached = this.cache.get(clientId);
    const nowMs = this.now();
    if (cached && cached.expiresAtMs > nowMs) return cached.client;
    if (cached) this.cache.delete(clientId);

    const fetched = await fetchClientMetadataDocument(clientUrl);
    const parsed = clientMetadataSchema.safeParse(fetched.body);
    if (!parsed.success) throw new Error("Invalid OAuth Client ID Metadata Document");
    if (parsed.data.client_id !== clientId) {
      throw new Error("OAuth Client ID Metadata Document client_id must match its URL exactly");
    }
    if (!parsed.data.grant_types.every((grant) => grant === "authorization_code" || grant === "refresh_token")) {
      throw new Error("OAuth Client ID Metadata Document requests an unsupported grant type");
    }
    if (!parsed.data.response_types.every((responseType) => responseType === "code")) {
      throw new Error("OAuth Client ID Metadata Document requests an unsupported response type");
    }

    const client: OAuthClientInformationFull = {
      ...parsed.data,
      client_id: clientId,
    };
    const ttlMs = metadataCacheTtlMs(fetched.cacheControl);
    if (ttlMs > 0) {
      this.cache.set(clientId, { client, expiresAtMs: nowMs + ttlMs });
    }
    return client;
  }
}

interface FetchedMetadataDocument {
  body: unknown;
  cacheControl?: string;
}

function fetchClientMetadataDocument(url: URL): Promise<FetchedMetadataDocument> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const finishResolve = (value: FetchedMetadataDocument) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const request = httpsRequest(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "DevSpace OAuth Client Metadata Resolver",
      },
      lookup: safePublicLookup,
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finishReject(new Error(`OAuth Client ID Metadata Document returned HTTP ${response.statusCode ?? "unknown"}`));
        return;
      }
      const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
      if (!contentType.includes("application/json") && !contentType.includes("+json")) {
        response.resume();
        finishReject(new Error("OAuth Client ID Metadata Document must use a JSON content type"));
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.byteLength;
        if (totalBytes > MAX_METADATA_BYTES) {
          response.destroy(new Error("OAuth Client ID Metadata Document exceeds the size limit"));
          return;
        }
        chunks.push(buffer);
      });
      response.once("error", finishReject);
      response.once("end", () => {
        if (settled) return;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          finishResolve({
            body,
            cacheControl: headerValue(response.headers["cache-control"]),
          });
        } catch {
          finishReject(new Error("OAuth Client ID Metadata Document is not valid JSON"));
        }
      });
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error("OAuth Client ID Metadata Document request timed out"));
    });
    request.once("error", finishReject);
    request.end();
  });
}

const safePublicLookup: NonNullable<RequestOptions["lookup"]> = (hostname, _options, callback) => {
  void dnsLookup(hostname, { all: true, verbatim: true })
    .then((addresses) => {
      if (addresses.length === 0) throw new Error("OAuth client metadata host did not resolve");
      if (addresses.some((address) => !isPublicClientMetadataAddress(address.address))) {
        throw new Error("OAuth Client ID Metadata Document host resolves to a special-use address");
      }
      const selected = addresses[0] as LookupAddress;
      callback(null, selected.address, selected.family);
    })
    .catch((error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), "", 4));
};

export function isPublicClientMetadataAddress(address: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return false;
  }
  if (parsed.range() !== "unicast") return false;

  if (parsed.kind() === "ipv4") {
    const ipv4 = parsed as ipaddr.IPv4;
    return ![
      ["192.31.196.0", 24],
      ["192.52.193.0", 24],
      ["192.175.48.0", 24],
      ["198.18.0.0", 15],
    ].some(([network, prefix]) => ipv4.match(ipaddr.parse(network as string) as ipaddr.IPv4, prefix as number));
  }

  const ipv6 = parsed as ipaddr.IPv6;
  if (ipv6.isIPv4MappedAddress()) {
    return isPublicClientMetadataAddress(ipv6.toIPv4Address().toString());
  }
  return ![
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
    ["5f00::", 16],
  ].some(([network, prefix]) => ipv6.match(ipaddr.parse(network as string) as ipaddr.IPv6, prefix as number));
}

export function parseClientMetadataUrl(clientId: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (url.username || url.password || url.hash) return undefined;
  if (!url.pathname || url.pathname === "/") return undefined;
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  if (ipaddr.isValid(hostname) && !isPublicClientMetadataAddress(hostname)) return undefined;
  return url;
}

function metadataCacheTtlMs(cacheControl: string | undefined): number {
  if (!cacheControl) return DEFAULT_CACHE_TTL_MS;
  if (/(?:^|,)\s*no-store\s*(?:,|$)/i.test(cacheControl)) return 0;
  const match = /(?:^|,)\s*max-age=(\d+)\s*(?:,|$)/i.exec(cacheControl);
  if (!match) return DEFAULT_CACHE_TTL_MS;
  const seconds = Number(match[1]);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return 0;
  return Math.min(seconds * 1_000, MAX_CACHE_TTL_MS);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(",") : value;
}
