# Getting started with SocialAutomation

This guide walks you from downloading the app to publishing your very first
post across all your platforms. No coding, no technical background needed.
If you can install a game, you can do this.

Total time: about 5–15 minutes, depending on how many platforms you connect.

## 1. Download and install

1. Download the `SocialAutomation` zip from the release you were given (see
   the project's release page).
2. Extract the zip anywhere you like — your Desktop or Documents folder both
   work fine. Keep the whole folder together; don't pull files out of it.
3. Open the extracted folder and double-click `SocialAutomation.exe`.

You do **not** need to install Node.js, pnpm, or any other developer tool
first. Everything the app needs to run is already inside that folder.

**A note about the security warning.** Because this app isn't (yet) digitally
signed by a big publisher, Windows may show a blue "Windows protected your
PC" screen the first time you run it. This is normal for a new,
independently-built app — it does not mean the app is unsafe. Click **"More
info"**, then **"Run anyway"**. See the Troubleshooting FAQ below for a
screenshot-style description of what to expect.

## 2. First launch

A small window appears showing plain-language status while the app starts
up — you will not see a black console full of technical text. Once it says
it's ready, your browser opens automatically to the SocialAutomation
dashboard.

If your browser doesn't open by itself, the status window tells you the
web address to open by hand (usually something like `http://localhost:3000`).

Behind the scenes, the app quietly:

- Picks a free port on your computer to run on (if its usual port is busy,
  it automatically tries the next one — you don't have to do anything).
- Creates a private folder for your data at
  `%LOCALAPPDATA%\SocialAutomation` (on your own PC, this is roughly
  `C:\Users\<you>\AppData\Local\SocialAutomation`). This is where your
  connected accounts, settings, post history, and (later) the AI model are
  stored — kept separate from the app folder itself, so future updates never
  touch or delete them.

## 3. The setup wizard

The first time you open the dashboard, it opens straight into the **Setup
wizard**. This walks you through connecting the platforms you post to, one
at a time: Discord, Bluesky, Twitch, Reddit, and Mastodon.

You only need to connect **one** platform to get started — you can always
come back and add the rest later, either by reopening this wizard (there's a
"Run setup again" button on the Accounts tab) or from the Accounts tab
directly.

- **Discord and Bluesky** are the fastest — under a minute each. Neither one
  needs you to leave the app or sign in through a pop-up window.
- **Twitch, Reddit, and Mastodon** take a couple of extra minutes, because
  those platforms each require a one-time, free "app registration" step
  before they'll let any outside tool (including this one) connect. The
  wizard walks you through exactly what to click, with copy-paste fields —
  see the per-platform guides below for the full details.

If you skip a platform for now, just click **Skip / Next** — you can connect
it later.

Every account you connect gets a **"Test this connection"** button. Click it
any time to confirm the connection still works; it always shows you a plain
sentence (never technical error text).

When you reach the end of the wizard, it tells you how many platforms you
connected and sends you to the **Composer** tab to write your first post.
If you didn't connect anything yet, that's fine too — you can connect a
platform right from that final screen.

The wizard remembers where you left off. If you close the app partway
through and come back later, it picks up on the exact step you were on —
you never have to start over.

## 4. Generate your first posts

Head to the **Composer** tab (or you'll already be there if you just
finished the wizard). This is where you write one description and
SocialAutomation turns it into a properly-formatted post for every platform
you connected.

1. **Content description** — write what you want to say, in your own words.
   For example: *"Going live tonight at 8pm ET playing the new Elden Ring
   DLC, come hang out!"* This one description is the source for every
   platform's version of the post — you only write it once.
2. **Call to action** (optional) — a short line like "Come say hi!" that
   some platforms will fold into the post.
3. **Link** (optional) — your stream link, a clip, or anything else you want
   included.
4. Tick the platforms/accounts you want this post to go to.

As you type, SocialAutomation automatically generates a preview for each
platform you selected — shortened for Twitch's title limit, hashtags added
for Bluesky and Mastodon, formatted properly for Discord and Reddit, and so
on. Nothing is posted yet; these are previews only.

**Where do these posts come from?** An AI model running entirely on your own
computer writes them — there are no API keys to buy, no accounts to sign up
for, and nothing about your description is sent to any outside AI service.
The very first time the app needs this model, it offers to download it
(a one-time download, a couple of gigabytes — see the FAQ for details). If
you decline the download, or it hasn't finished yet, SocialAutomation
automatically uses a simpler built-in template writer instead, so post
generation always works — it never leaves you stuck waiting on a download.

## 5. Publish your first campaign

Once you're happy with the previews, click **Submit**. SocialAutomation
sends your post to every platform/account you selected, respecting each
platform's own rules (character limits, hashtag rules, link rules, and so
on) automatically. You'll see a short summary — how many posts went out
successfully, and whether any were rejected or hit an error, in plain
language.

You can check on things afterwards:

- **Queue & Schedule** — see what's scheduled or in progress.
- **History** — see what's already gone out.
- **Analytics** — see how your posts performed once platforms report
  numbers back.

That's it — you've gone from download to your first published campaign.

## What's next

- Connect the rest of your platforms any time from **Accounts → Run setup
  again**, or by clicking a platform's "Connect" button directly on the
  Accounts tab.
- See [`CONNECTING-PLATFORMS.md`](./CONNECTING-PLATFORMS.md) for a detailed,
  per-platform walkthrough of every connection step.
- Run into a problem? Check [`TROUBLESHOOTING-FAQ.md`](./TROUBLESHOOTING-FAQ.md)
  first.
