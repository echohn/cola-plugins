import type { PluginLogger } from "@marswave/cola-plugin-sdk";
import type { DingTalkClient } from "../api/client.js";
import type { ParsedRobotMessage } from "./message.js";

/** Local download size cap for inbound robot media (matches the plugin note). */
export const MAX_MEDIA_DOWNLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Download a robot-received media message to a local temp path so the agent
 * can consume the real file instead of a text summary.
 *
 * Returns the temp path on success, or `undefined` on any failure —
 * downloading must never block message delivery, so the caller keeps the text
 * summary as a fallback. The downloaded file is owned by the host once the
 * message is delivered (it takes custody of the `attachments` array); on
 * failure the path is cleaned up here.
 */
export async function downloadRobotMessageMedia(
  client: DingTalkClient,
  parsed: ParsedRobotMessage,
  logger: PluginLogger,
): Promise<string | undefined> {
  const { downloadCode, fileName } = parsed.media ?? {};
  const robotCode = parsed.robotCode;
  if (!downloadCode || !robotCode) {
    logger.warn("DingTalk media message missing downloadCode or robotCode, skipping download");
    return undefined;
  }

  const fallbackName = fileName ?? mediaDefaultExtension(parsed.media?.kind ?? "unknown");
  try {
    const path = await client.downloadMessageFile(robotCode, downloadCode, fallbackName, {
      maxBytes: MAX_MEDIA_DOWNLOAD_BYTES,
    });
    logger.info(`Downloaded DingTalk ${parsed.media?.kind ?? "media"} message media to ${path}`);
    return path;
  } catch (err) {
    logger.warn(
      `Failed to download DingTalk ${parsed.media?.kind ?? "media"} message media: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}

function mediaDefaultExtension(kind: string): string {
  switch (kind) {
    case "image":
      return "picture.jpg";
    case "audio":
      return "voice.amr";
    case "video":
      return "video.mp4";
    case "file":
      return "file";
    default:
      return "message";
  }
}
