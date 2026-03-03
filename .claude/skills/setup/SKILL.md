---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, configure Feishu, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run setup steps automatically. Only pause when user action is required (Feishu app credentials, configuration choices). Setup uses `bash setup.sh` for bootstrap, then `npx tsx setup/index.ts --step <name>` for all other steps. Steps emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. scanning a QR code, pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## 1. Bootstrap (Node.js + Dependencies)

Run `bash setup.sh` and parse the status block.

- If NODE_OK=false → Node.js is missing or too old. Use `AskUserQuestion: Would you like me to install Node.js 22?` If confirmed:
  - macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`, or nvm
  - After installing Node, re-run `bash setup.sh`
- If DEPS_OK=false → Read `logs/setup.log`. Try: delete `node_modules` and `package-lock.json`, re-run `bash setup.sh`. If native module build fails, install build tools (`xcode-select --install` on macOS, `build-essential` on Linux), then retry.
- If NATIVE_OK=false → better-sqlite3 failed to load. Install build tools and re-run.
- Record PLATFORM and IS_WSL for later steps.

## 2. Check Environment

Run `npx tsx setup/index.ts --step environment` and parse the status block.

- If HAS_ENV=true → note that .env exists, check for Feishu credentials in step 4
- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure
- Record APPLE_CONTAINER and DOCKER values for step 3

## 3. Container Runtime

### 3a. Choose runtime

Check the preflight results for `APPLE_CONTAINER` and `DOCKER`, and the PLATFORM from step 1.

- PLATFORM=linux → Docker (only option)
- PLATFORM=macos + APPLE_CONTAINER=installed → Use `AskUserQuestion: Docker (default, cross-platform) or Apple Container (native macOS)?` If Apple Container, run `/convert-to-apple-container` now, then skip to 3c.
- PLATFORM=macos + APPLE_CONTAINER=not_found → Docker (default)

### 3a-docker. Install Docker

- DOCKER=running → continue to 3b
- DOCKER=installed_not_running → start Docker: `open -a Docker` (macOS) or `sudo systemctl start docker` (Linux). Wait 15s, re-check with `docker info`.
- DOCKER=not_found → Use `AskUserQuestion: Docker is required for running agents. Would you like me to install it?` If confirmed:
  - macOS: install via `brew install --cask docker`, then `open -a Docker` and wait for it to start. If brew not available, direct to Docker Desktop download at https://docker.com/products/docker-desktop
  - Linux: install with `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`. Note: user may need to log out/in for group membership.

### 3b. Apple Container conversion gate (if needed)

**If the chosen runtime is Apple Container**, you MUST check whether the source code has already been converted from Docker to Apple Container. Do NOT skip this step. Run:

```bash
grep -q "CONTAINER_RUNTIME_BIN = 'container'" src/container-runtime.ts && echo "ALREADY_CONVERTED" || echo "NEEDS_CONVERSION"
```

**If NEEDS_CONVERSION**, the source code still uses Docker as the runtime. You MUST run the `/convert-to-apple-container` skill NOW, before proceeding to the build step.

**If ALREADY_CONVERTED**, the code already uses Apple Container. Continue to 3c.

**If the chosen runtime is Docker**, no conversion is needed — Docker is the default. Continue to 3c.

### 3c. Build and test

Run `npx tsx setup/index.ts --step container -- --runtime <chosen>` and parse the status block.

**If BUILD_OK=false:** Read `logs/setup.log` tail for the build error.
- Cache issue (stale layers): `docker builder prune -f` (Docker) or `container builder stop && container builder rm && container builder start` (Apple Container). Retry.
- Dockerfile syntax or missing files: diagnose from the log and fix, then retry.

**If TEST_OK=false but BUILD_OK=true:** The image built but won't run. Check logs — common cause is runtime not fully started. Wait a moment and retry the test.

## 4. Claude Authentication (No Script)

If HAS_ENV=true from step 2, read `.env` and check for `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. If present, confirm with user: keep or reconfigure?

