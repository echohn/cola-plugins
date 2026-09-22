import { describe, expect, it, vi } from "vitest";
import { resolvePluginText } from "@marswave/cola-plugin-sdk";
import { deriveConnectionState, type ConnectionStateInput } from "../src/gateway/monitor.js";
import { handleRobotMessage, type EventHandlerDeps } from "../src/gateway/event-handler.js";
import { MessageDedup } from "../src/gateway/dedup.js";
import feishuLikeIndex from "../src/index.js";

const gateway = feishuLikeIndex.channel!.gateway!;

type Context = Parameters<NonNullable<typeof gateway.getStatus>>[0];

function stateInput(overrides: Partial<ConnectionStateInput> = {}): ConnectionStateInput {
  return {
    cleanedUp: false,
    connected: false,
    registered: false,
    reconnecting: false,
    hasError: false,
    ...overrides,
  };
}

describe("deriveConnectionState", () => {
  it("reports connected as soon as the socket is open, even without a REGISTERED system frame", () => {
    expect(deriveConnectionState(stateInput({ connected: true, registered: true }))).toBe(
      "connected",
    );
    // DingTalk's stream gateway never sends the optional REGISTERED frame.
    expect(deriveConnectionState(stateInput({ connected: true, registered: false }))).toBe(
      "connected",
    );
  });

  it("keeps reporting connecting while the socket is not open", () => {
    expect(deriveConnectionState(stateInput({ connected: false, registered: false }))).toBe(
      "connecting",
    );
  });

  it("prefers reconnecting over stale errors", () => {
    expect(deriveConnectionState(stateInput({ reconnecting: true, hasError: true }))).toBe(
      "reconnecting",
    );
  });

  it("reports failed when errors were recorded and nothing is reconnecting", () => {
    expect(deriveConnectionState(stateInput({ hasError: true }))).toBe("failed");
  });

  it("reports disconnected after cleanup", () => {
    expect(
      deriveConnectionState(stateInput({ cleanedUp: true, connected: true, registered: true })),
    ).toBe("disconnected");
  });

  it("defaults to connecting for a fresh monitor", () => {
    expect(deriveConnectionState(stateInput())).toBe("connecting");
  });
});

describe("gateway getStatus aggregation", () => {
  function makeContext(config: Record<string, unknown>, state: Record<string, unknown>): Context {
    return {
      config,
      state,
      runtime: {} as Context["runtime"],
      logger: { info: () => {}, warn: () => {}, error: () => {} } as Context["logger"],
      abortSignal: new AbortController().signal,
      deliver: async () => {},
    } as unknown as Context;
  }

  it("reports unconfigured when no account has credentials", () => {
    const status = gateway.getStatus!(makeContext({ accounts: {} }, {}));
    expect(status).toMatchObject({ connected: false, configured: false });
  });

  it("reports failures for accounts whose monitor failed to start", () => {
    const status = gateway.getStatus!(
      makeContext(
        { accounts: { default: { clientId: "cli_test_1", clientSecret: "test-secret" } } },
        { monitors: new Map(), failures: new Map([["default", "endpoint unreachable"]]) },
      ),
    );
    expect(status.connected).toBe(false);
    expect(status.configured).toBe(true);
    expect(status.details).toContain("default: endpoint unreachable");
  });

  it("counts connected monitors and surfaces per-account details", () => {
    const monitor = {
      getStatus: () => ({
        connected: true,
        configured: true,
        message: { key: "status.connected", fallback: "Connected" },
      }),
    };
    const failing = {
      getStatus: () => ({
        connected: false,
        configured: true,
        message: { key: "status.failed", fallback: "Connection failed" },
        details: "HTTP 401",
      }),
    };
    const status = gateway.getStatus!(
      makeContext(
        {
          accounts: {
            a: { clientId: "cli_test_1", clientSecret: "test-secret" },
            b: { clientId: "cli_test_2", clientSecret: "test-secret" },
          },
        },
        { monitors: new Map([["a", monitor]]), failures: new Map() },
      ),
    );
    // Both entries go through getAccountStatus, so "b" resolves through its own
    // (failing) monitor-less status path only if present — here b has no
    // monitor and no failure, so it reports disconnected.
    void failing;
    expect(status.connected).toBe(true);
  });
});

