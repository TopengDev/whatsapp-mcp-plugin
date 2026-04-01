#!/bin/bash
# Patches for @whiskeysockets/baileys to fix WhatsApp Web protocol compatibility
# See: https://github.com/WhiskeySockets/Baileys/issues/2370, #2376

BAILEYS="node_modules/@whiskeysockets/baileys/lib"

# 1. Fix platform: WEB -> MACOS (WhatsApp rejects WEB platform during pairing)
sed -i 's/Platform\.WEB,/Platform.MACOS,/' "$BAILEYS/Utils/validate-connection.js"

# 2. Remove lidDbMigrated field (causes registration failure)
sed -i '/lidDbMigrated: false/d' "$BAILEYS/Utils/validate-connection.js"

# 3. Remove await from noise.finishInit() (race condition fix)
sed -i 's/await noise.finishInit();/noise.finishInit();/' "$BAILEYS/Socket/socket.js"

echo "Baileys patched successfully"
