import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "child_process";
import { loadConfig } from "./config.js";
import { WhatsAppClient } from "./whatsapp.js";
import type { StoredMessage } from "./database.js";
import QRCode from "qrcode-terminal";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true as const };
}

async function main() {
  const config = loadConfig();
  const wa = new WhatsAppClient(config);

  const mcp = new Server(
    { name: "whatsapp-mcp", version: "1.0.0" },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: true, listChanged: true },
        logging: {},
        experimental: { "claude/channel": {} },
      },
    }
  );

  let lastQr: string | null = null;
  let connectionStatus = "disconnected";

  // ===== NOTIFICATION SYSTEM =====
  const NOTIFICATION_URI = "whatsapp://notifications";
  const recentNotifications: Array<{
    id: string; chat: string; sender: string; content: string;
    timestamp: number; time: string; isGroup: boolean;
  }> = [];
  const MAX_NOTIFICATIONS = 50;
  const subscribedUris = new Set<string>();

  function playNotificationSound() {
    if (!config.notificationSound) return;
    execFile("paplay", [config.notificationSoundPath], (err) => {
      if (err) execFile("aplay", ["-q", "/usr/share/sounds/alsa/Front_Center.wav"], () => {});
    });
  }

  wa.onMessage((msg: StoredMessage) => {
    if (msg.message_type === "protocolMessage" || msg.message_type === "reactionMessage") return;

    const isGroup = msg.chat_jid.endsWith("@g.us");
    const sender = msg.sender_name || msg.sender_jid;
    const chatLabel = isGroup ? `[Group] ${msg.chat_jid}` : sender;
    const direction = msg.is_from_me ? "📤" : "💬";
    const content = msg.content || "[media]";
    const displayUser = msg.is_from_me ? `You → ${chatLabel}` : sender;

    // Channel notification — exactly like attn does it
    mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: `${direction} ${msg.is_from_me ? "You → " + chatLabel : chatLabel}: ${content}`,
        meta: {
          user: displayUser,
          ts: new Date(msg.timestamp * 1000).toISOString(),
        },
      },
    }).catch((e: unknown) => {
      process.stderr.write(`whatsapp: channel notification error: ${e}\n`);
    });

    if (msg.is_from_me) return;

    recentNotifications.unshift({
      id: msg.id, chat: msg.chat_jid, sender, content,
      timestamp: msg.timestamp, time: new Date(msg.timestamp * 1000).toISOString(), isGroup,
    });
    if (recentNotifications.length > MAX_NOTIFICATIONS) recentNotifications.length = MAX_NOTIFICATIONS;

    playNotificationSound();

    if (subscribedUris.has(NOTIFICATION_URI)) {
      mcp.sendResourceUpdated({ uri: NOTIFICATION_URI });
    }
  });

  wa.onQr((qr) => { lastQr = qr; });
  wa.onConnection((status) => { connectionStatus = status; });

  // ===== TOOL DEFINITIONS =====

  const tools = [
    // Status
    { name: "connection_status", description: "Check WhatsApp connection status", inputSchema: { type: "object" as const, properties: {} } },
    { name: "get_qr", description: "Get QR code for WhatsApp authentication", inputSchema: { type: "object" as const, properties: {} } },
    // Messaging
    { name: "send_message", description: "Send a text message to a phone number or contact name", inputSchema: { type: "object" as const, properties: { to: { type: "string", description: "Phone number or contact name" }, message: { type: "string", description: "Text message" } }, required: ["to", "message"] } },
    { name: "send_media", description: "Send image/video/audio/document file", inputSchema: { type: "object" as const, properties: { to: { type: "string" }, file_path: { type: "string" }, type: { type: "string", enum: ["image", "video", "audio", "document"] }, caption: { type: "string" } }, required: ["to", "file_path", "type"] } },
    { name: "send_location", description: "Send a GPS location", inputSchema: { type: "object" as const, properties: { to: { type: "string" }, latitude: { type: "number" }, longitude: { type: "number" }, name: { type: "string" } }, required: ["to", "latitude", "longitude"] } },
    { name: "send_contact", description: "Share a contact card", inputSchema: { type: "object" as const, properties: { to: { type: "string" }, contact_name: { type: "string" }, contact_phone: { type: "string" } }, required: ["to", "contact_name", "contact_phone"] } },
    { name: "reply_message", description: "Reply to a specific message by ID", inputSchema: { type: "object" as const, properties: { chat: { type: "string" }, message_id: { type: "string" }, message: { type: "string" } }, required: ["chat", "message_id", "message"] } },
    { name: "forward_message", description: "Forward a message to another chat", inputSchema: { type: "object" as const, properties: { from_chat: { type: "string" }, message_id: { type: "string" }, to_chat: { type: "string" } }, required: ["from_chat", "message_id", "to_chat"] } },
    { name: "delete_message", description: "Delete a sent message", inputSchema: { type: "object" as const, properties: { chat: { type: "string" }, message_id: { type: "string" } }, required: ["chat", "message_id"] } },
    { name: "react_message", description: "React to a message with an emoji", inputSchema: { type: "object" as const, properties: { chat: { type: "string" }, message_id: { type: "string" }, emoji: { type: "string" } }, required: ["chat", "message_id", "emoji"] } },
    // Reading
    { name: "list_chats", description: "List all chats with last message preview", inputSchema: { type: "object" as const, properties: { limit: { type: "number" } } } },
    { name: "read_messages", description: "Read messages from a specific chat", inputSchema: { type: "object" as const, properties: { chat: { type: "string" }, limit: { type: "number" }, offset: { type: "number" } }, required: ["chat"] } },
    { name: "search_messages", description: "Search messages across chats", inputSchema: { type: "object" as const, properties: { query: { type: "string" }, chat: { type: "string" }, limit: { type: "number" } }, required: ["query"] } },
    { name: "get_chat_info", description: "Get details about a chat", inputSchema: { type: "object" as const, properties: { chat: { type: "string" } }, required: ["chat"] } },
    { name: "download_media", description: "Download media from a message", inputSchema: { type: "object" as const, properties: { chat: { type: "string" }, message_id: { type: "string" } }, required: ["chat", "message_id"] } },
    // Contacts
    { name: "list_contacts", description: "List all contacts", inputSchema: { type: "object" as const, properties: {} } },
    { name: "get_contact", description: "Get contact details by phone", inputSchema: { type: "object" as const, properties: { phone: { type: "string" } }, required: ["phone"] } },
    { name: "check_number", description: "Check if number is on WhatsApp", inputSchema: { type: "object" as const, properties: { phone: { type: "string" } }, required: ["phone"] } },
    { name: "get_profile_picture", description: "Get profile picture URL", inputSchema: { type: "object" as const, properties: { contact: { type: "string" } }, required: ["contact"] } },
    // Groups
    { name: "list_groups", description: "List all groups", inputSchema: { type: "object" as const, properties: {} } },
    { name: "get_group_info", description: "Get group details", inputSchema: { type: "object" as const, properties: { group_jid: { type: "string" } }, required: ["group_jid"] } },
    { name: "create_group", description: "Create a new group", inputSchema: { type: "object" as const, properties: { name: { type: "string" }, members: { type: "array", items: { type: "string" } } }, required: ["name", "members"] } },
    { name: "add_group_member", description: "Add members to a group", inputSchema: { type: "object" as const, properties: { group_jid: { type: "string" }, members: { type: "array", items: { type: "string" } } }, required: ["group_jid", "members"] } },
    { name: "remove_group_member", description: "Remove members from a group", inputSchema: { type: "object" as const, properties: { group_jid: { type: "string" }, members: { type: "array", items: { type: "string" } } }, required: ["group_jid", "members"] } },
    { name: "leave_group", description: "Leave a group", inputSchema: { type: "object" as const, properties: { group_jid: { type: "string" } }, required: ["group_jid"] } },
    { name: "send_group_message", description: "Send message to a group", inputSchema: { type: "object" as const, properties: { group_jid: { type: "string" }, message: { type: "string" } }, required: ["group_jid", "message"] } },
    // Notifications
    { name: "get_notifications", description: "Get recent incoming message notifications", inputSchema: { type: "object" as const, properties: { limit: { type: "number" }, clear: { type: "boolean" } } } },
    { name: "clear_notifications", description: "Clear all pending notifications", inputSchema: { type: "object" as const, properties: {} } },
  ];

  // ===== HANDLERS =====

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const a = args as any;

    try {
      switch (name) {
        case "connection_status":
          return ok({ connected: wa.isConnected(), status: connectionStatus, hasQr: !!lastQr });

        case "get_qr": {
          if (wa.isConnected()) return ok({ message: "Already connected." });
          if (!lastQr) return ok({ message: "No QR code available yet." });
          let asciiQr = "";
          QRCode.generate(lastQr, { small: true }, (qr: string) => { asciiQr = qr; });
          return ok({ qr_ascii: asciiQr, qr_raw: lastQr, instructions: "Scan with WhatsApp > Settings > Linked Devices > Link a Device" });
        }

        case "send_message": {
          const result = await wa.sendMessage(a.to, a.message);
          return ok({ sent: true, to: a.to, messageId: result?.key?.id, timestamp: result?.messageTimestamp });
        }
        case "send_media": {
          const result = await wa.sendMedia(a.to, a.file_path, a.type, a.caption);
          return ok({ sent: true, to: a.to, type: a.type, messageId: result?.key?.id });
        }
        case "send_location": {
          const result = await wa.sendLocation(a.to, a.latitude, a.longitude, a.name);
          return ok({ sent: true, to: a.to, messageId: result?.key?.id });
        }
        case "send_contact": {
          const result = await wa.sendContact(a.to, a.contact_name, a.contact_phone);
          return ok({ sent: true, to: a.to, contact: a.contact_name, messageId: result?.key?.id });
        }
        case "reply_message": {
          const result = await wa.replyMessage(a.chat, a.message_id, a.message);
          return ok({ sent: true, repliedTo: a.message_id, messageId: result?.key?.id });
        }
        case "forward_message": {
          const result = await wa.forwardMessage(a.from_chat, a.message_id, a.to_chat);
          return ok({ forwarded: true, from: a.from_chat, to: a.to_chat, messageId: result?.key?.id });
        }
        case "delete_message":
          await wa.deleteMessage(a.chat, a.message_id);
          return ok({ deleted: true, messageId: a.message_id });
        case "react_message":
          await wa.reactMessage(a.chat, a.message_id, a.emoji);
          return ok({ reacted: true, messageId: a.message_id, emoji: a.emoji });

        case "list_chats": {
          const chats = await wa.listChats();
          return ok(chats.slice(0, a.limit || 50));
        }
        case "read_messages": {
          const msgs = wa.readMessages(a.chat, a.limit || 50, a.offset || 0);
          return ok(msgs.map((m) => ({ id: m.id, sender: m.sender_name || m.sender_jid, content: m.content, type: m.message_type, timestamp: m.timestamp, time: new Date(m.timestamp * 1000).toISOString(), fromMe: m.is_from_me, quotedId: m.quoted_message_id, mediaType: m.media_type })));
        }
        case "search_messages": {
          const msgs = wa.searchMessages(a.query, a.chat, a.limit || 50);
          return ok(msgs.map((m) => ({ id: m.id, chat: m.chat_jid, sender: m.sender_name || m.sender_jid, content: m.content, timestamp: m.timestamp, time: new Date(m.timestamp * 1000).toISOString() })));
        }
        case "get_chat_info":
          return ok(await wa.getChatInfo(a.chat));
        case "download_media":
          return ok({ downloaded: true, path: await wa.downloadMedia(a.chat, a.message_id) });

        case "list_contacts":
          return ok(wa.listContacts().map((c) => ({ jid: c.jid, name: c.name || c.notify_name || null, phone: c.phone })));
        case "get_contact": {
          const contact = wa.getContact(a.phone);
          return contact ? ok({ found: true, ...contact }) : ok({ found: false, phone: a.phone });
        }
        case "check_number":
          return ok(await wa.checkNumber(a.phone));
        case "get_profile_picture":
          return ok({ contact: a.contact, profilePictureUrl: await wa.getProfilePicture(a.contact) });

        case "list_groups":
          return ok(await wa.listGroups());
        case "get_group_info": {
          const info = await wa.getGroupInfo(a.group_jid);
          return ok({ jid: info.id, subject: info.subject, description: info.desc, owner: info.owner, creation: info.creation, participants: info.participants.map((p) => ({ jid: p.id, admin: p.admin })) });
        }
        case "create_group":
          return ok(await wa.createGroup(a.name, a.members));
        case "add_group_member":
          await wa.addGroupMember(a.group_jid, a.members);
          return ok({ added: true, group: a.group_jid, members: a.members });
        case "remove_group_member":
          await wa.removeGroupMember(a.group_jid, a.members);
          return ok({ removed: true, group: a.group_jid, members: a.members });
        case "leave_group":
          await wa.leaveGroup(a.group_jid);
          return ok({ left: true, group: a.group_jid });
        case "send_group_message": {
          const result = await wa.sendGroupMessage(a.group_jid, a.message);
          return ok({ sent: true, group: a.group_jid, messageId: result?.key?.id });
        }

        case "get_notifications": {
          const results = recentNotifications.slice(0, a.limit || 20);
          if (a.clear) recentNotifications.length = 0;
          return ok({ count: results.length, notifications: results });
        }
        case "clear_notifications": {
          const count = recentNotifications.length;
          recentNotifications.length = 0;
          return ok({ cleared: count });
        }

        default:
          return err(`Unknown tool: ${name}`);
      }
    } catch (e) {
      return err(String(e));
    }
  });

  // Resources
  mcp.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: NOTIFICATION_URI, name: "notifications", title: "WhatsApp Notifications", description: "Real-time incoming message notifications", mimeType: "application/json" }],
  }));

  mcp.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
    contents: [{ uri: request.params.uri, mimeType: "application/json", text: JSON.stringify({ count: recentNotifications.length, notifications: recentNotifications }, null, 2) }],
  }));

  mcp.setRequestHandler(SubscribeRequestSchema, async (request) => {
    subscribedUris.add(request.params.uri);
    return {};
  });

  mcp.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    subscribedUris.delete(request.params.uri);
    return {};
  });

  // Connect transport, then start WhatsApp
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  setTimeout(() => {
    wa.connect().catch((e) => { connectionStatus = `error: ${e.message}`; });
  }, 100);

  process.on("SIGINT", async () => { await wa.disconnect(); process.exit(0); });
  process.on("SIGTERM", async () => { await wa.disconnect(); process.exit(0); });
}

main().catch((e) => { console.error("Fatal error:", e); process.exit(1); });