AskUserQuestion: Claude subscription (Pro/Max) vs Anthropic API key?

**Subscription:** Tell user to run `claude setup-token` in another terminal, copy the token, add `CLAUDE_CODE_OAUTH_TOKEN=<token>` to `.env`. Do NOT collect the token in chat.

**API key:** Tell user to add `ANTHROPIC_API_KEY=<key>` to `.env`.

## 5. Feishu Configuration

If HAS_ENV=true from step 2, read `.env` and check for `FEISHU_APP_ID` and `FEISHU_APP_SECRET`. If present, confirm with user: keep or reconfigure?

**Guide user through Feishu app setup:**

1. Tell user to go to [Feishu Open Platform](https://open.feishu.cn/app)
2. Create a custom app (创建企业自建应用)
3. Get App ID and App Secret from the app admin panel
4. Configure permissions:
   - `im:message` - Send and receive messages
   - `im:message:send_as_bot` - Send messages as bot
   - `im:chat` - Access chat information
5. Enable long connection mode in Event Subscriptions (事件订阅):
   - Choose "Receive events/callbacks through persistent connection" (使用长连接接收事件/回调)
   - Enable "im.message.receive_v1" event

**Add credentials to .env:**

Tell user to add these lines to `.env`:
```
FEISHU_APP_ID=cli_xxxxxxxxxx
FEISHU_APP_SECRET=your_app_secret_here
```

Do NOT collect the credentials in chat - user should edit `.env` directly.

## 6. Understand Main vs Other Chats

**Main Channel (主控制台):**
- Your personal control center with full privileges
- Can manage all other chats and their tasks
- Can send messages to any registered chat via IPC
- Responds to ALL messages (no trigger word needed)
- Folder name MUST be "main"
- Recommended: Use your personal DM with the bot

**Other Chats (隔离工作空间):**
- Independent, isolated workspaces
- Can only access their own data and tasks
- Cannot interfere with other chats
- Requires trigger word by default (e.g., "@小C")
- Each has a unique folder name (e.g., "project-team", "support")
- Use for: team groups, project channels, multi-tenant scenarios

## 7. Mount Allowlist

AskUserQuestion: Agent access to external directories?

**No:** `npx tsx setup/index.ts --step mounts -- --empty`
**Yes:** Collect paths/permissions. `npx tsx setup/index.ts --step mounts -- --json '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}'`

## 8. Start Service

If service already running: unload first.
- macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`
- Linux: `systemctl --user stop nanoclaw` (or `systemctl stop nanoclaw` if root)

Run `npx tsx setup/index.ts --step service` and parse the status block.

**If FALLBACK=wsl_no_systemd:** WSL without systemd detected. Tell user they can either enable systemd in WSL (`echo -e "[boot]\nsystemd=true" | sudo tee /etc/wsl.conf` then restart WSL) or use the generated `start-nanoclaw.sh` wrapper.

**If DOCKER_GROUP_STALE=true:** The user was added to the docker group after their session started — the systemd service can't reach the Docker socket. Ask user to run these two commands:

1. Immediate fix: `sudo setfacl -m u:$(whoami):rw /var/run/docker.sock`
2. Persistent fix (re-applies after every Docker restart):
```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/socket-acl.conf << 'EOF'
[Service]
ExecStartPost=/usr/bin/setfacl -m u:USERNAME:rw /var/run/docker.sock
EOF
sudo systemctl daemon-reload
```
Replace `USERNAME` with the actual username (from `whoami`). Run the two `sudo` commands separately — the `tee` heredoc first, then `daemon-reload`. After user confirms setfacl ran, re-run the service step.

**If SERVICE_LOADED=false:**
- Read `logs/setup.log` for the error.
- macOS: check `launchctl list | grep nanoclaw`. If PID=`-` and status non-zero, read `logs/nanoclaw.error.log`.
- Linux: check `systemctl --user status nanoclaw`.
- Re-run the service step after fixing.

## 9. Configure and Register Main Channel

AskUserQuestion: Trigger word? (default: @小C)

**Tell user to:**
1. Add the bot to your main Feishu chat (personal DM or group chat)
2. Send a test message (e.g., "hello")
3. Wait a moment for the service to process it

**Capture chat ID from database:**

```bash
# Wait a few seconds after user sends message
sleep 5

# Get the first chat ID from the messages database
sqlite3 store/messages.db "SELECT DISTINCT chat_jid FROM messages ORDER BY rowid ASC LIMIT 1;"
```

**Once chat ID is captured, register the main channel:**

```bash
npx tsx setup/index.ts --step register \
  --jid "CHAT_ID" \
  --name "main" \
  --trigger "@小C" \
  --folder "main" \
  --no-trigger-required
```

**IMPORTANT: Main channel registration:**
- `--folder "main"` is REQUIRED for main channel privileges
- `--no-trigger-required` is RECOMMENDED (responds to all messages)
- `--name "main"` is conventional but not required

**To register additional chats later** (after setup is complete):

1. Add bot to the new Feishu chat
2. Send a message and capture chat ID from database:
   ```bash
   sqlite3 store/messages.db "SELECT DISTINCT chat_jid FROM messages ORDER BY rowid DESC LIMIT 5;"
   ```
3. Register with a different folder name:

```bash
npx tsx setup/index.ts --step register \
  --jid "oc_yyy" \
  --name "project-team" \
  --trigger "@小C" \
  --folder "project-team"
  # Note: no --no-trigger-required, so trigger word is required
```

**Parameters:**
- `--jid`: The chat ID from logs (e.g., `oc_xxx` for groups, `ou_xxx` for personal)
- `--name`: Friendly name for display (e.g., "main", "project-team")
- `--trigger`: Trigger pattern (e.g., "@小C")
- `--folder`: Folder name for data storage (MUST be "main" for main channel)
- `--no-trigger-required`: Bot responds to all messages (recommended for main only)
- `--assistant-name`: Custom assistant name (default: "小C")

## 10. Verify

Run `npx tsx setup/index.ts --step verify` and parse the status block.

**If STATUS=failed, fix each:**
- SERVICE=stopped → `npm run build`, then restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux) or `bash start-nanoclaw.sh` (WSL nohup)
- SERVICE=not_found → re-run step 8
- CREDENTIALS=missing → re-run step 4
- FEISHU_CONFIG=missing → re-run step 5
- REGISTERED_GROUPS=0 → re-run step 9
- MOUNT_ALLOWLIST=missing → `npx tsx setup/index.ts --step mounts -- --empty`

Tell user to test: send a message in their registered Feishu chat. Show: `tail -f logs/nanoclaw.log`

## Troubleshooting

**Service not starting:** Check `logs/nanoclaw.error.log`. Common: wrong Node path (re-run step 10), missing `.env` (step 4), missing Feishu credentials (step 5).

**Container agent fails ("Claude Code process exited with code 1"):** Ensure the container runtime is running — `open -a Docker` (macOS Docker), `container system start` (Apple Container), or `sudo systemctl start docker` (Linux). Check container logs in `groups/main/logs/container-*.log`.

**No response to messages:** Check trigger pattern. Main channel doesn't need prefix if `--no-trigger-required` was used. Check DB: `npx tsx setup/index.ts --step verify`. Check `logs/nanoclaw.log`.

**Feishu long connection fails:** Check `logs/nanoclaw.log` for connection errors. Verify `FEISHU_APP_ID` and `FEISHU_APP_SECRET` in `.env`. Ensure app has required permissions and long connection mode is enabled in Feishu app settings.

**Bot doesn't receive messages:** Ensure bot is added to the chat. Check that "im.message.receive_v1" event is enabled in Feishu app's Event Subscriptions. Verify long connection is established (look for "Feishu long connection established" in logs).

**Unload service:** macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist` | Linux: `systemctl --user stop nanoclaw`
