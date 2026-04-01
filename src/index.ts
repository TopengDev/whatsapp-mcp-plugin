import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
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
  const server = new McpServer(
    { name: "whatsapp-mcp", version: "1.0.0" },
    { capabilities: { resources: { subscribe: true, listChanged: true }, logging: {}, experimental: { "claude/channel": {} } } }
  );

  let lastQr: string | null = null;
  let connectionStatus = "disconnected";

  // ===== NOTIFICATION SYSTEM =====
  const NOTIFICATION_URI = "whatsapp://notifications";
  const recentNotifications: Array<{
    id: string;
    chat: string;
    sender: string;
    content: string;
    timestamp: number;
    time: string;
    isGroup: boolean;
  }> = [];
  const MAX_NOTIFICATIONS = 50;
  const subscribedUris = new Set<string>();

  function playNotificationSound() {
    if (!config.notificationSound) return;
    execFile("paplay", [config.notificationSoundPath], (err) => {
      if (err) {
        execFile("aplay", ["-q", "/usr/share/sounds/alsa/Front_Center.wav"], () => {});
      }
    });
  }

  wa.onMessage((msg: StoredMessage) => {
    // Skip protocol/system messages
    if (msg.message_type === "protocolMessage" || msg.message_type === "reactionMessage") return;

    const isGroup = msg.chat_jid.endsWith("@g.us");
    const sender = msg.sender_name || msg.sender_jid;

    const chatLabel = isGroup ? `[Group] ${msg.chat_jid}` : sender;
    const direction = msg.is_from_me ? "📤" : "💬";
    const content = msg.content || "[media]";

    // Push to Claude Code terminal via channel notification (works when loaded as plugin)
    const displayUser = msg.is_from_me ? `You → ${chatLabel}` : sender;
    server.server.notification({
      method: "notifications/claude/channel",
      params: {
        content: `${direction} ${msg.is_from_me ? "You → " + chatLabel : chatLabel}: ${content}`,
        meta: {
          user: displayUser,
          ts: new Date(msg.timestamp * 1000).toISOString(),
        },
      },
    }).catch(() => {});

    if (msg.is_from_me) return;

    const notification = {
      id: msg.id,
      chat: msg.chat_jid,
      sender,
      content,
      timestamp: msg.timestamp,
      time: new Date(msg.timestamp * 1000).toISOString(),
      isGroup,
    };

    recentNotifications.unshift(notification);
    if (recentNotifications.length > MAX_NOTIFICATIONS) {
      recentNotifications.length = MAX_NOTIFICATIONS;
    }

    // Play sound
    playNotificationSound();

    // Notify MCP subscribers
    if (subscribedUris.has(NOTIFICATION_URI)) {
      server.server.sendResourceUpdated({ uri: NOTIFICATION_URI });
    }
  });

  wa.onQr((qr) => {
    lastQr = qr;
  });

  wa.onConnection((status) => {
    connectionStatus = status;
  });

  // ===== STATUS TOOLS =====

  server.tool(
    "connection_status",
    "Check WhatsApp connection status",
    {},
    async () => {
      return ok({
        connected: wa.isConnected(),
        status: connectionStatus,
        hasQr: !!lastQr,
      });
    }
  );

  server.tool(
    "get_qr",
    "Get QR code for WhatsApp authentication. Returns ASCII art QR code to scan with your phone.",
    {},
    async () => {
      if (wa.isConnected()) {
        return ok({ message: "Already connected to WhatsApp. No QR needed." });
      }

      if (!lastQr) {
        return ok({ message: "No QR code available yet. Connection may be initializing or already authenticated." });
      }

      // Generate ASCII QR
      let asciiQr = "";
      QRCode.generate(lastQr, { small: true }, (qr: string) => {
        asciiQr = qr;
      });

      return ok({
        qr_ascii: asciiQr,
        qr_raw: lastQr,
        instructions: "Scan this QR code with WhatsApp on your phone: Settings > Linked Devices > Link a Device",
      });
    }
  );

  // ===== MESSAGING TOOLS =====

  server.tool(
    "send_message",
    "Send a text message to a phone number or contact name",
    {
      to: z.string().describe("Phone number (e.g., +628xxx, 08xxx) or contact name"),
      message: z.string().describe("Text message to send"),
    },
    async ({ to, message }) => {
      try {
        const result = await wa.sendMessage(to, message);
        return ok({
          sent: true,
          to,
          messageId: result?.key?.id,
          timestamp: result?.messageTimestamp,
        });
      } catch (e) {
        return err(String(e));
      }
    }
  );

  server.tool(
    "send_media",
    "Send an image, video, audio, or document file",
    {
      to: z.string().describe("Phone number or contact name"),
      file_path: z.string().describe("Absolute path to the media file"),
      type: z.enum(["image", "video", "audio", "document"]).describe("Type of media"),
      caption: z.string().optional().describe("Caption for the media"),
    },
    async ({ to, file_path, type, caption }) => {
      try {
        const result = await wa.sendMedia(to, file_path, type, caption);
        return ok({ sent: true, to, type, messageId: result?.key?.id });
      } catch (e) {
        return err(String(e));
      }
    }
  );

  server.tool(
    "send_location",
    "Send a GPS location",
    {
      to: z.string().describe("Phone number or contact name"),
      latitude: z.number().describe("Latitude"),
      longitude: z.number().describe("Longitude"),
      name: z.string().optional().describe("Location name/label"),
    },
    async ({ to, latitude, longitude, name }) => {
      try {
        const result = await wa.sendLocation(to, latitude, longitude, name);
        return ok({ sent: true, to, messageId: result?.key?.id });
      } catch (e) {
        return err(String(e));
      }
    }
  );

  server.tool(
    "send_contact",
    "Share a contact card",
    {
      to: z.string().describe("Phone number or contact name to send the card to"),
      contact_name: z.string().describe("Name of the contact to share"),
      contact_phone: z.string().describe("Phone number of the contact to share"),
    },
    async ({ to, contact_name, contact_phone }) => {
      try {
        const result = await wa.sendContact(to, contact_name, contact_phone);
        return ok({ sent: true, to, contact: contact_name, messageId: result?.key?.id });
      } catch (e) {
        return err(String(e));
      }
    }
  );

  server.tool(
    "reply_message",
    "Reply to a specific message by ID",
    {
      chat: z.string().describe("Chat JID, phone number, or contact name"),
      message_id: z.string().describe("ID of the message to reply to"),
      message: z.string().describe("Reply text"),
    },
    async ({ chat, message_id, message }) => {
      try {
        const result = await wa.replyMessage(chat, message_id, message);
        return ok({ sent: true, repliedTo: message_id, messageId: result?.key?.id });
      } catch (e) {
        return err(String(e));
      }
    }
  );

  server.tool(
    "forward_message",
    "Forward a message to another chat",
    {
      from_chat: z.string().describe("Source chat JID, phone number, or contact name"),
      message_id: z.string().describe("ID of the message to forward"),
      to_chat: z.string().describe("Destination chat JID, phone number, or contact name"),
    },
    async ({ from_chat, message_id, to_chat }) => {
      try {
        const result = await wa.forwardMessage(from_chat, message_id, to_chat);
        return ok({ forwarded: true, from: from_chat, to: to_chat, messageId: result?.key?.id });
      } catch (e) {
        return err(String(e));
      }
    }
  );

  server.tool(
    "delete_message",
    "Delete a sent message",
    {
      chat: z.string().describe("Chat JID, phone number, or contact name"),
      message_id: z.string().describe("ID of the message to delete"),
    },
    async ({ chat, message_id }) => {
      try {
        await wa.deleteMessage(chat, message_id);
        return ok({ deleted: true, messageId: message_id });
      } catch (e) {
        return err(String(e));
      }
    }
  );

  server.tool(
    "react_message",
    "React to a message with an emoji",
    {
      chat: z.string().describe("Chat JID, phone number, or contact name"),
      message_id: z.string().describe("ID of the message to react to"),
      emoji: z.string().describe("Emoji to react with (e.g., \ud83d\udc4d, \u2764\ufe0f, \ud83d\ude02)"),
    },
    async ({ chat, message_id, emoji }) => {
      try {
        await wa.reactMessage(chat, message_id, emoji);
        return ok({ reacted: true, messageId: message_id, emoji });
      } catch (e) {
        return err(String(e));
      }
    }
  );

  // ===== READING TOOLS =====

  server.tool(
    "list_chats",
    "List all chats with last message preview and unread count",
    {
      limit: z.number().optional().describe("Max number of chats to return (default 50)"),
    },
    async ({ limit }) => {
      try {
        const chats = await wa.listChats();
        return ok(chats.slice(0, limit || 50));
      } catch (e) {
        return err(String(e));
      }
    }
  );

  server.tool(
    "read_messages",
    "Read messages from a specific chat",
    {
      chat: z.string().describe("Phone number, contact name, or chat JID"),
      limit: z.number().optional().describe("Number of messages to return (default 50)"),
      offset: z.number().optional().describe("Offset for pagination (default 0)"),
    },
    async ({ chat, limit, offset }) => {
      try {
        const messages = wa.readMessages(chat, limit || 50, offset || 0);
        return ok(messages.map((m) => ({
          id: m.id,
          sender: m.sender_name || m.sender_jid,
          content: m.content,
          type: m.message_type,
          timestamp: m.timestamp,
          time: new Date(m.timestamp * 1000).toISOString(),
          fromMe: m.is_from_me,
          quotedId: m.quoted_message_id,
          mediaType: m.media_type,
        })));
      } catch (e) {
        return err(String(e));
      }
    }
  );

  server.tool(
    "search_messages",
    "Search messages across all chats or within a specific chat",
    {
      query: z.string().describe("Text to search for"),
      chat: z.string().optional().describe("Optional: limit search to this chat (phone number, name, or JID)"),
      limit: z.number().optional().describe("Max results (default 50)"),
    },
    async ({ query, chat, limit }) => {
      try {
        const messages = wa.searchMessages(query, chat, limit || 50);
        return ok(messages.map((m) => ({
          id: m.id,
          chat: m.chat_jid,
          sender: m.sender_name || m.sender_jid,
          content: m.content,
          timestamp: m.timestamp,
          time: new Date(m.timestamp * 1000).toISOString(),
        })));
      } catch (e) {
        return err(String(e));
      }
    }
  );

  server.tool(
    "get_chat_info",
    "Get details about a chat (contact info or group info)",
    {
      chat: z.string().describe("Phone number, contact name, or chat JID"),
    },
    async ({ chat }) => {
      try {
        const info = await wa.getChatInfo(chat);
        return ok(info);
      } catch (e) {
        return err(String(e));
      }
    }
  );

  server.tool(
    "download_media",
    "Download media from a received message to ~/Downloads/whatsapp-media/",
    {
      chat: z.string().describe("Chat JID, phone number, or contact name"),
      message_id: z.string().describe("ID of the message containing media"),
    },
    async ({ chat, message_id }) => {
      try {
        const path = await wa.downloadMedia(chat, message_id);
        return ok({ downloaded: true, path });
      } catch (e) {
        return err(String(e));
      }
    }
  );

  // ===== CONTACT TOOLS =====

  server.tool(
    "list_contacts",
    "List all saved contacts",
    {},
    async () => {
      try {
        const contacts = wa.listContacts();
        return ok(contacts.map((c) => ({
          jid: c.jid,
          name: c.name || c.notify_name || null,
          phone: c.phone,
        })));
      } catch (e) {
        return err(String(e));
      }
    }
  );

  server.tool(
    "get_contact",
    "Get contact details by phone number",
    {
      phone: z.string().describe("Phone number"),
    },
    async ({ phone }) => {
      try {
        const contact = wa.getContact(phone);
        if (!contact) return ok({ found: false, phone });
        return ok({ found: true, ...contact });
      } catch (e) {
        return err(String(e));
      }
    }
  );

  server.tool(
    "check_number",
    "Check if a phone number is registered on WhatsApp",
    {
      phone: z.string().describe("Phone number to check"),
    },
    async ({ phone }) => {
      try {
        const result = await wa.checkNumber(phone);
        return ok(result);
      } catch (e) {
        return err(String(e));
      }
    }
  );

  server.tool(
    "get_profile_picture",
    "Get a contact's profile picture URL",
    {
      contact: z.string().describe("Phone number, contact name, or JID"),
    },
    async ({ contact }) => {
      try {
        const url = await wa.getProfilePicture(contact);
        return ok({ contact, profilePictureUrl: url });
      } catch (e) {
        return err(String(e));
      }
    }
  );

  // ===== GROUP TOOLS =====

  server.tool(
    "list_groups",
    "List all WhatsApp groups with member count",
    {},
    async () => {
      try {
        const groups = await wa.listGroups();
        return ok(groups);
      } catch (e) {
        return err(String(e));
      }
    }
  );

  server.tool(
    "get_group_info",
    "Get group details including members, admins, and description",
    {
      group_jid: z.string().describe("Group JID (ending in @g.us)"),
    },
    async ({ group_jid }) => {
      try {
        const info = await wa.getGroupInfo(group_jid);
        return ok({
          jid: info.id,
          subject: info.subject,
          description: info.desc,
          owner: info.owner,
          creation: info.creation,
          participants: info.participants.map((p) => ({
            jid: p.id,
            admin: p.admin,
          })),
        });
      } catch (e) {
        return err(String(e));
      }
    }
  );

  server.tool(
    "create_group",
    "Create a new WhatsApp group",
    {
      name: z.string().describe("Group name"),
      members: z.array(z.string()).describe("Array of phone numbers or contact names to add"),
    },
    async ({ name, members }) => {
      try {
        const result = await wa.createGroup(name, members);
        return ok(result);
      } catch (e) {
        return err(String(e));
      }
    }
  );

  server.tool(
    "add_group_member",
    "Add members to a group",
    {
      group_jid: z.string().describe("Group JID"),
      members: z.array(z.string()).describe("Phone numbers or contact names to add"),
    },
    async ({ group_jid, members }) => {
      try {
        await wa.addGroupMember(group_jid, members);
        return ok({ added: true, group: group_jid, members });
      } catch (e) {
        return err(String(e));
      }
    }
  );

  server.tool(
    "remove_group_member",
    "Remove members from a group",
    {
      group_jid: z.string().describe("Group JID"),
      members: z.array(z.string()).describe("Phone numbers or contact names to remove"),
    },
    async ({ group_jid, members }) => {
      try {
        await wa.removeGroupMember(group_jid, members);
        return ok({ removed: true, group: group_jid, members });
      } catch (e) {
        return err(String(e));
      }
    }
  );

  server.tool(
    "leave_group",
    "Leave a WhatsApp group",
    {
      group_jid: z.string().describe("Group JID"),
    },
    async ({ group_jid }) => {
      try {
        await wa.leaveGroup(group_jid);
        return ok({ left: true, group: group_jid });
      } catch (e) {
        return err(String(e));
      }
    }
  );

  server.tool(
    "send_group_message",
    "Send a message to a group",
    {
      group_jid: z.string().describe("Group JID (ending in @g.us)"),
      message: z.string().describe("Text message to send"),
    },
    async ({ group_jid, message }) => {
      try {
        const result = await wa.sendGroupMessage(group_jid, message);
        return ok({ sent: true, group: group_jid, messageId: result?.key?.id });
      } catch (e) {
        return err(String(e));
      }
    }
  );

  // ===== NOTIFICATION RESOURCE =====

  server.registerResource(
    "notifications",
    NOTIFICATION_URI,
    {
      title: "WhatsApp Notifications",
      description: "Real-time incoming WhatsApp message notifications. Subscribe to get notified when new messages arrive.",
      mimeType: "application/json",
    },
    async (uri) => {
      return {
        contents: [{
          uri: uri.toString(),
          mimeType: "application/json",
          text: JSON.stringify({
            count: recentNotifications.length,
            notifications: recentNotifications,
          }, null, 2),
        }],
      };
    }
  );

  // Handle subscribe/unsubscribe for resource notifications
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    subscribedUris.add(request.params.uri);
    return {};
  });

  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    subscribedUris.delete(request.params.uri);
    return {};
  });

  // ===== NOTIFICATION TOOL =====

  server.tool(
    "get_notifications",
    "Get recent incoming message notifications. Returns new messages since last check.",
    {
      limit: z.number().optional().describe("Max notifications to return (default 20)"),
      clear: z.boolean().optional().describe("Clear notifications after reading (default false)"),
    },
    async ({ limit, clear }) => {
      const results = recentNotifications.slice(0, limit || 20);
      if (clear) {
        recentNotifications.length = 0;
      }
      return ok({
        count: results.length,
        notifications: results,
      });
    }
  );

  server.tool(
    "clear_notifications",
    "Clear all pending notifications",
    {},
    async () => {
      const count = recentNotifications.length;
      recentNotifications.length = 0;
      return ok({ cleared: count });
    }
  );

  // Connect transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Start WhatsApp connection AFTER MCP transport is ready
  setTimeout(() => {
    wa.connect().catch((e) => {
      connectionStatus = `error: ${e.message}`;
    });
  }, 100);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    await wa.disconnect();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await wa.disconnect();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
