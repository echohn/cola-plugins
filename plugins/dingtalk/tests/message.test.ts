import { describe, expect, it, vi } from "vitest";
import {
  buildSessionTarget,
  parseRobotMessage,
  stripMentionPrefix,
  summarizeMediaMessage,
} from "../src/gateway/message.js";
import { MessageDedup } from "../src/gateway/dedup.js";

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never;

function directPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    conversationId: "cid-test-1",
    conversationType: "1",
    msgId: "msg-test-1",
    msgtype: "text",
    text: { content: "hello cola" },
    senderStaffId: "staff-001",
    senderId: "sender-001",
    senderNick: "Tester",
    robotCode: "ding-test-robot",
    sessionWebhook: "https://oapi.dingtalk.com/robot/send?sessionWebhook=test",
    sessionWebhookExpiredTime: 9999999999999,
    createAt: 1700000000000,
    ...overrides,
  });
}

describe("parseRobotMessage", () => {
  it("parses a direct text message and resolves a staff session target", () => {
    const parsed = parseRobotMessage(directPayload(), logger);
    expect(parsed).toMatchObject({
      text: "hello cola",
      msgId: "msg-test-1",
      isGroup: false,
      conversationId: "cid-test-1",
      senderStaffId: "staff-001",
      robotCode: "ding-test-robot",
    });
    expect(buildSessionTarget(parsed!)).toBe("staff:staff-001");
  });

  it("parses a group message and resolves a conversation session target", () => {
    const parsed = parseRobotMessage(
      directPayload({
        conversationType: "2",
        text: { content: "@机器人 what is up" },
        senderStaffId: "staff-002",
      }),
      logger,
    );
    expect(parsed).toMatchObject({
      text: "what is up",
      isGroup: true,
    });
    expect(buildSessionTarget(parsed!)).toBe("conversation:cid-test-1");
  });

  it("returns undefined for invalid JSON", () => {
    expect(parseRobotMessage("not json", logger)).toBeUndefined();
  });

  it("returns undefined when required identifiers are missing", () => {
    expect(parseRobotMessage(directPayload({ msgId: undefined }), logger)).toBeUndefined();
    expect(parseRobotMessage(directPayload({ conversationId: undefined }), logger)).toBeUndefined();
    expect(
      parseRobotMessage(directPayload({ conversationType: undefined }), logger),
    ).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("accepts already-parsed payloads", () => {
    const parsed = parseRobotMessage({
      conversationType: "1",
      conversationId: "c",
      msgId: "m",
      msgtype: "text",
      text: { content: "hi" },
    });
    expect(parsed?.text).toBe("hi");
  });
});

describe("stripMentionPrefix", () => {
  it("strips the DingTalk @机器人 prefix with a trailing space", () => {
    expect(stripMentionPrefix("@机器人 help me")).toBe("help me");
  });

  it("strips a bare mention with no trailing space", () => {
    expect(stripMentionPrefix("@机器人")).toBe("");
  });

  it("strips a full-width space after the mention", () => {
    expect(stripMentionPrefix("@机器人　help me")).toBe("help me");
  });

  it("returns empty text when the message is only a mention", () => {
    expect(stripMentionPrefix("@机器人")).toBe("");
  });
});

describe("summarizeMediaMessage", () => {
  const base = { conversationType: "2", conversationId: "c", msgId: "m" };

  it("summarizes picture, audio, and video messages", () => {
    expect(summarizeMediaMessage({ ...base, msgtype: "picture" })).toBe("[图片]");
    expect(summarizeMediaMessage({ ...base, msgtype: "audio" })).toBe("[语音]");
    expect(summarizeMediaMessage({ ...base, msgtype: "video" })).toBe("[视频]");
  });

  it("summarizes file messages with the file name when present", () => {
    expect(summarizeMediaMessage({ ...base, msgtype: "file", fileName: "report.pdf" })).toBe(
      "[文件: report.pdf]",
    );
    expect(
      summarizeMediaMessage({ ...base, msgtype: "file", content: { downloadCode: "x" } }),
    ).toBe("[文件]");
  });

  it("extracts inline text from richText messages", () => {
    expect(
      summarizeMediaMessage({
        ...base,
        msgtype: "richText",
        content: {
          richArray: [
            { type: "text", text: "rich " },
            { type: "text", text: "body" },
          ],
        },
      }),
    ).toBe("[图文] rich body");
    expect(summarizeMediaMessage({ ...base, msgtype: "richText" })).toBe("[图文]");
  });

  it("falls back to the raw msgtype for unknown types", () => {
    expect(summarizeMediaMessage({ ...base, msgtype: "hologram" })).toBe("[hologram]");
  });
});

describe("MessageDedup (second dedup layer)", () => {
  it("marks the first sighting as fresh and repeats as duplicates", () => {
    const dedup = new MessageDedup();
    expect(dedup.isDuplicate("msg-a")).toBe(false);
    expect(dedup.isDuplicate("msg-a")).toBe(true);
    expect(dedup.isDuplicate("msg-b")).toBe(false);
  });

  it("forgets ids after the TTL expires", () => {
    vi.useFakeTimers();
    try {
      const dedup = new MessageDedup(1000);
      expect(dedup.isDuplicate("msg-a")).toBe(false);
      vi.advanceTimersByTime(1001);
      expect(dedup.isDuplicate("msg-a")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
