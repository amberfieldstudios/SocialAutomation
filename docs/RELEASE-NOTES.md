# SocialAutomation release notes

## 1.0

SocialAutomation is now a self-contained app a streamer can download and set
up themselves — no developer tools, no API keys required to start posting.

### What's new

**A guided setup wizard.** The first time you open the app, it walks you
through connecting Discord, Bluesky, Twitch, Reddit, and Mastodon, one at a
time, in plain language. Discord and Bluesky connect in under a minute
each; Twitch, Reddit, and Mastodon get step-by-step, copy-paste
instructions for the one-time app registration those platforms require.
Every account gets a one-click "Test this connection" button. The wizard
remembers where you left off if you close the app partway through, and
never reappears once you've finished it — you can always reopen it later
from the Accounts tab.

**AI-written posts with zero API keys.** SocialAutomation now writes
platform-tailored posts using an AI model that runs entirely on your own
computer. The first time it's needed, the app offers to download the model
(about 1.9 GB, one time, resumable if your connection drops, and verified
so a corrupted download is never used). If you decline, or the download
hasn't finished yet, SocialAutomation automatically falls back to a
built-in template writer — so writing posts always works, with no waiting,
no signup, and nothing sent to an outside AI service either way.

**A self-contained download.** `SocialAutomation.exe` bundles everything it
needs to run — you do not need to install Node.js, pnpm, or any other
developer tool first. First launch shows plain-language progress instead of
a wall of technical install output, and automatically works around a busy
port instead of crashing.

**Your data stays put.** Connected accounts, settings, post history, and
the downloaded AI model live in a private folder on your computer, separate
from the app files themselves, so future updates never touch or lose them.

### Known limitations in this release

- **The app is currently unsigned.** Windows SmartScreen will show an
  "unrecognized app" warning on first run; click "More info" → "Run
  anyway." See the Troubleshooting FAQ for details. A signed build is
  planned once a code-signing certificate is in place.
- The AI model download requires a working internet connection; the
  built-in template writer works fully offline and needs no download.
- Twitch's connector currently supports updating your channel info and
  reading viewer/follower analytics rather than posting a feed-style post
  (Twitch doesn't offer a general "post" API the way Discord/Bluesky/
  Mastodon/Reddit do) — connecting Twitch still lets SocialAutomation keep
  your channel info current from the same one-description composer.

### Documentation

- [Getting started guide](./user-guide/GETTING-STARTED.md) — download to
  first published campaign.
- [Connecting your platforms](./user-guide/CONNECTING-PLATFORMS.md) —
  step-by-step for each of the five platforms.
- [Troubleshooting FAQ](./user-guide/TROUBLESHOOTING-FAQ.md).
- [In-app help copy](./user-guide/IN-APP-HELP-COPY.md) — reference for
  wizard/dashboard tooltip text.
