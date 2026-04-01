---
name: configure
description: Set up the WhatsApp connection — scan QR code to link a device, check connection status. Use when the user wants to connect WhatsApp, scan a QR code, or check if WhatsApp is connected.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(mkdir *)
  - mcp__whatsapp__connection_status
  - mcp__whatsapp__get_qr
---

# WhatsApp Configure

Set up the WhatsApp connection for first-time use.

## Steps

1. Call `connection_status` to check if already connected
2. If not connected:
   - Call `get_qr` to get the QR code
   - Display the ASCII QR code to the user
   - Ask them to scan with WhatsApp > Settings > Linked Devices > Link a Device
   - QR codes expire in ~20 seconds, get a fresh one if needed
3. Once scanned, the session persists in `~/.config/whatsapp-mcp/auth/` — no re-scan needed

## Config

Config file: `~/.config/whatsapp-mcp/config.json`

Available settings:
- `notificationSound` (boolean) — play sound on incoming messages
- `notificationSoundPath` (string) — custom notification sound file
- `autoReconnect` (boolean) — auto-reconnect on disconnect
- `maxReconnectAttempts` (number) — max reconnect attempts
