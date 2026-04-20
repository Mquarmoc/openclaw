import { isLoopbackHost } from "../gateway/net.js";
import {
  probeAuthenticatedOpenClawRelay,
  resolveRelayAuthTokenForPort,
} from "./extension-relay-auth.js";

const RELAY_AUTH_HEADER = "x-openclaw-relay-token";

type ChromeExtensionRelayServer = {
  host: string;
  bindHost: string;
  port: number;
  baseUrl: string;
  cdpWsUrl: string;
  stop: () => Promise<void>;
};

const relayRuntimeByPort = new Map<
  number,
  {
    server: ChromeExtensionRelayServer;
    relayAuthToken: string;
  }
>();

function parseUrlPort(parsed: URL): number | null {
  const port =
    parsed.port.trim() !== ""
      ? Number(parsed.port)
      : parsed.protocol === "https:"
        ? 443
        : 80;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return null;
  }
  return port;
}

function parseBaseUrl(raw: string): {
  host: string;
  port: number;
  baseUrl: string;
} {
  const parsed = new URL(raw.trim().replace(/\/$/, ""));
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`extension relay cdpUrl must be http(s), got ${parsed.protocol}`);
  }
  const port = parseUrlPort(parsed);
  if (!port) {
    throw new Error(`extension relay cdpUrl has invalid port: ${parsed.port || "(empty)"}`);
  }
  return {
    host: parsed.hostname,
    port,
    baseUrl: parsed.toString().replace(/\/$/, ""),
  };
}

function relayAuthTokenForUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!isLoopbackHost(parsed.hostname)) {
      return null;
    }
    const port = parseUrlPort(parsed);
    if (!port) {
      return null;
    }
    return relayRuntimeByPort.get(port)?.relayAuthToken ?? null;
  } catch {
    return null;
  }
}

export function getChromeExtensionRelayAuthHeaders(url: string): Record<string, string> {
  const token = relayAuthTokenForUrl(url);
  return token ? { [RELAY_AUTH_HEADER]: token } : {};
}

export async function ensureChromeExtensionRelayServer(opts: {
  cdpUrl: string;
  bindHost?: string;
}): Promise<ChromeExtensionRelayServer> {
  const info = parseBaseUrl(opts.cdpUrl);
  if (!isLoopbackHost(info.host)) {
    throw new Error(`extension relay requires loopback cdpUrl host (got ${info.host})`);
  }

  const bindHost = opts.bindHost ?? info.host;
  const existing = relayRuntimeByPort.get(info.port);
  if (existing?.server.bindHost === bindHost) {
    return existing.server;
  }

  const relayAuthToken = await resolveRelayAuthTokenForPort(info.port);
  const isOpenClawRelay = await probeAuthenticatedOpenClawRelay({
    baseUrl: info.baseUrl,
    relayAuthHeader: RELAY_AUTH_HEADER,
    relayAuthToken,
  });
  if (!isOpenClawRelay) {
    throw new Error(`Chrome extension relay is not reachable at ${info.baseUrl}`);
  }

  const server: ChromeExtensionRelayServer = {
    host: info.host,
    bindHost,
    port: info.port,
    baseUrl: info.baseUrl,
    cdpWsUrl: `ws://${info.host}:${info.port}/cdp`,
    stop: async () => {
      relayRuntimeByPort.delete(info.port);
    },
  };
  relayRuntimeByPort.set(info.port, { server, relayAuthToken });
  return server;
}

export async function stopChromeExtensionRelayServer(opts: { cdpUrl: string }): Promise<boolean> {
  const info = parseBaseUrl(opts.cdpUrl);
  const existing = relayRuntimeByPort.get(info.port);
  if (!existing) {
    return false;
  }
  await existing.server.stop();
  return true;
}
