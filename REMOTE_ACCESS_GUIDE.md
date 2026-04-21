# OpenCode Remote Access Configuration

## Server Information

- **Public IP:** 212.105.155.6
- **Server Port:** 56912
- **Relay Port:** 3747
- **Username:** opencode
- **Password:** Crime1312

## Quick Connect URLs

### Direct Server Connection

```
http://212.105.155.6:56912
```

### WebSocket Relay (for Live Share)

```
ws://212.105.155.6:3747
```

## Setup Instructions

### 1. Router Port Forwarding

Add these rules to your router:

| Service | External Port | Internal Port | Protocol | Internal IP   |
| ------- | ------------- | ------------- | -------- | ------------- |
| Relay   | 3747          | 3747          | TCP      | 192.168.1.182 |
| Server  | 56912         | 56912         | TCP      | 192.168.1.182 |

Access your router at: `http://192.168.1.1` or `http://192.168.0.1`

### 2. Start Servers

Run these commands:

```bash
# Terminal 1: Start Relay Server
bun relay-server.ts

# Terminal 2: Start OpenCode Server
set OPENCODE_SERVER_PASSWORD=Crime1312
bun run --cwd packages/opencode serve --hostname 0.0.0.0 --port 56912
```

Or use the batch files:

- `start-relay.bat` - Start relay server
- `start-server-remote.bat` - Start main server

### 3. Verify Connectivity

Test from outside your network:

```bash
curl http://212.105.155.6:56912
curl http://212.105.155.6:3747/health
```

### 4. Connect to OpenCode Desktop

1. Open OpenCode Desktop
2. Click server icon (bottom left)
3. Click "Add Server"
4. Enter:
   - URL: `http://212.105.155.6:56912`
   - Name: `Remote Server`
   - Username: `opencode`
   - Password: `Crime1312`
5. Click "Connect"

## Live Share (Collaborative Sessions)

### As Host:

1. Open Live Share panel (Ctrl+Shift+S)
2. Enter Relay URL: `ws://212.105.155.6:3747`
3. Click "Start Sharing"
4. Share the Share Code with collaborators

### As Collaborator:

1. Get Share Code from host
2. Enter in OpenCode Desktop Live Share panel
3. Click "Join"

## Troubleshooting

### Can't connect?

1. Check firewall rules:

   ```powershell
   netsh advfirewall firewall add rule name="OpenCode Relay" dir=in action=allow protocol=tcp localport=3747
   netsh advfirewall firewall add rule name="OpenCode Server" dir=in action=allow protocol=tcp localport=56912
   ```

2. Verify port forwarding is correct
3. Check if ISP blocks incoming connections

### For Dynamic IP Users

Consider using a dynamic DNS service (no-ip, duckdns) for a stable domain name.

## Security Notes

- Change the password from `Crime1312` to something unique
- Consider using VPN instead of direct port forwarding
- For production use, add HTTPS with Let's Encrypt
