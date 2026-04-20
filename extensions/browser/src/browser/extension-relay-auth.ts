import { createHmac } from "node:crypto";
import { resolveSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { loadConfig } from "../config/config.js";

const RELAY_TOKEN_CONTEXT = "openclaw-extension-relay-v1";
const DEFAULT_RELAY_PROBE_TIMEOUT_MS = 500;
const OPENCLAW_RELAY_BROWSER = "OpenClaw/extension-relay";

export class ExtensionRelaySecretUnavailableError extends Error {
  readonly isSecretRefUnavailable = true;
}

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function resolveGatewayAuthToken(): Promise<string | null> {
  const envToken =
    trimToUndefined(process.env.OPENCLAW_GATEWAY_TOKEN) ??
    trimToUndefined(process.env.CLAWDBOT_GATEWAY_TOKEN);
  if (envToken) {
    return envToken;
  }

  try {
    const cfg = loadConfig();
    const resolved = resolveSecretInputString({
      value: cfg.gateway?.auth?.token,
      defaults: cfg.secrets?.defaults,
      path: "gateway.auth.token",
      mode: "inspect",
    });
    if (resolved.status === "available") {
      return resolved.value;
    }
    if (resolved.ref) {
      throw new ExtensionRelaySecretUnavailableError(
        "extension relay requires a resolved gateway token, but gateway.auth.token SecretRef is unavailable. Set OPENCLAW_GATEWAY_TOKEN or resolve your secret provider.",
      );
    }
  } catch (err) {
    if (err instanceof ExtensionRelaySecretUnavailableError) {
      throw err;
    }
  }

  return null;
}

export function deriveRelayAuthToken(gatewayToken: string, port: number): string {
  return createHmac("sha256", gatewayToken)
    .update(`${RELAY_TOKEN_CONTEXT}:${port}`)
    .digest("hex");
}

async function resolveRelayAcceptedTokensForPort(port: number): Promise<string[]> {
  const gatewayToken = await resolveGatewayAuthToken();
  if (!gatewayToken) {
    throw new Error(
      "extension relay requires gateway auth token (set gateway.auth.token or OPENCLAW_GATEWAY_TOKEN)",
    );
  }
  const relayToken = deriveRelayAuthToken(gatewayToken, port);
  return relayToken === gatewayToken ? [relayToken] : [relayToken, gatewayToken];
}

export async function resolveRelayAuthTokenForPort(port: number): Promise<string> {
  return (await resolveRelayAcceptedTokensForPort(port))[0];
}

export async function probeAuthenticatedOpenClawRelay(params: {
  baseUrl: string;
  relayAuthHeader: string;
  relayAuthToken: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(),
    params.timeoutMs ?? DEFAULT_RELAY_PROBE_TIMEOUT_MS,
  );
  try {
    const versionUrl = new URL("/json/version", `${params.baseUrl}/`).toString();
    const res = await fetch(versionUrl, {
      signal: ctrl.signal,
      headers: { [params.relayAuthHeader]: params.relayAuthToken },
    });
    if (!res.ok) {
      return false;
    }
    const body = (await res.json()) as { Browser?: unknown };
    return trimToUndefined(body.Browser) === OPENCLAW_RELAY_BROWSER;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
