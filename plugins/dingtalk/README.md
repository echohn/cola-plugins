# DingTalk Channel Plugin

Connect Cola to DingTalk through an enterprise internal application robot using
the Stream mode (outbound WebSocket). No public callback URL, domain, or TLS
certificate is required.

## Features

- Receives robot messages (direct chats and @-mentions in group chats) over a
  managed Stream WebSocket connection with automatic reconnect.
- Sends Cola replies back to the originating DingTalk conversation:
  `oToMessages` for direct chats, `groupMessages` for group chats.
- Sends Markdown replies when the model output is markdown-capable.
- Group chat is opt-in via `groupEnabled`; DingTalk itself only pushes group
  messages that @-mention the robot.

## Requirements

- An enterprise internal application on the
  [DingTalk Open Platform](https://open-dev.dingtalk.com) with:
  - The **robot** application capability added, with the message receive mode
    set to **Stream mode**.
  - A **published version** (unpublished robots do not receive
    `senderStaffId`, which is required for direct-chat replies).
  - The **enterprise robot message sending** permission granted.
- The application's **Client ID (AppKey)** and **Client Secret (AppSecret)**.

## Setup

1. In the DingTalk Open Platform console, create (or reuse) an enterprise
   internal application and copy the Client ID and Client Secret.
2. Under **Application capabilities**, add the **robot** capability and select
   **Stream mode** as the message receive mode, then publish the application
   version.
3. Under **Permissions**, grant the enterprise robot message sending
   permission.
4. Install the DingTalk plugin in Cola and enter the Client ID and Client
   Secret in the plugin settings.
5. For group chats, add the robot to the target group (group settings →
   robots) and enable `groupEnabled` in the plugin settings. Users must
   @-mention the robot in groups.
6. Check `/dingtalk status` in Cola.

## Notes and limits

- The Stream channel is receive-only: replies are sent through the DingTalk
  REST API with an access token cached for its 2-hour validity window.
- Group message payloads are limited to 15000 bytes by DingTalk; Cola splits
  longer replies.
- Incoming images, files, audio, and video are delivered as text summaries in
  the first release; media download and upload are planned for a later version.
- Treat the Client Secret as a credential: it is stored in Cola's secret
  configuration fields and is never written to logs or files.

## Security

Do not commit Client ID/Secret values, session webhooks, or message content.
The plugin never persists credentials outside Cola's encrypted configuration.
