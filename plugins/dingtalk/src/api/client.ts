import { AccessTokenManager, type FetchLike } from "./token.js";
import type { DingTalkAccountConfig } from "./types.js";

const API_BASE = "https://api.dingtalk.com";
/** DingTalk rejects robot message payloads whose msgParam exceeds 15000 UTF-8 bytes. */
export const MAX_MSG_PARAM_BYTES = 15000;
const TRUNCATION_SUFFIX = "…(truncated)";

export type OutgoingMessage = {
  msgKey: string;
  msgParam: string;
};

/**
 * Build a plain-text robot message (`sampleText`).
 */
export function buildTextMessage(content: string): OutgoingMessage {
  return { msgKey: "sampleText", msgParam: JSON.stringify({ content }) };
}

/**
 * Build a markdown robot message (`sampleMarkdown`). The title is derived from
 * the first meaningful line and is used by DingTalk for notification previews.
 */
export function buildMarkdownMessage(text: string): OutgoingMessage {
  return {
    msgKey: "sampleMarkdown",
    msgParam: JSON.stringify({ title: markdownTitle(text), text }),
  };
}

function markdownTitle(text: string): string {
  const firstLine =
    text
      .split("\n")
      .map((line) => line.replace(/[#*_>`~[\]]/g, "").trim())
      .find(Boolean) ?? "";
  if (!firstLine) return "Cola";
  return firstLine.length > 20 ? `${firstLine.slice(0, 20)}…` : firstLine;
}

/**
 * Ensure the serialized msgParam stays within DingTalk's 15000-byte budget.
 * Oversized message text is truncated (UTF-8-safe via a binary search on the
 * character count) rather than rejected by the API.
 */
export function enforceMsgParamLimit(
  message: OutgoingMessage,
  maxBytes: number = MAX_MSG_PARAM_BYTES,
): OutgoingMessage {
  if (Buffer.byteLength(message.msgParam, "utf8") <= maxBytes) return message;

  const parsed = JSON.parse(message.msgParam) as Record<string, string>;
  const field = message.msgKey === "sampleText" ? "content" : "text";
  const original = typeof parsed[field] === "string" ? parsed[field] : "";
  if (!original) return message; // Nothing trimmable; let the API error surface.

  const fits = (length: number): boolean => {
    parsed[field] = `${original.slice(0, length)}${TRUNCATION_SUFFIX}`;
    return Buffer.byteLength(JSON.stringify(parsed), "utf8") <= maxBytes;
  };

  let lo = 0;
  let hi = original.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (fits(mid)) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  fits(lo);

  return { msgKey: message.msgKey, msgParam: JSON.stringify(parsed) };
}

/**
 * Minimal DingTalk REST client for robot message sending. The Stream channel
 * is receive-only; all replies go through these REST endpoints with an access
 * token from the token manager. Tokens are only sent as a request header and
 * are never logged or embedded in error messages.
 */
export class DingTalkClient {
  constructor(
    private readonly tokenManager: AccessTokenManager,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  /** Direct-chat reply via /v1.0/robot/oToMessages/batchSend. */
  async sendOToMessage(
    robotCode: string,
    staffId: string,
    message: OutgoingMessage,
  ): Promise<void> {
    await this.request("/v1.0/robot/oToMessages/batchSend", {
      robotCode,
      userIds: [staffId],
      msgKey: message.msgKey,
      msgParam: message.msgParam,
    });
  }

  /** Group-chat reply via /v1.0/robot/groupMessages/send. */
  async sendGroupMessage(
    robotCode: string,
    openConversationId: string,
    message: OutgoingMessage,
  ): Promise<void> {
    await this.request("/v1.0/robot/groupMessages/send", {
      robotCode,
      openConversationId,
      msgKey: message.msgKey,
      msgParam: message.msgParam,
    });
  }

  async request(path: string, body: Record<string, unknown>): Promise<unknown> {
    const token = await this.tokenManager.getToken();
    let response: Response;
    try {
      response = await this.fetchImpl(`${API_BASE}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": token,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `DingTalk API ${path} request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(
        `DingTalk API ${path} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    return response.json().catch(() => undefined);
  }
}

type CachedEntry = {
  client: DingTalkClient;
  clientId: string;
  clientSecret: string;
};

const clientCache = new Map<string, CachedEntry>();

export function getDingTalkClient(
  accountId: string,
  config: DingTalkAccountConfig,
): DingTalkClient {
  const { clientId, clientSecret } = config;
  if (!clientId || !clientSecret) {
    throw new Error(`DingTalk account "${accountId}" missing clientId or clientSecret`);
  }

  const cached = clientCache.get(accountId);
  if (cached && cached.clientId === clientId && cached.clientSecret === clientSecret) {
    return cached.client;
  }

  const client = new DingTalkClient(new AccessTokenManager(clientId, clientSecret));
  clientCache.set(accountId, { client, clientId, clientSecret });
  return client;
}

export function clearClientCache(): void {
  clientCache.clear();
}
