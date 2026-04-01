import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

export interface StoredMessage {
  id: string;
  chat_jid: string;
  sender_jid: string;
  sender_name: string;
  content: string;
  message_type: string;
  timestamp: number;
  is_from_me: boolean;
  quoted_message_id: string | null;
  media_type: string | null;
  media_url: string | null;
  raw_json: string;
}

export class MessageDatabase {
  db: Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        sender_jid TEXT NOT NULL,
        sender_name TEXT DEFAULT '',
        content TEXT DEFAULT '',
        message_type TEXT DEFAULT 'text',
        timestamp INTEGER NOT NULL,
        is_from_me INTEGER DEFAULT 0,
        quoted_message_id TEXT,
        media_type TEXT,
        media_url TEXT,
        raw_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_jid);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_content ON messages(content);

      CREATE TABLE IF NOT EXISTS contacts (
        jid TEXT PRIMARY KEY,
        name TEXT,
        notify_name TEXT,
        phone TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
      CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
    `);
  }

  storeMessage(msg: StoredMessage) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO messages (id, chat_jid, sender_jid, sender_name, content, message_type, timestamp, is_from_me, quoted_message_id, media_type, media_url, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      msg.id,
      msg.chat_jid,
      msg.sender_jid,
      msg.sender_name,
      msg.content,
      msg.message_type,
      msg.timestamp,
      msg.is_from_me ? 1 : 0,
      msg.quoted_message_id,
      msg.media_type,
      msg.media_url,
      msg.raw_json
    );
  }

  getMessages(chatJid: string, limit: number = 50, offset: number = 0): StoredMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?
    `);
    return stmt.all(chatJid, limit, offset) as StoredMessage[];
  }

  searchMessages(query: string, chatJid?: string, limit: number = 50): StoredMessage[] {
    if (chatJid) {
      const stmt = this.db.prepare(`
        SELECT * FROM messages WHERE chat_jid = ? AND content LIKE ? ORDER BY timestamp DESC LIMIT ?
      `);
      return stmt.all(chatJid, `%${query}%`, limit) as StoredMessage[];
    }
    const stmt = this.db.prepare(`
      SELECT * FROM messages WHERE content LIKE ? ORDER BY timestamp DESC LIMIT ?
    `);
    return stmt.all(`%${query}%`, limit) as StoredMessage[];
  }

  storeContact(jid: string, name: string | null, notifyName: string | null, phone: string | null) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO contacts (jid, name, notify_name, phone) VALUES (?, ?, ?, ?)
    `);
    stmt.run(jid, name, notifyName, phone);
  }

  findContactByName(name: string): Array<{ jid: string; name: string; notify_name: string; phone: string }> {
    const stmt = this.db.prepare(`
      SELECT * FROM contacts WHERE name LIKE ? OR notify_name LIKE ? LIMIT 10
    `);
    return stmt.all(`%${name}%`, `%${name}%`) as Array<{ jid: string; name: string; notify_name: string; phone: string }>;
  }

  getContact(jid: string): { jid: string; name: string; notify_name: string; phone: string } | undefined {
    const stmt = this.db.prepare(`SELECT * FROM contacts WHERE jid = ?`);
    return stmt.get(jid) as { jid: string; name: string; notify_name: string; phone: string } | undefined;
  }

  getAllContacts(): Array<{ jid: string; name: string; notify_name: string; phone: string }> {
    const stmt = this.db.prepare(`SELECT * FROM contacts ORDER BY name`);
    return stmt.all() as Array<{ jid: string; name: string; notify_name: string; phone: string }>;
  }

  close() {
    this.db.close();
  }
}
