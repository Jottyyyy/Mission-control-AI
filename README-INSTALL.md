# Mission Control — Mac Mini install

Testing build only. Unsigned, no auto-update, no notarization.

You should have downloaded a folder called **`MissionControl-AdamBuild`** from
OneDrive containing three items:

```
MissionControl-AdamBuild/
├── MissionControl.app.zip    (~96 MB)
├── mac-setup.sh
└── README-INSTALL.md         ← this file
```

The `.zip` is on purpose — OneDrive corrupts .app bundles in-transit. The
setup script unzips it safely on your Mac.

---

## 1. Run the setup script

The setup script does all the heavy lifting: unzips the app, removes the
macOS quarantine flag, installs Python 3.12, and installs the backend
dependencies.

1. Open **Terminal** (press ⌘+Space, type "Terminal", press Return).
2. In Terminal, type these 3 characters (note the trailing space): `cd `
3. Open Finder, go to **Downloads**, and **drag the
   `MissionControl-AdamBuild` folder** directly into the Terminal window.
   The full path auto-fills. Press **Return**.
4. Now type and press Return:
   ```
   bash mac-setup.sh
   ```

The script will:
- Unzip `MissionControl.app.zip` → `Mission Control.app`
- Strip the macOS quarantine flag
- Install Homebrew (if missing — it will ask for your Mac password;
  type it blind, the cursor won't move)
- Install Python 3.12
- Install the backend Python packages (uvicorn, fastapi, pydantic,
  keyring, anthropic)
- Install **OpenClaw** (the AI engine that powers chat — Homebrew cask)

First run takes 5–10 minutes. Wait for:

> ===========================================================
>   Done. You can now launch Mission Control.
> ===========================================================

---

## 2. One-time OpenClaw setup

Mission Control's chat is powered by OpenClaw. After `mac-setup.sh` finishes,
you need to run OpenClaw's interactive setup once. In the same Terminal:

```
openclaw setup
```

Follow the prompts (sign in / configure credentials). Takes 1-2 minutes.

If chat still shows "Something went wrong" after this, open **OpenClaw.app**
from Applications once, complete its first-run flow, then try chat again.

---

## 3. Install and launch the app

1. Drag **`Mission Control.app`** from the folder into your
   **Applications** folder.
2. Double-click it from Applications.

Because the script already stripped the quarantine flag, you should NOT
see a Gatekeeper "unidentified developer" warning. If you do:

- Right-click `Mission Control.app` → **Open** → **Open** in the dialog,
  OR
- Apple menu → **System Settings → Privacy & Security** → scroll to the
  bottom → click **Open Anyway**.

---

## 4. Connect Google Workspace

When the window opens:

1. Click **Settings → Connections** in the sidebar.
2. Connect Google Workspace (Gmail, Calendar, Drive, Contacts).
3. Follow the OAuth flow in your browser.

---

## Troubleshooting

- **"No such file or directory" when running `mac-setup.sh`** — use the
  drag-the-folder trick from step 1, don't type the path.
- **"Permission denied"** — run with bash instead of `./`:
  ```
  bash mac-setup.sh
  ```
- **App still blocked on launch** — run this once in Terminal, then
  double-click again:
  ```
  xattr -dr com.apple.quarantine /Applications/Mission\ Control.app
  ```
- **"Backend failed to start"** — check the log:
  ```
  open ~/Library/Logs/Mission\ Control/backend.log
  ```
- **Window opens but chat fails** — make sure no other process is
  holding port 8001:
  ```
  lsof -iTCP:8001 -sTCP:LISTEN
  ```
