import type { PluginLogger } from "@marswave/cola-plugin-sdk";
import { buildMarkdownMessage, enforceMsgParamLimit } from "../api/client.js";
import type { DingTalkClient } from "../api/client.js";

/**
 * Send a Cola reply to a DingTalk delivery target.
 *
 * Targets follow the inbound session convention: `staff:<senderStaffId>` for
 * direct chats (oToMessages) and `conversation:<conversationId>` for group
 * chats (groupMessages). Replies are sent as markdown robot messages; the
 * msgParam is guarded against DingTalk's 15000-byte limit.
 */
export async function sendText(
  client: DingTalkClient,
  deliveryTo: string,
  text: string,
  robotCode: string | undefined,
  logger: PluginLogger,
): Promise<void> {
  if (!robotCode) {
    throw new Error("DingTalk robotCode is not known yet; unable to send");
  }

  const message = enforceMsgParamLimit(buildMarkdownMessage(text));

  try {
    if (deliveryTo.startsWith("staff:")) {
      await client.sendOToMessage(robotCode, deliveryTo.slice("staff:".length), message);
      return;
    }
    if (deliveryTo.startsWith("conversation:")) {
      await client.sendGroupMessage(robotCode, deliveryTo.slice("conversation:".length), message);
      return;
    }
    throw new Error(`Unsupported DingTalk delivery target: ${deliveryTo}`);
  } catch (err) {
    logger.error(`Failed to send text to ${deliveryTo}`, err);
    throw err;
  }
}
