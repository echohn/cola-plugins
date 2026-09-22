import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";
import type { DWClientDownStream } from "dingtalk-stream";
import { pluginMessage as m } from "@marswave/cola-plugin-sdk";
import type { ChannelStatusResult, DeliverFn, PluginLogger } from "@marswave/cola-plugin-sdk";
import type { DingTalkAccountConfig } from "../api/types.js";
import { getDingTalkClient } from "../api/client.js";
import type { DingTalkClient } from "../api/client.js";
import { describeConnectionError } from "./connection-error.js";
import { MessageDedup } from "./dedup.js";
import { handleRobotMessage } from "./event-handler.js";
import type { EventHandlerDeps } from "./event-handler.js";

export type MonitorHandle = {
  accountId: string;
  /** Underlying Stream client (connection state introspection). */
  stream: DWClient;
  /** REST client used for outbound replies. */
  restClient: DingTalkClient;
  /** robotCode observed from inbound messages; falls back to the account clientId. */
  getRobotCode(): string | undefined;
  cleanup: () => void;
  getStatus: () => ChannelStatusResult;
};

export type ConnectionState =
  | "connected"
  | "reconnecting"
  | "connecting"
  | "failed"
  | "disconnected";

export type ConnectionStateInput = {
  cleanedUp: boolean;
  /** Stream socket is open (DWClient.connected). */
  connected: boolean;
  /** Subscription registered with the DingTalk gateway (DWClient.registered). */
  registered: boolean;
  /** The SDK is scheduling/running a reconnect (DWClient.reconnecting). */
  reconnecting: boolean;
  /** A connection error has been recorded and not yet cleared by a success. */
  hasError: boolean;
};

/**
 * Derive real connection state from the Stream client's public fields.
 *
 * NOTE: Do NOT gate "connected" on `registered`. DingTalk's stream gateway
 * treats the REGISTERED SYSTEM frame as optional and, against the nodejs
 * SDK / real bot channels, never sends it — yet the socket opens and the
 * heartbeat ping/pong keeps flowing. `connected` (socket OPEN) is therefore
 * the authoritative liveness signal; we deliberately ignore `registered`
 * (see QwenLM/qwen-code#6715 for the same finding). `registered` is still
 * surfaced via getStatus details when we happen to receive it.
 */
export function deriveConnectionState(input: ConnectionStateInput): ConnectionState {
  if (input.cleanedUp) return "disconnected";
  if (input.connected) return "connected";
  if (input.reconnecting) return "reconnecting";
  if (input.hasError) return "failed";
  return "connecting";
}

/**
 * Start monitoring a single DingTalk account — opens the Stream (outbound
 * WebSocket) connection and wires robot messages to the deliver callback.
 * Authorization is handled by the host SDK access gate, not here.
 */
export async function startMonitor(opts: {
  accountId: string;
  config: DingTalkAccountConfig;
  deliver: DeliverFn;
  logger: PluginLogger;
  abortSignal: AbortSignal;
  groupEnabled: boolean;
  ownerStaffId?: string;
}): Promise<MonitorHandle> {
  const { accountId, config, deliver, logger, abortSignal, groupEnabled, ownerStaffId } = opts;
  abortSignal.throwIfAborted();
  if (!config.clientId || !config.clientSecret) {
    throw new Error(`DingTalk account "${accountId}" missing clientId or clientSecret`);
  }

  let cleanedUp = false;
  const errors: string[] = [];
  let observedRobotCode: string | undefined;

  const restClient = getDingTalkClient(accountId, config);
  const dedup = new MessageDedup();

  // The DWClient constructor type predates the subscriptions/autoReconnect
  // options, but the runtime merges them into the config (verified against
  // dingtalk-stream 2.1.5). Subscribing to the robot CALLBACK topic replaces
  // the default EVENT "*" subscription.
  type DWClientOptions = ConstructorParameters<typeof DWClient>[0];
  const stream = new DWClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    subscriptions: [{ type: "CALLBACK", topic: TOPIC_ROBOT }],
    autoReconnect: true,
  } as DWClientOptions);

  const deps: EventHandlerDeps = {
    accountId,
    client: restClient,
    logger,
    deliver,
    dedup,
    groupEnabled,
    ownerStaffId,
    onRobotCode: (robotCode) => {
      observedRobotCode = robotCode;
    },
  };

  stream.registerCallbackListener(TOPIC_ROBOT, (downstream: DWClientDownStream) => {
    // Ack immediately to stop the server retrying the push for 60s.
    try {
      stream.socketCallBackResponse(downstream.headers.messageId, { code: 200, message: "OK" });
    } catch (err) {
      logger.warn(`dingtalk[${accountId}]: failed to ack stream message`, err);
    }
    handleRobotMessage(deps, downstream.data).catch((err) => {
      logger.error(`dingtalk[${accountId}]: failed to process robot message`, err);
    });
  });

  const recordError = (error: unknown) => {
    if (cleanedUp) return;
    const details = describeConnectionError(error);
    if (!errors.includes(details)) errors.push(details);
    logger.error(`dingtalk[${accountId}]: ${details}`);
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      abortSignal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });

  // Initial connect loop with capped backoff. Once the socket is open, the
  // SDK's own autoReconnect (autoReconnect: true) takes over dropped
  // connections; that internal path retries silently and only flips the
  // public `reconnecting` flag, which getStatus reports.
  const connectLoop = async (): Promise<void> => {
    let attempt = 0;
    while (!cleanedUp && !abortSignal.aborted) {
      try {
        await stream.getEndpoint();
        await stream._connect();
        if (!cleanedUp) {
          errors.length = 0;
          logger.info(`dingtalk[${accountId}]: Stream connected`);
        }
        return;
      } catch (err) {
        recordError(err);
        const delayMs = Math.min(60_000, 1000 * 2 ** attempt);
        attempt += 1;
        await sleep(delayMs);
      }
    }
  };

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    abortSignal.removeEventListener("abort", handleAbort);
    try {
      stream.disconnect();
    } catch (err) {
      logger.warn(`dingtalk[${accountId}]: error closing Stream connection`, err);
    }
  };

  const handleAbort = () => {
    logger.info(`dingtalk[${accountId}]: abort signal received, stopping Stream`);
    cleanup();
  };

  if (abortSignal.aborted) {
    cleanup();
  } else {
    abortSignal.addEventListener("abort", handleAbort, { once: true });
    void connectLoop();
  }

  logger.info(`dingtalk[${accountId}]: monitor started (mode=stream)`);

  return {
    accountId,
    stream,
    restClient,
    getRobotCode: () => observedRobotCode ?? config.clientId,
    cleanup,
    getStatus(): ChannelStatusResult {
      const state = deriveConnectionState({
        cleanedUp,
        connected: stream.connected,
        registered: stream.registered,
        reconnecting: stream.reconnecting,
        hasError: errors.length > 0,
      });
      const details =
        cleanedUp || state === "connected" ? undefined : errors.join("\n") || undefined;
      switch (state) {
        case "connected":
          return { connected: true, configured: true, message: m("status.connected", "Connected") };
        case "reconnecting":
          return {
            connected: false,
            configured: true,
            message: m("status.reconnecting", "Connection lost; reconnecting…"),
            details,
          };
        case "failed":
          return {
            connected: false,
            configured: true,
            message: m("status.failed", "Connection failed"),
            details,
          };
        case "connecting":
          return {
            connected: false,
            configured: true,
            message: m("status.connecting", "Connecting…"),
          };
        default:
          return {
            connected: false,
            configured: true,
            message: m("status.disconnected", "Disconnected"),
          };
      }
    },
  };
}
