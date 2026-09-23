import type { PluginLogger } from "@marswave/cola-plugin-sdk";

export type DingTalkRobotPayload = {
  /** "1" = direct chat, "2" = group chat */
  conversationType?: string;
  conversationId?: string;
  msgId?: string;
  msgtype?: string;
  text?: { content?: string };
  /** Only present when the robot version is published; required for direct-chat replies. */
  senderStaffId?: string;
  /** Sender id that is always present (used as fallback for identification). */
  senderId?: string;
  senderNick?: string;
  robotCode?: string;
  sessionWebhook?: string;
  sessionWebhookExpiredTime?: number;
  createAt?: number;
  isAdmin?: boolean;
  [key: string]: unknown;
};

export type ParsedRobotMessage = {
  text: string;
  msgId: string;
  isGroup: boolean;
  conversationId: string;
  /** Staff id of the sender when the robot version is published. */
  senderStaffId?: string;
  /** Always-present sender id (fallback identification). */
  senderId?: string;
  senderNick?: string;
  robotCode?: string;
  /**
   * Present for inbound media messages (file/picture/audio/video) that carry a
   * downloadCode and a file name. The gateway exchanges the downloadCode for a
   * temporary URL via /v1.0/robot/messageFiles/download, then downloads to a
   * local temp path so it can be handed to the agent as an attachment.
   */
  media?: {
    kind: "image" | "audio" | "video" | "file" | "unknown";
    downloadCode?: string;
    fileName?: string;
  };
};

export const GROUP_MENTION_PREFIX = "@机器人";

/**
 * Parse an inbound robot message pushed over the Stream channel
 * (topic /v1.0/im/bot/messages/get). Returns undefined when the payload is
 * unusable (invalid JSON or missing required identifiers).
 */
export function parseRobotMessage(
  raw: string | unknown,
  logger?: PluginLogger,
): ParsedRobotMessage | undefined {
  let payload: DingTalkRobotPayload;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw) as DingTalkRobotPayload;
    } catch (err) {
      logger?.warn(
        `Failed to parse DingTalk robot message: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  } else if (raw && typeof raw === "object") {
    payload = raw as DingTalkRobotPayload;
  } else {
    return undefined;
  }

  const { msgId, conversationId, conversationType } = payload;
  if (!msgId || !conversationId || !conversationType) {
    logger?.warn("DingTalk robot message missing msgId/conversationId/conversationType, skipping");
    return undefined;
  }

  const isGroup = conversationType === "2";
  const content =
    payload.msgtype === "text" ? (payload.text?.content ?? "") : summarizeMediaMessage(payload);
  const text = isGroup ? stripMentionPrefix(content) : content;

  return {
    text,
    msgId,
    isGroup,
    conversationId,
    senderStaffId: payload.senderStaffId,
    senderId: payload.senderId,
    senderNick: payload.senderNick,
    robotCode: payload.robotCode,
    media: extractMedia(payload),
  };
}

/**
 * Pull the downloadCode + file name (and a normalized media kind) out of a
 * non-text inbound payload. DingTalk nests these under `content` for several
 * types (file, picture, audio, video) and also at the top level for some.
 * Rich-text (`richText`) messages never carry a single downloadCode (they can
 * embed multiple pictures), so they yield `undefined` here and stay as a text
 * summary.
 */
export function extractMedia(
  payload: DingTalkRobotPayload,
): ParsedRobotMessage["media"] | undefined {
  if (payload.msgtype === "text" || payload.msgtype === "richText") return undefined;

  const content = (payload.content ?? {}) as {
    downloadCode?: string;
    fileName?: string;
  };

  const downloadCode = content.downloadCode ?? (payload as { downloadCode?: string }).downloadCode;
  const fileName =
    content.fileName ??
    (payload as { fileName?: string }).fileName ??
    downloadCode?.replace(/^\*+/, "");

  const kind = mediaKindForMsgType(payload.msgtype);
  return { kind, downloadCode, fileName: normalizeFileName(fileName) };
}

function mediaKindForMsgType(
  msgtype: string | undefined,
): NonNullable<ParsedRobotMessage["media"]>["kind"] {
  switch (msgtype) {
    case "picture":
      return "image";
    case "audio":
      return "audio";
    case "video":
      return "video";
    case "file":
      return "file";
    default:
      return "unknown";
  }
}

/** Normalize an inbound file name so the temp download path stays meaningful. */
function normalizeFileName(name: string | undefined): string | undefined {
  if (!name || !name.trim()) return undefined;
  const trimmed = name.trim();
  // DingTalk returns some media download names as a bare id with no extension;
  // keep whatever we have — sanitization happens at write time.
  return trimmed;
}

/**
 * Group messages arrive with a prepended "@机器人 " (or similar @handle)
 * prefix inserted by DingTalk. Strip the leading mention token followed by
 * whitespace (or the end of the message for a bare mention).
 */
export function stripMentionPrefix(text: string): string {
  return text.replace(/^@\S+(?:\s+|$)/, "").trim();
}

/**
 * First-release handling for non-text message types: deliver a text summary
 * instead of downloading media.
 */
export function summarizeMediaMessage(payload: DingTalkRobotPayload): string {
  switch (payload.msgtype) {
    case "picture":
      return "[图片]";
    case "audio":
      return "[语音]";
    case "video":
      return "[视频]";
    case "richText": {
      const inline = extractRichText(payload);
      return inline ? `[图文] ${inline}` : "[图文]";
    }
    case "file": {
      const fileName =
        (typeof payload.fileName === "string" && payload.fileName) ||
        (typeof (payload.content as { fileName?: unknown } | undefined)?.fileName === "string"
          ? (payload.content as { fileName: string }).fileName
          : undefined);
      return fileName ? `[文件: ${fileName}]` : "[文件]";
    }
    case "post":
      return "[富文本]";
    default:
      return `[${payload.msgtype ?? "unknown"}]`;
  }
}

function extractRichText(payload: DingTalkRobotPayload): string | undefined {
  const content = payload.content as
    | { richArray?: Array<{ type?: string; text?: string }> }
    | undefined;
  const richArray = content?.richArray;
  if (!Array.isArray(richArray)) return undefined;
  const text = richArray
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("")
    .trim();
  return text || undefined;
}

/**
 * Stable delivery targets: direct chat → `staff:<senderStaffId>`,
 * group chat → `conversation:<conversationId>`.
 */
export function buildSessionTarget(parsed: ParsedRobotMessage): string {
  return parsed.isGroup ? `conversation:${parsed.conversationId}` : `staff:${parsed.senderStaffId}`;
}
