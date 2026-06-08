# 🌉 Jules Local Bridge

**Jules Local Bridge** is a powerful CLI tool that bridges your local file system with the **Google Jules AI API**. It enables a seamless local development experience by managing a private shadow repository and automatically patching your local files with AI-generated changes.

---

## ✨ Key Features

- **📂 Workspace Isolation**: Strictly manages project files within `/storage/emulated/0/Jules-Workspace` to prevent accidental system changes.
- **🚀 Auto-Initialization**: Automatically detects new projects, initializes Git, and creates linked private shadow repositories on GitHub.
- **⚡ Fast Mode**: Optimized execution that auto-approves plan steps for high-speed coding.
- **💬 Real-Time Interactive Shell**: A dedicated `jules > ` prompt featuring:
  - **Live Status Sync**: Real-time progress updates (`Status: Working • ...`).
  - **Interrupt Handling**: Detects and displays Jules Web prompts (questions/interrupts) directly in the CLI for your input.
  - **Autocomplete**: Character-by-character command and project recommendations.
- **🩹 Smart Patching**: Automatically applies incremental code changes locally, creating `.bak` backups for safety.
- **☁️ Cloud Persistence**: Since Jules operates in the cloud, your tasks continue running even if your internet disconnects. You can reconnect anytime to sync the progress.
- **📊 Usage Analytics**: Track your daily and all-time session statistics directly from the CLI.

---

## 🚀 Quick Start (Setup Guide)

Follow these steps to get Jules Local Bridge up and running:

> [!IMPORTANT]
> **Android / Termux Users:**
> Android's shared storage (`/storage/emulated/0`) does not support symbolic links or execution permissions. To install dependencies and compile the CLI, you **must** copy the project directory to Termux's internal storage (e.g. `/data/data/com.termux/files/home/.gemini/antigravity-cli/scratch/Jules-CLI`):
> ```bash
> cp -R "/storage/emulated/0/Jules-CLI-Jules-CLI" "/data/data/com.termux/files/home/.gemini/antigravity-cli/scratch/Jules-CLI"
> cd "/data/data/com.termux/files/home/.gemini/antigravity-cli/scratch/Jules-CLI"
> npm install --no-audit --no-fund --prefer-offline
> npm run build
> ```

### **1. Requirements & API Keys**
Ensure you are in the active project directory:
```bash
# On Termux:
cd "/data/data/com.termux/files/home/.gemini/antigravity-cli/scratch/Jules-CLI"

# On PC / other platforms:
cd "/storage/emulated/0/Jules-CLI-Jules-CLI"
```

#### **Configure Environment**
Create a `.env` file with these keys:
```env
JULES_API_KEY=your_key_here
GITHUB_TOKEN=your_token_here
```

#### **Generate JULES_API_KEY**
- Visit the **[Jules Settings Page](https://jules.google.com/settings#api)**.
- Click **"Create API key"** (Max 3 keys allowed).

#### **Generate GITHUB_TOKEN**
- Go to GitHub -> **Settings** -> **Developer settings** -> **Personal access tokens** -> **Tokens (classic)**.
- Generate a new token with the **`repo`** scope (Full control of private repositories).

---

### **2. Add a Project to Workspace**
Jules operates inside a dedicated workspace: `/storage/emulated/0/Jules-Workspace`.
1. Copy your project folder to: `/storage/emulated/0/Jules-Workspace/my-project`.
2. Navigate to it: `cd "/storage/emulated/0/Jules-Workspace/my-project"`.

---

### **3. Launch Jules**
Run the CLI from your project directory:
```bash
# On Termux:
node /data/data/com.termux/files/home/.gemini/antigravity-cli/scratch/Jules-CLI/dist/index.js

# On PC / other platforms:
node ../Jules-CLI-Jules-CLI/dist/index.js
```

---

### **4. Edit with AI**
Type directly in the shell to start a session:
```
jules > create a modern login page with vanilla CSS
```

---

## 🛠 Commands

- `/edit [instruction]` : Ask Jules AI to edit your code.
- `/session track [ID]` : Sync and monitor an existing session from Jules Web.
- `/usage` : View today's session counts and stats.
- `/repo` : Interactive project/repository switcher.
- `/sync` : Manually push local changes to the cloud.
- `/restore` : Recover files from automatic `.bak` backups.
- `/plan` / `/fast` : Switch between manual and automatic plan approval.
- `/docs` / `/shot` : Show full documentation or keyboard shortcuts.
- `/help` : Show commands menu and support info.
- `/exit` : Quit the interactive shell.

---

## 📦 Installation & Development

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run in development mode
npm run dev
```

---

## 💬 Project Info & Support

- **Open Source**: Jules CLI is an Open Source project.
- **GitHub Repository**: [https://github.com/v54087912-collab/Jules-CLI.git](https://github.com/v54087912-collab/Jules-CLI.git)
- **Contact Developer**: [https://t.me/R3V_X](https://t.me/R3V_X)
- **Community Link**: [https://t.me/allinformation0173](https://t.me/allinformation0173)
- **Instagram**: [https://www.instagram.com/opeditzxx/](https://www.instagram.com/opeditzxx/)

---

## 📜 License

**ISC License**

Copyright (c) 2024

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
