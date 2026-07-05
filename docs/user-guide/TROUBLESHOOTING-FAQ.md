# Troubleshooting FAQ

Answers to the problems streamers are most likely to hit, in plain
language.

---

### Windows says "Windows protected your PC" / SmartScreen warning

**Why this happens:** `SocialAutomation.exe` isn't yet signed with a paid
code-signing certificate. Windows shows this warning for any new app from
an unrecognized publisher — it doesn't mean the app is unsafe, just that
Windows hasn't built up trust in it yet.

**What to do:**
1. On the blue warning screen, click **"More info"**.
2. Click **"Run anyway"**.

You should only need to do this once per download. If you're not
comfortable doing this, ask whoever gave you the app to confirm it's the
official build before continuing.

---

### The app window never opens / nothing happens after double-clicking

1. Give it a few seconds — the very first launch can take a moment to start
   the server before your browser opens.
2. Look for a small status window — it may have opened behind your main
   window. Check your taskbar.
3. If a window did open and showed an error message, read what it says —
   it's written in plain language (e.g. "this copy looks incomplete,
   please re-download") and tells you what to do next.
4. If nothing opens at all, make sure you extracted the whole downloaded
   folder first rather than running the exe from inside the zip file
   directly — some zip tools won't let a program run properly from inside
   the archive.

---

### My browser didn't open automatically

Check the small status window — once the app is ready, it shows the web
address to open (usually something like `http://localhost:3000` or a
nearby port number). Copy that address into your browser's address bar.

---

### "Port already in use" / the app seems to start on a different port than I expected

This isn't actually an error. If something else on your computer is
already using the app's usual port, SocialAutomation automatically tries
the next one instead and opens your browser to the correct address either
way. You don't need to close anything or free up the port yourself — just
use whichever address the app's status window shows you.

If you're running two copies of SocialAutomation at once on the same
computer, each one will automatically get its own port.

---

### The setup wizard keeps reappearing every time I open the app

The wizard is only supposed to show automatically until you finish it once
(reach the final "You're all set" screen). If it keeps reopening:

- Make sure you actually reached the last step and saw "You're all set" —
  simply connecting one platform and closing the app early leaves setup
  marked "not finished," so it'll pick up where you left off next time
  (this is intentional — nothing is lost).
- If you've genuinely finished it before and it's still reopening every
  time, that's a bug worth reporting — it should only reopen on its own if
  you click **"Run setup again"** on the Accounts tab.

---

### I can't get rid of / close the wizard

Click through to the last step ("You're all set") — you don't have to
connect every platform, you can click **Skip / Next** through any you want
to add later. Once you reach that last step, the wizard won't reopen on
its own again. You can also switch to any other tab (Composer, Accounts,
etc.) at any time — the wizard doesn't block the rest of the app.

---

### "Test this connection" says it's failing

The message shown is already plain-language and specific to what went
wrong — read it first. Common causes and fixes:

- **Discord**: the webhook was deleted or the channel it points to was
  removed. Create a new webhook and reconnect.
- **Bluesky**: the app password was revoked or retyped incorrectly. Create
  a fresh app password in Bluesky's settings and reconnect.
- **Twitch / Reddit / Mastodon**: your access was revoked on the platform's
  side (e.g. you removed the app's authorization from your account
  settings there), or the app registration details changed. Reconnect
  through the wizard or Accounts tab — you may need to click **"Connect"**
  again to re-approve access.
- **Any platform**: a temporary outage on the platform's side. Wait a few
  minutes and test again.

Reconnecting one account never affects your other connected accounts.

---

### My post was rejected by a platform

A rejected post means SocialAutomation checked the post against that
platform's own rules before publishing and it didn't pass — nothing broken
was sent, and nothing partial went out. Check the **History** tab for the
exact reason, in plain language. Common ones:

- **Too long** — the platform has a character limit (for example, Twitch's
  title field is much shorter than a Discord message). Shorten your
  description, or let the app's automatic per-platform shortening handle
  it — if it still doesn't fit, trim your description further.
- **Link and text can't both be included** — some platforms (like Reddit
  self-posts) don't allow a separate link field alongside body text the way
  others do; the link needs to be woven into the text instead. Try
  submitting without a separate Link field, or check the platform's own
  posting rules.
- **Missing required info** — for example, no image where one is expected.
- **Rate limit** — you've posted too many times in a short window on that
  platform. Wait a bit and try again.

You can safely edit your description and resubmit — nothing was posted
partially to that platform.

---

### The AI model download seems stuck

- The model is a one-time download of about 1.9 GB, so on a slower
  connection it can take a while — check the percentage shown; if it's
  still increasing (even slowly), it's working.
- If it stops increasing entirely for several minutes, you likely lost your
  internet connection partway through. Nothing is lost — closing and
  reopening the app resumes the download from where it left off rather
  than starting over.
- If the download finishes but fails a final check, it's automatically
  deleted and retried rather than being used — SocialAutomation never uses
  a model file it can't verify is complete and correct. Just try the
  download again.
- You don't have to wait for it at all: click **decline** (or just keep
  using the app) and SocialAutomation uses its simpler built-in writer
  instead, which needs no download and always works. You can start the
  model download again later from Settings.

---

### Do I need an internet connection to write posts?

No. SocialAutomation's built-in writer works completely offline once the
app is running, with no account or API key required. The on-device AI
model (after it's downloaded once) also runs entirely on your computer —
neither writing option sends your post description to an outside AI
service.

You do still need internet to actually publish to each platform, and to do
the one-time model download if you choose to use it.

---

### Will updating the app lose my connected accounts, settings, or history?

No. Your accounts, settings, post history, and the downloaded AI model (if
any) are all stored outside the app's own folder, in a private data folder
on your computer. Updating the app replaces the app folder only — your data
folder is untouched. You'll see a banner in the app when a new version is
out, with a link and step-by-step instructions — see the "For streamers:
how to update" section of `docs/UPDATING.md` for the full walkthrough, and
the release notes for what changed in each version.

---

### I don't have Node.js / pnpm / any developer tools installed — will this work?

Yes. The distributable includes everything the app needs to run. You do
not need to install Node.js, pnpm, or anything else — just double-click
`SocialAutomation.exe`.

---

### Still stuck?

Check the exact wording of any message shown in the app or its status
window first — it's written to tell you what happened and what to do next.
If that doesn't resolve it, note down exactly what you clicked, what
message you saw, and what platform (if any) was involved, and report it
through your usual support channel.
