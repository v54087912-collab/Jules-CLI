# 🚀 Jules Local Bridge - Manual Setup & Workspace Guide

This guide provides everything you need to set up, configure, and master the Jules Local Bridge.

---

## 🛠 Step 1: Requirements & API Keys

> [!IMPORTANT]
> **Android / Termux Users:**
> Android's shared storage (`/storage/emulated/0`) does not support symbolic links or execution permissions. To install dependencies and compile the CLI, you **must** copy the project directory to Termux's internal storage (e.g. `/data/data/com.termux/files/home/.gemini/antigravity-cli/scratch/Jules-CLI`):
> ```bash
> cp -R "/storage/emulated/0/Jules-CLI-Jules-CLI" "/data/data/com.termux/files/home/.gemini/antigravity-cli/scratch/Jules-CLI"
> cd "/data/data/com.termux/files/home/.gemini/antigravity-cli/scratch/Jules-CLI"
> npm install --no-audit --no-fund --prefer-offline
> npm run build
> ```

Ensure you are in the active project folder:
```bash
# On Termux:
cd "/data/data/com.termux/files/home/.gemini/antigravity-cli/scratch/Jules-CLI"

# On PC / other platforms:
cd "/storage/emulated/0/Jules-CLI-Jules-CLI"
```

### **1. Configure Environment**
Create a `.env` file with these keys:
- `JULES_API_KEY`: Your Google Jules API key.
- `GITHUB_TOKEN`: Your GitHub Personal Access Token.

### **2. Generate JULES_API_KEY**
- Visit the **[Jules Settings Page](https://jules.google.com/settings#api)**.
- Click **"Create API key"** (Max 3 keys allowed).

### **3. Generate GITHUB_TOKEN**
- Go to GitHub -> **Settings** -> **Developer settings** -> **Personal access tokens** -> **Tokens (classic)**.
- Generate a new token with the **`repo`** scope (Full control of private repositories).

---

## 📂 Step 2: Workspace Configuration
Jules Local Bridge operates within a dedicated workspace:
```
/storage/emulated/0/Jules-Workspace
```
- **Safety Rule**: All projects must reside in subdirectories of this folder. The CLI will block execution if you are outside this boundary to protect your system files.

---

## 🔄 Step 3: Workflow & Auto-Sync
The CLI handles the heavy lifting automatically:
1. **Add Project**: Copy your project folder to `/storage/emulated/0/Jules-Workspace/my-project`.
2. **Navigate**: `cd "/storage/emulated/0/Jules-Workspace/my-project"`
3. **Launch**:
   ```bash
   # On Termux:
   node /data/data/com.termux/files/home/.gemini/antigravity-cli/scratch/Jules-CLI/dist/index.js

   # On PC / other platforms:
   node ../Jules-CLI-Jules-CLI/dist/index.js
   ```
4. **Auto-Initialization**: The CLI will:
   - Initialize Git locally.
   - Create and link a **private shadow repository** on GitHub.
   - **Auto-Sync** all files to the cloud.
   - Start your Jules session immediately.

---

## ⚡ Step 4: Execution Modes
- ⚡ **FAST Mode (`/fast`) [Default]**: Jules' proposed plans are **auto-approved**. This is the fastest way to code.
- 📋 **PLAN Mode (`/plan`)**: Jules pauses after proposing a plan, waiting for your manual `y/n` confirmation.

---

## 🖥 Step 5: Advanced Shell Features
The `jules > ` shell is packed with real-time features:
- **Live Status**: Shows exactly what Jules is doing (e.g., `Status: Working • Reading file.js`).
- **Interactive Prompts**: If Jules needs your input (e.g., "Build failed, stop?"), the CLI will pause and show the prompt with options (1. Continue, 2. Stop, etc.).
- **Session Sync**: Use `/session track <id>` to monitor a session started on the Jules Web App. The CLI validates the ID and syncs the full activity log.
- **Smart Untracking**: Once a session is finished (COMPLETED or FAILED), the CLI automatically clears the track so your next instruction starts a fresh session.

---

## 🔄 Step 6: File Patching & Backups
- **Character-Accurate Patching**: Jules Cloud sends Git Patches that the CLI applies locally, line-by-line.
- **Backups**: Every modified file gets a `.bak` backup. Use `/restore` to undo changes.
- **Media Sync**: If your prompt includes `"test project"`, a `/Test` folder is created, and all images/videos from Jules are automatically downloaded there.

---

## ⌨️ Step 7: Keyboard Shortcuts (EMACS Style)
- `Ctrl + A` / `Ctrl + E`: Jump to start/end of line.
- `Alt + B` / `Alt + F`: Move back/forward by word.
- `Ctrl + U` / `Ctrl + K`: Delete to start/end of line.
- `Alt + R`: Restore current input line.
- `ESC`: **Stop and cancel** the active cloud task in real-time.

---

## 💬 Step 8: Support & Links
- **Developer**: [https://t.me/R3V_X](https://t.me/R3V_X)
- **Community**: [https://t.me/allinformation0173](https://t.me/allinformation0173)
- **Instagram**: [https://www.instagram.com/opeditzxx/](https://www.instagram.com/opeditzxx/)

---

## 📜 Step 9: License
**ISC License**

Copyright (c) 2024

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

## ☁️ Step 10: Cloud Persistence & Offline Resilience
Jules Local Bridge is a **Cloud-Based CLI**. This means your coding tasks are processed on Google's servers, not just your local machine.

- **Uninterrupted Progress**: If your internet disconnects in the middle of a task, Jules **does not stop working**. He continues refactoring, building, or testing in the cloud.
- **Auto-Sync**: When your internet comes back, the CLI automatically reconnects to the active cloud session, syncs all the work done while you were away, and applies the patches to your local files.
- **Peace of Mind**: You never have to worry about losing progress due to a bad connection.

---

**Happy Coding with Jules!** 🌟🚀
