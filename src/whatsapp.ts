import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  WASocket,
  proto,
  getContentType,
  downloadMediaMessage,
  generateForwardMessageContent,
  generateWAMessageFromContent,
  jidNormalizedUser,
  WAMessage,
  AnyMessageContent,
  GroupMetadata,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import { mkdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { MessageDatabase, StoredMessage } from "./database.js";
import { WhatsAppConfig } from "./config.js";

// Baileys uses pino logger
import P from "pino";

export interface ChatInfo {
  jid: string;
  name: string;
  lastMessage: string;
  lastMessageTime: number;
  unreadCount: number;
  isGroup: boolean;
}

export class WhatsAppClient {
  private sock: WASocket | null = null;
  private config: WhatsAppConfig;
  private db: MessageDatabase;
  private qrCode: string | null = null;
  private connected: boolean = false;
  private reconnectAttempts: number = 0;
  private qrListeners: Array<(qr: string) => void> = [];
  private connectionListeners: Array<(status: string) => void> = [];
  private messageListeners: Array<(msg: StoredMessage) => void> = [];

  constructor(config: WhatsAppConfig) {
    this.config = config;
    this.db = new MessageDatabase(config.databasePath);
  }

  async connect(): Promise<void> {
    if (!existsSync(this.config.authDir)) {
      mkdirSync(this.config.authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.config.authDir);

    const logger = P({ level: "silent" }) as any;

    this.sock = makeWASocket({
      version: [2, 3000, 1034074495],
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      printQRInTerminal: false,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qrCode = qr;
        this.qrListeners.forEach((fn) => fn(qr));
      }

      if (connection === "close") {
        this.connected = false;
        const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;

        if (reason === DisconnectReason.timedOut || reason === 408) {
          // QR expired or connection timed out — reconnect immediately for fresh QR
          this.qrCode = null;
          setTimeout(() => this.connect(), 1000);
          this.connectionListeners.forEach((fn) => fn("waiting for QR scan"));
        } else if (shouldReconnect && this.config.autoReconnect && this.reconnectAttempts < this.config.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
          setTimeout(() => this.connect(), delay);
          this.connectionListeners.forEach((fn) =>
            fn(`disconnected, reconnecting (attempt ${this.reconnectAttempts})`)
          );
        } else {
          this.connectionListeners.forEach((fn) => fn("logged out"));
        }
      } else if (connection === "open") {
        this.connected = true;
        this.reconnectAttempts = 0;
        this.qrCode = null;
        this.connectionListeners.forEach((fn) => fn("connected"));
      }
    });

    this.sock.ev.on("messages.upsert", ({ messages }) => {
      for (const msg of messages) {
        this.storeMessage(msg);
      }
    });

    this.sock.ev.on("contacts.update", (contacts) => {
      for (const contact of contacts) {
        if (contact.id) {
          this.db.storeContact(
            contact.id,
            contact.verifiedName || null,
            contact.notify || null,
            contact.id.replace("@s.whatsapp.net", "")
          );
        }
      }
    });

    this.sock.ev.on("contacts.upsert", (contacts) => {
      for (const contact of contacts) {
        if (contact.id) {
          this.db.storeContact(
            contact.id,
            contact.verifiedName || null,
            contact.notify || null,
            contact.id.replace("@s.whatsapp.net", "")
          );
        }
      }
    });
  }

  private storeMessage(msg: WAMessage) {
    if (!msg.key.id || !msg.key.remoteJid) return;
    const content = this.extractMessageContent(msg);
    const messageType = msg.message ? getContentType(msg.message) || "unknown" : "unknown";

    const stored: StoredMessage = {
      id: msg.key.id,
      chat_jid: msg.key.remoteJid,
      sender_jid: msg.key.fromMe ? "me" : msg.key.participant || msg.key.remoteJid,
      sender_name: msg.pushName || "",
      content,
      message_type: messageType,
      timestamp: typeof msg.messageTimestamp === "number" ? msg.messageTimestamp : Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
      is_from_me: msg.key.fromMe || false,
      quoted_message_id: msg.message?.extendedTextMessage?.contextInfo?.stanzaId || null,
      media_type: this.getMediaType(messageType),
      media_url: null,
      raw_json: JSON.stringify(msg),
    };

    this.db.storeMessage(stored);
    this.messageListeners.forEach((fn) => fn(stored));
  }

  private extractMessageContent(msg: WAMessage): string {
    if (!msg.message) return "";
    const type = getContentType(msg.message);
    if (!type) return "";

    const m = msg.message as any;

    if (type === "conversation") return m.conversation || "";
    if (type === "extendedTextMessage") return m.extendedTextMessage?.text || "";
    if (type === "imageMessage") return m.imageMessage?.caption || "[Image]";
    if (type === "videoMessage") return m.videoMessage?.caption || "[Video]";
    if (type === "audioMessage") return "[Audio]";
    if (type === "documentMessage") return m.documentMessage?.fileName || "[Document]";
    if (type === "stickerMessage") return "[Sticker]";
    if (type === "contactMessage") return m.contactMessage?.displayName || "[Contact]";
    if (type === "locationMessage") return `[Location: ${m.locationMessage?.degreesLatitude}, ${m.locationMessage?.degreesLongitude}]`;
    if (type === "reactionMessage") return m.reactionMessage?.text || "";
    if (type === "protocolMessage") return "[System]";

    return `[${type}]`;
  }

  private getMediaType(messageType: string): string | null {
    const mediaTypes: Record<string, string> = {
      imageMessage: "image",
      videoMessage: "video",
      audioMessage: "audio",
      documentMessage: "document",
      stickerMessage: "sticker",
    };
    return mediaTypes[messageType] || null;
  }

  // ---- Phone number utilities ----

  normalizePhoneNumber(input: string): string {
    let num = input.replace(/[\s\-\(\)]/g, "");
    // Handle Indonesian numbers
    if (num.startsWith("08")) num = "62" + num.slice(1);
    if (num.startsWith("+")) num = num.slice(1);
    // Ensure it's digits only
    num = num.replace(/\D/g, "");
    return num;
  }

  phoneToJid(phone: string): string {
    const normalized = this.normalizePhoneNumber(phone);
    return `${normalized}@s.whatsapp.net`;
  }

  async resolveRecipient(input: string): Promise<string> {
    // If it looks like a phone number, normalize it
    if (/^[\+\d\s\-\(\)]+$/.test(input) && input.replace(/\D/g, "").length >= 7) {
      return this.phoneToJid(input);
    }

    // If it already is a JID
    if (input.includes("@")) return input;

    // Try to resolve as a contact name
    const contacts = this.db.findContactByName(input);
    if (contacts.length > 0) {
      return contacts[0].jid;
    }

    throw new Error(`Could not resolve recipient: "${input}". Try using a phone number instead.`);
  }

  // ---- Connection ----

  isConnected(): boolean {
    return this.connected;
  }

  getQrCode(): string | null {
    return this.qrCode;
  }

  getSocket(): WASocket {
    if (!this.sock) throw new Error("WhatsApp not connected. Please connect first.");
    return this.sock;
  }

  ensureConnected() {
    if (!this.connected || !this.sock) {
      throw new Error("WhatsApp is not connected. Check connection_status for details.");
    }
  }

  onQr(fn: (qr: string) => void) {
    this.qrListeners.push(fn);
  }

  onConnection(fn: (status: string) => void) {
    this.connectionListeners.push(fn);
  }

  onMessage(fn: (msg: StoredMessage) => void) {
    this.messageListeners.push(fn);
  }

  // ---- Messaging ----

  async sendMessage(to: string, text: string): Promise<WAMessage | undefined> {
    this.ensureConnected();
    const jid = await this.resolveRecipient(to);
    return this.sock!.sendMessage(jid, { text });
  }

  async sendMedia(to: string, mediaPath: string, type: "image" | "video" | "audio" | "document", caption?: string): Promise<WAMessage | undefined> {
    this.ensureConnected();
    const jid = await this.resolveRecipient(to);
    const { readFileSync } = await import("fs");
    const buffer = readFileSync(mediaPath);

    const content: AnyMessageContent = type === "image"
      ? { image: buffer, caption }
      : type === "video"
      ? { video: buffer, caption }
      : type === "audio"
      ? { audio: buffer, mimetype: "audio/ogg; codecs=opus", ptt: true }
      : { document: buffer, mimetype: "application/octet-stream", fileName: mediaPath.split("/").pop() || "file", caption };

    return this.sock!.sendMessage(jid, content);
  }

  async sendLocation(to: string, lat: number, lng: number, name?: string): Promise<WAMessage | undefined> {
    this.ensureConnected();
    const jid = await this.resolveRecipient(to);
    return this.sock!.sendMessage(jid, {
      location: { degreesLatitude: lat, degreesLongitude: lng, name },
    });
  }

  async sendContact(to: string, contactName: string, contactPhone: string): Promise<WAMessage | undefined> {
    this.ensureConnected();
    const jid = await this.resolveRecipient(to);
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${contactName}\nTEL;type=CELL;type=VOICE;waid=${contactPhone.replace(/\D/g, "")}:${contactPhone}\nEND:VCARD`;
    return this.sock!.sendMessage(jid, {
      contacts: { displayName: contactName, contacts: [{ vcard }] },
    });
  }

  async replyMessage(chatJid: string, messageId: string, text: string): Promise<WAMessage | undefined> {
    this.ensureConnected();
    const jid = await this.resolveRecipient(chatJid);
    return this.sock!.sendMessage(jid, { text }, { quoted: { key: { remoteJid: jid, id: messageId }, message: {} } as WAMessage });
  }

  async forwardMessage(fromChat: string, messageId: string, toChat: string): Promise<WAMessage | undefined> {
    this.ensureConnected();
    const fromJid = await this.resolveRecipient(fromChat);
    const toJid = await this.resolveRecipient(toChat);

    // Get message from database
    const dbMessages = this.db.getMessages(fromJid, 200);
    const dbMsg = dbMessages.find((m) => m.id === messageId);
    if (!dbMsg) throw new Error(`Message ${messageId} not found in chat`);

    const originalMsg = JSON.parse(dbMsg.raw_json) as WAMessage;
    const forwardContent = generateForwardMessageContent(originalMsg, false);
    const contentMsg = generateWAMessageFromContent(toJid, forwardContent, { userJid: this.sock!.user?.id || "" });
    await this.sock!.relayMessage(toJid, contentMsg.message!, { messageId: contentMsg.key.id! });
    return contentMsg as unknown as WAMessage;
  }

  async deleteMessage(chatJid: string, messageId: string): Promise<void> {
    this.ensureConnected();
    const jid = await this.resolveRecipient(chatJid);
    await this.sock!.sendMessage(jid, { delete: { remoteJid: jid, id: messageId, fromMe: true } });
  }

  async reactMessage(chatJid: string, messageId: string, emoji: string): Promise<WAMessage | undefined> {
    this.ensureConnected();
    const jid = await this.resolveRecipient(chatJid);
    return this.sock!.sendMessage(jid, {
      react: { text: emoji, key: { remoteJid: jid, id: messageId } },
    });
  }

  // ---- Reading ----

  async listChats(): Promise<ChatInfo[]> {
    this.ensureConnected();
    const chats: ChatInfo[] = [];
    const store = await this.sock!.groupFetchAllParticipating();

    // Get chats from database (most recently messaged)
    const stmt = this.db["db"].prepare(`
      SELECT chat_jid, MAX(timestamp) as last_ts, content as last_content
      FROM messages
      GROUP BY chat_jid
      ORDER BY last_ts DESC
      LIMIT 100
    `);
    const rows = stmt.all() as Array<{ chat_jid: string; last_ts: number; last_content: string }>;

    for (const row of rows) {
      const isGroup = row.chat_jid.endsWith("@g.us");
      let name = row.chat_jid;

      if (isGroup && store[row.chat_jid]) {
        name = store[row.chat_jid].subject;
      } else {
        const contact = this.db.getContact(row.chat_jid);
        if (contact) name = contact.name || contact.notify_name || contact.phone || row.chat_jid;
      }

      chats.push({
        jid: row.chat_jid,
        name,
        lastMessage: row.last_content || "",
        lastMessageTime: row.last_ts,
        unreadCount: 0,
        isGroup,
      });
    }

    return chats;
  }

  readMessages(chatJidOrName: string, limit: number = 50, offset: number = 0): StoredMessage[] {
    // Try as JID first
    let jid = chatJidOrName;
    if (!chatJidOrName.includes("@")) {
      // Try phone number
      if (/^[\+\d\s\-\(\)]+$/.test(chatJidOrName) && chatJidOrName.replace(/\D/g, "").length >= 7) {
        jid = this.phoneToJid(chatJidOrName);
      } else {
        // Try contact name
        const contacts = this.db.findContactByName(chatJidOrName);
        if (contacts.length > 0) jid = contacts[0].jid;
        else throw new Error(`Could not resolve chat: "${chatJidOrName}"`);
      }
    }
    return this.db.getMessages(jid, limit, offset);
  }

  searchMessages(query: string, chatJidOrName?: string, limit: number = 50): StoredMessage[] {
    let chatJid: string | undefined;
    if (chatJidOrName) {
      if (!chatJidOrName.includes("@")) {
        if (/^[\+\d\s\-\(\)]+$/.test(chatJidOrName) && chatJidOrName.replace(/\D/g, "").length >= 7) {
          chatJid = this.phoneToJid(chatJidOrName);
        } else {
          const contacts = this.db.findContactByName(chatJidOrName);
          if (contacts.length > 0) chatJid = contacts[0].jid;
        }
      } else {
        chatJid = chatJidOrName;
      }
    }
    return this.db.searchMessages(query, chatJid, limit);
  }

  async getChatInfo(chatJidOrName: string): Promise<Record<string, unknown>> {
    this.ensureConnected();
    const jid = await this.resolveRecipient(chatJidOrName);

    if (jid.endsWith("@g.us")) {
      const meta = await this.sock!.groupMetadata(jid);
      return {
        type: "group",
        jid,
        subject: meta.subject,
        description: meta.desc,
        owner: meta.owner,
        creation: meta.creation,
        participantCount: meta.participants.length,
        participants: meta.participants.map((p) => ({
          jid: p.id,
          admin: p.admin,
        })),
      };
    }

    const contact = this.db.getContact(jid);
    return {
      type: "individual",
      jid,
      name: contact?.name || contact?.notify_name || null,
      phone: contact?.phone || jid.replace("@s.whatsapp.net", ""),
    };
  }

  async downloadMedia(chatJid: string, messageId: string): Promise<string> {
    this.ensureConnected();

    const jid = await this.resolveRecipient(chatJid);
    const dbMessages = this.db.getMessages(jid, 500);
    const dbMsg = dbMessages.find((m) => m.id === messageId);
    if (!dbMsg) throw new Error(`Message ${messageId} not found`);

    const originalMsg = JSON.parse(dbMsg.raw_json) as WAMessage;
    const buffer = await downloadMediaMessage(originalMsg, "buffer", {});

    if (!existsSync(this.config.mediaDownloadDir)) {
      mkdirSync(this.config.mediaDownloadDir, { recursive: true });
    }

    const ext = dbMsg.media_type === "image" ? ".jpg"
      : dbMsg.media_type === "video" ? ".mp4"
      : dbMsg.media_type === "audio" ? ".ogg"
      : dbMsg.media_type === "sticker" ? ".webp"
      : "";
    const filename = `${messageId}${ext}`;
    const filepath = join(this.config.mediaDownloadDir, filename);
    writeFileSync(filepath, buffer as Buffer);

    return filepath;
  }

  // ---- Contacts ----

  listContacts(): Array<{ jid: string; name: string; notify_name: string; phone: string }> {
    return this.db.getAllContacts();
  }

  getContact(phone: string): { jid: string; name: string; notify_name: string; phone: string } | undefined {
    const jid = this.phoneToJid(phone);
    return this.db.getContact(jid);
  }

  async checkNumber(phone: string): Promise<{ exists: boolean; jid: string }> {
    this.ensureConnected();
    const normalized = this.normalizePhoneNumber(phone);
    const results = await this.sock!.onWhatsApp(normalized);
    const result = results?.[0];
    return { exists: !!result?.exists, jid: result?.jid || `${normalized}@s.whatsapp.net` };
  }

  async getProfilePicture(jidOrPhone: string): Promise<string | null> {
    this.ensureConnected();
    const jid = await this.resolveRecipient(jidOrPhone);
    try {
      return await this.sock!.profilePictureUrl(jid, "image") || null;
    } catch {
      return null;
    }
  }

  // ---- Groups ----

  async listGroups(): Promise<Array<{ jid: string; subject: string; memberCount: number }>> {
    this.ensureConnected();
    const groups = await this.sock!.groupFetchAllParticipating();
    return Object.values(groups).map((g) => ({
      jid: g.id,
      subject: g.subject,
      memberCount: g.participants.length,
    }));
  }

  async getGroupInfo(groupJid: string): Promise<GroupMetadata> {
    this.ensureConnected();
    return this.sock!.groupMetadata(groupJid);
  }

  async createGroup(name: string, members: string[]): Promise<{ jid: string; subject: string }> {
    this.ensureConnected();
    const jids = await Promise.all(members.map((m) => this.resolveRecipient(m)));
    const result = await this.sock!.groupCreate(name, jids);
    return { jid: result.id, subject: name };
  }

  async addGroupMember(groupJid: string, members: string[]): Promise<void> {
    this.ensureConnected();
    const jids = await Promise.all(members.map((m) => this.resolveRecipient(m)));
    await this.sock!.groupParticipantsUpdate(groupJid, jids, "add");
  }

  async removeGroupMember(groupJid: string, members: string[]): Promise<void> {
    this.ensureConnected();
    const jids = await Promise.all(members.map((m) => this.resolveRecipient(m)));
    await this.sock!.groupParticipantsUpdate(groupJid, jids, "remove");
  }

  async leaveGroup(groupJid: string): Promise<void> {
    this.ensureConnected();
    await this.sock!.groupLeave(groupJid);
  }

  async sendGroupMessage(groupJid: string, text: string): Promise<WAMessage | undefined> {
    this.ensureConnected();
    return this.sock!.sendMessage(groupJid, { text });
  }

  // ---- Cleanup ----

  async disconnect() {
    this.connected = false;
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    this.db.close();
  }
}