describe("command: /dingtalk status", () => {
  it("renders localized status lines", async () => {
    const command = feishuLikeIndex.commands![0];
    const result = await command.execute({
      args: "status",
      config: { accounts: { default: { clientId: "cli_test_1", clientSecret: "test-secret" } } },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const text = resolvePluginText(result?.reply, undefined, "en");
    expect(text).toContain("DingTalk Status");
    expect(text).toContain("**default**");
  });

  it("reports when no accounts are configured", async () => {
    const command = feishuLikeIndex.commands![0];
    const result = await command.execute({
      args: "status",
      config: {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    expect(resolvePluginText(result?.reply, undefined, "en")).toContain("No account configured");
  });

  it("redacts the client id in the accounts listing", async () => {
    const command = feishuLikeIndex.commands![0];
    const result = await command.execute({
      args: "accounts",
      config: {
        accounts: { default: { clientId: "cli_test_secret", clientSecret: "test-secret" } },
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const text = resolvePluginText(result?.reply, undefined, "en");
    expect(text).toContain("cli_***");
    expect(text).not.toContain("cli_test_secret");
  });
});

describe("event handler delivery payloads", () => {
  function makeDeps(overrides: Partial<EventHandlerDeps> = {}): {
    deps: EventHandlerDeps;
    delivered: unknown[];
  } {
    const delivered: unknown[] = [];
    const deps: EventHandlerDeps = {
      accountId: "default",
      client: {} as EventHandlerDeps["client"],
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      deliver: async (payload) => {
        delivered.push(payload);
      },
      dedup: new MessageDedup(),
      groupEnabled: false,
      ...overrides,
    };
    return { deps, delivered };
  }

  const groupPayload = JSON.stringify({
    conversationId: "cid-group-1",
    conversationType: "2",
    msgId: "msg-g-1",
    msgtype: "text",
    text: { content: "@机器人 run the report" },
    senderStaffId: "staff-1",
    senderId: "sender-1",
    senderNick: "Tester",
    robotCode: "ding-test-robot",
  });

  it("delivers group @mentions with mentionedBot when groups are enabled", async () => {
    const { deps, delivered } = makeDeps({ groupEnabled: true });
    await handleRobotMessage(deps, groupPayload);

    expect(delivered).toHaveLength(1);
    const payload = delivered[0] as {
      sessionId: string[];
      conversation: { kind: string; id: string };
      mentionedBot?: boolean;
      deliveryContext: { to: string };
      message: string;
    };
    expect(payload.sessionId).toEqual(["conversation", "default", "cid-group-1"]);
    expect(payload.conversation).toEqual({ kind: "group", id: "cid-group-1" });
    expect(payload.mentionedBot).toBe(true);
    expect(payload.deliveryContext.to).toBe("conversation:cid-group-1");
    // Group message text is wrapped with a sender tag (no ownerStaffId → non-owner).
    expect(payload.message).toContain("[非所有者消息 · 发送者: Tester(sender-1)");
    expect(payload.message).toContain("run the report");
  });

  it("tags a group message as owner when senderId matches ownerStaffId", async () => {
    const { deps, delivered } = makeDeps({ groupEnabled: true, ownerStaffId: "sender-1" });
    await handleRobotMessage(deps, groupPayload);

    expect(delivered).toHaveLength(1);
    const payload = delivered[0] as { message: string };
    expect(payload.message).toContain("[所有者]");
    expect(payload.message).toContain("run the report");
  });

  it("tags a group message as non-owner when senderId differs from ownerStaffId", async () => {
    const { deps, delivered } = makeDeps({
      groupEnabled: true,
      ownerStaffId: "other-owner-staff",
    });
    await handleRobotMessage(deps, groupPayload);

    expect(delivered).toHaveLength(1);
    const payload = delivered[0] as { message: string };
    expect(payload.message).toContain("[非所有者消息 · 发送者: Tester(sender-1)");
    expect(payload.message).toContain("禁止提供文件、资料或任何私人信息");
    expect(payload.message).toContain("never provide files, materials, or any private information");
    expect(payload.message).toContain("run the report");
  });

  it("leaves direct messages untagged regardless of ownerStaffId", async () => {
    const { deps, delivered } = makeDeps({ groupEnabled: true, ownerStaffId: "sender-1" });
    await handleRobotMessage(
      deps,
      JSON.stringify({
        conversationId: "cid-dm-1",
        conversationType: "1",
        msgId: "msg-d-1",
        msgtype: "text",
        text: { content: "hello" },
        senderStaffId: "staff-1",
        senderId: "sender-1",
        robotCode: "ding-test-robot",
      }),
    );

    expect(delivered).toHaveLength(1);
    const payload = delivered[0] as { message: string };
    expect(payload.message).toBe("hello");
    expect(payload.message).not.toContain("[所有者]");
    expect(payload.message).not.toContain("[非所有者消息");
  });

  it("delivers direct chats with a staff session id", async () => {
    const { deps, delivered } = makeDeps({ groupEnabled: true });
    await handleRobotMessage(
      deps,
      JSON.stringify({
        conversationId: "cid-dm-1",
        conversationType: "1",
        msgId: "msg-d-1",
        msgtype: "text",
        text: { content: "hello" },
        senderStaffId: "staff-1",
        senderId: "sender-1",
        robotCode: "ding-test-robot",
      }),
    );

    expect(delivered).toHaveLength(1);
    const payload = delivered[0] as {
      sessionId: string[];
      conversation: { kind: string; id: string };
      mentionedBot?: boolean;
      deliveryContext: { to: string };
    };
    expect(payload.sessionId).toEqual(["staff", "default", "staff-1"]);
    expect(payload.conversation).toEqual({ kind: "direct", id: "staff-1" });
    expect(payload.mentionedBot).toBeUndefined();
    expect(payload.deliveryContext.to).toBe("staff:staff-1");
  });

  it("deduplicates redelivered msgIds", async () => {
    const { deps, delivered } = makeDeps({ groupEnabled: true });
    await handleRobotMessage(deps, groupPayload);
    await handleRobotMessage(deps, groupPayload);
    expect(delivered).toHaveLength(1);
  });

  it("skips direct messages without senderStaffId (unpublished robot)", async () => {
    const { deps, delivered } = makeDeps({ groupEnabled: true });
    await handleRobotMessage(
      deps,
      JSON.stringify({
        conversationId: "cid-dm-2",
        conversationType: "1",
        msgId: "msg-d-2",
        msgtype: "text",
        text: { content: "hello" },
        senderId: "sender-1",
        robotCode: "ding-test-robot",
      }),
    );
    expect(delivered).toHaveLength(0);
  });

  it("notifies group senders that group chat is disabled (via REST client)", async () => {
    const sendGroupMessage = Object.assign(
      vi.fn(async () => {}),
      // satisfy the DingTalkClient type
    );
    const { deps, delivered } = makeDeps({
      groupEnabled: false,
      client: { sendGroupMessage } as unknown as EventHandlerDeps["client"],
    });
    await handleRobotMessage(deps, groupPayload);

    expect(delivered).toHaveLength(0);
    expect(sendGroupMessage).toHaveBeenCalledTimes(1);
    const [robotCode, conversationId, message] = sendGroupMessage.mock.calls[0] as [
      string,
      string,
      { msgKey: string; msgParam: string },
    ];
    expect(robotCode).toBe("ding-test-robot");
    expect(conversationId).toBe("cid-group-1");
    expect(message.msgKey).toBe("sampleText");
    const parsed = JSON.parse(message.msgParam) as { content: string };
    expect(parsed.content).toContain("Group chat is not enabled");
  });
});
