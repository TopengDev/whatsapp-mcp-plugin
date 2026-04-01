# WhatsApp MCP Plugin for Claude Code

WhatsApp messaging bridge for Claude Code using [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web protocol).

## Features

- **28 tools**: Send/receive messages, media, locations, contacts, groups, and more
- **Real-time notifications**: Channel notifications appear directly in Claude Code terminal
- **Contact resolution**: Send to contacts by name or phone number
- **Message history**: SQLite-backed search and history
- **Auto-reconnect**: Persistent sessions with automatic reconnection

## Install

```
/plugin marketplace add TopengDev/whatsapp-marketplace
/plugin install whatsapp@TopengDev
```

## First-time setup

```
/whatsapp:configure
```

Scan the QR code with WhatsApp > Settings > Linked Devices > Link a Device.

## Usage

```
/whatsapp
```

Then ask Claude to send messages, read chats, search conversations, etc.

## Config

Config file: `~/.config/whatsapp-mcp/config.json`

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `notificationSound` | boolean | `true` | Play sound on incoming messages |
| `notificationSoundPath` | string | freedesktop sound | Custom notification sound file |
| `autoReconnect` | boolean | `true` | Auto-reconnect on disconnect |
| `maxReconnectAttempts` | number | `10` | Max reconnect attempts |

## License

MIT
