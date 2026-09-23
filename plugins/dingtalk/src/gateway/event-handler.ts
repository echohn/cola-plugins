import { pluginMessage, resolvePluginText } from "@marswave/cola-plugin-sdk";
import type { PluginRuntime, DeliverFn, PluginLogger } from "@marswave/cola-plugin-sdk";
import { buildTextMessage, enforceMsgParamLimit } from "../api/client.js";
import type { DingTalkClient } from "../api/client.js";
import { parseRobotMessage } from "./message.js";
import type { ParsedRobotMessage } from "./message.js";
import { MessageDedup } from "./dedup.js";
import { downloadRobotMessageMedia } from "./media-download.js";

/** Reply sent to a group @mention while group chat is disabled. */
export const GROUP_DISABLED_NOTICE = pluginMessage(
  "channel.groupDisabled",
  "Group chat is not enabled. Send a direct message to the bot instead.",
);

/** Constraint+identity tag prepended to non-owner group messages. */
export const NON_OWNER_TAG_PREFIX = "[非所有者消息 · ";
export const OWNER_TAG_PREFIX = "[所有者]";

export type EventHandlerDeps = {
  i18n?: PluginRuntime["i18n"];
  accountId: string;
  client: DingTalkClient;
  logger: PluginLogger;
  deliver: DeliverFn;
  /** Second dedup layer on top of the Stream ack (server retries after 60s). */
  dedup: MessageDedup;
  /** When false, group @mentions get a "not supported" reply instead of reaching the agent. */
  groupEnabled: boolean;
  /** When set, group @mentions from this staff id are tagged as the owner; others get a constraint+identity tag. */
  ownerStaffId?: string;
  /** Observes the robotCode from inbound payloads for outbound replies. */
  onRobotCode?: (robotCode: string) => void;
};

/** Bilingual constraint line for non-owner group messages. */
function buildNonOwnerTag(parsed: ParsedRobotMessage): string {
  const nick = parsed.senderNick ?? "unknown";
  const id = parsed.senderId ?? "unknown";
  return (
    `${NON_OWNER_TAG_PREFIX}发送者: ${nick}(${id}) · ` +
    `约束：仅回复与本群相关的总结性内容，禁止提供文件、资料或任何私人信息；` +
    `Constraint: only reply with summaries relevant to this group; never provide files, materials, or any private information]`
  );
}

/** Tag a group message's text before it reaches the agent. Direct chats are left untouched. */
export function annotateGroupMessage(parsed: ParsedRobotMessage, ownerStaffId?: string): string {
  if (!parsed.isGroup) return parsed.text;
  if (ownerStaffId && parsed.senderId === ownerStaffId) {
    return `${OWNER_TAG_PREFIX}\n${parsed.text}`;
  }
  return `${buildNonOwnerTag(parsed)}\n${parsed.text}`;
}

/**
 * Handle one robot message payload (JSON string) from the Stream channel.
 *
 * Authorization is delegated to the host's SDK access gate: this handler only
 * delivers, populating `conversation` (direct vs group) and `mentionedBot` so
 * the gate can authorize per-sender (DM) or per-group (@bot-gated).
 */
export async function handleRobotMessage(
  deps: EventHandlerDeps,
  rawPayload: string,
): Promise<void> {
  const { accountId, logger, deliver, dedup } = deps;

  const parsed = parseRobotMessage(rawPayload, logger);
  if (!parsed) return;

  if (parsed.robotCode) deps.onRobotCode?.(parsed.robotCode);

  // Second dedup layer: the Stream ack prevents most server retries, but a
  // redelivered msgId must never reach the agent twice.
  if (dedup.isDuplicate(parsed.msgId)) return;

  if (parsed.isGroup && !deps.groupEnabled) {
    await sendGroupDisabledNotice(deps, parsed);
    return;
  }

  const text = parsed.text.trim();
  if (!text) return;

  // Group messages: prepend a sender tag (+ owner-vs-non-owner constraint) so
  // the agent knows who posted. Direct chats are left untouched.
  const messageToDeliver = parsed.isGroup ? annotateGroupMessage(parsed, deps.ownerStaffId) : text;

  // Direct-chat replies require senderStaffId, which DingTalk only pushes for
  // published robot versions. Without it there is no way to answer.
  if (!parsed.isGroup && !parsed.senderStaffId) {
    logger.warn(
      `dingtalk[${accountId}]: direct message without senderStaffId (robot version not published?), cannot reply`,
    );
    return;
  }

  const senderId = parsed.senderStaffId ?? parsed.senderId;
  if (!senderId) {
    logger.warn("DingTalk message missing sender id, skipping");
    return;
  }

  // Media messages carry a downloadCode; exchange it for a temp URL, download
  // to a local path, and hand the path to the agent as an attachment. When the
  // download succeeds the text is still the short summary (the file itself is
  // the payload); failures keep the summary only.
  let attachment: string | undefined;
  if (parsed.media?.downloadCode) {
    if (!parsed.robotCode) {
      logger.warn(`dingtalk[${accountId}]: media message without robotCode, cannot download`);
    } else {
      attachment = await downloadRobotMessageMedia(deps.client, parsed, logger);
    }
  }

  await deliver({
    sessionId: parsed.isGroup
      ? ["conversation", accountId, parsed.conversationId]
      : ["staff", accountId, parsed.senderStaffId!],
    sender: { id: senderId, name: parsed.senderNick },
    conversation: parsed.isGroup
      ? { kind: "group", id: parsed.conversationId }
      : { kind: "direct", id: parsed.senderStaffId! },
    mentionedBot: parsed.isGroup ? true : undefined,
    deliveryContext: {
      to: buildDeliveryTarget(parsed),
      accountId,
      messageId: parsed.msgId,
    },
    message: messageToDeliver,
    ...(attachment ? { attachments: [attachment] } : {}),
  });
}

function buildDeliveryTarget(parsed: ParsedRobotMessage): string {
  return parsed.isGroup ? `conversation:${parsed.conversationId}` : `staff:${parsed.senderStaffId}`;
}

async function sendGroupDisabledNotice(
  deps: EventHandlerDeps,
  parsed: ParsedRobotMessage,
): Promise<void> {
  const { accountId, logger, client } = deps;
  if (!parsed.robotCode) {
    logger.warn(`dingtalk[${accountId}]: cannot send group-disabled notice, robotCode missing`);
    return;
  }
  const notice = deps.i18n
    ? await deps.i18n.text(GROUP_DISABLED_NOTICE)
    : resolvePluginText(GROUP_DISABLED_NOTICE, undefined, "en");
  try {
    await client.sendGroupMessage(
      parsed.robotCode,
      parsed.conversationId,
      enforceMsgParamLimit(buildTextMessage(notice)),
    );
  } catch (err) {
    logger.warn(
      `dingtalk[${accountId}]: failed to send group-disabled notice to ${parsed.conversationId}`,
      err,
    );
  }
}
