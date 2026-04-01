import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface WhatsAppConfig {
  authDir: string;
  mediaDownloadDir: string;
  databasePath: string;
  autoReconnect: boolean;
  maxReconnectAttempts: number;
  messageHistoryLimit: number;
  notificationSound: boolean;
  notificationSoundPath: string;
}

const CONFIG_DIR = join(homedir(), ".config", "whatsapp-mcp");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const DEFAULT_CONFIG: WhatsAppConfig = {
  authDir: join(CONFIG_DIR, "auth"),
  mediaDownloadDir: join(homedir(), "Downloads", "whatsapp-media"),
  databasePath: join(CONFIG_DIR, "messages.db"),
  autoReconnect: true,
  maxReconnectAttempts: 10,
  messageHistoryLimit: 50,
  notificationSound: true,
  notificationSoundPath: "/usr/share/sounds/freedesktop/stereo/message-new-instant.oga",
};

export function loadConfig(): WhatsAppConfig {
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return DEFAULT_CONFIG;
  }

  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}
