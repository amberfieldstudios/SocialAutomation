# Connecting your platforms

This guide covers exactly what you'll see in the Setup wizard (or the
Accounts tab) for each platform, in plain language. You only need to connect
the platforms you actually post to.

Two platforms — **Discord** and **Bluesky** — connect directly, in under a
minute, with no extra sign-up step. The other three — **Twitch**, **Reddit**,
and **Mastodon** — require you to register a small, free "app" with that
platform first. This is not something SocialAutomation asks of you
specially; every platform that uses this kind of sign-in requires any
outside tool to do this once. It sounds technical, but it's just a form with
a few fields, and the wizard tells you exactly what to type into each one.

Whatever you paste into any of these fields (passwords, tokens, app secrets)
is stored encrypted on your own computer. SocialAutomation never sees, and
never needs, your normal account password for any platform.

---

## Discord (easiest — under a minute)

Discord doesn't need any app registration. The fastest way to connect it is
a **webhook** — a private, one-way posting address for a single channel on
your server.

1. In Discord, open the channel you want your announcements posted to.
2. Click the gear icon (or right-click the channel) → **Edit Channel**.
3. Go to **Integrations → Webhooks → New Webhook**.
4. Click **Copy Webhook URL**.
5. Back in SocialAutomation's wizard, paste that URL into the **Webhook URL**
   field and click **Connect Discord**.

Optionally, give the connection a friendly name (like "#announcements") so
you can tell it apart from other channels later.

**Advanced option:** if you already run a Discord bot and would rather use
its bot token instead of a webhook, choose "Bot token (advanced)" and paste
the token there instead. Most streamers should just use the webhook option.

Once connected, click **Test this connection** any time to confirm it's
still working.

---

## Bluesky (easiest — under a minute)

Bluesky lets you create a special password just for apps like
SocialAutomation, so you never have to hand over your real account password.

1. In the Bluesky app or website, go to **Settings → App Passwords → Add
   App Password**.
2. Give it any name you like (e.g. "SocialAutomation").
3. Bluesky shows you the password once — copy it right away, you won't be
   able to see it again later.
4. Back in the wizard, enter your **Bluesky handle** (e.g.
   `you.bsky.social`) and paste the **app password**, then click **Connect
   Bluesky**.

This is not your normal Bluesky login password — it's the one-time app
password from that Settings page.

---

## Twitch (guided, a couple of minutes)

Twitch requires a one-time, free "app registration" before it lets any
outside tool connect to your account — this step happens on Twitch's own
website, not inside SocialAutomation.

1. In the wizard, click the link to open the **Twitch Developer Console**
   and log in with your normal Twitch account.
2. Click **Register Your Application**.
3. **Name** — type anything you like, e.g. "My Stream Announcements".
4. **OAuth Redirect URLs** — the wizard shows you an address with a **Copy**
   button next to it. Copy it and paste it into this box on Twitch's page,
   exactly as shown.
5. **Category** — choose "Application Integration".
6. **Client Type** — choose "Public".
7. Click **Create**, then open the application you just created.
8. Copy the **Client ID** shown there and paste it into the wizard's
   **App ID (Client ID)** field.
9. Click **Save app details** in the wizard.
10. Click **Connect Twitch**. A sign-in window opens on Twitch's own site —
    you approve access there, on Twitch, never inside SocialAutomation.
    When you approve, you're sent right back and the wizard shows
    "Connected."

Twitch doesn't require an app secret for this kind of connection, so you
won't see a secret field for Twitch.

---

## Reddit (guided, a couple of minutes)

Reddit also requires a one-time, free app registration on Reddit's own
site.

1. In the wizard, click the link to open **Reddit's app settings page** and
   log in with your normal Reddit account.
2. Click **create another app...** near the bottom of the page.
3. **Name** — type anything you like, e.g. "My Stream Announcements".
4. **Type** — choose "web app".
5. **redirect uri** — paste the address the wizard gives you (use its
   **Copy** button) into this box exactly as shown.
6. Click **create app**.
7. Reddit shows you a short string just under the app's name — that's your
   app ID — and a **secret** value. Copy both.
8. Back in the wizard, paste the app ID into **App ID (Client ID)** and the
   secret into **App secret (Client Secret)**, then click **Save app
   details**.
9. Click **Connect Reddit**. A sign-in window opens on Reddit's own site;
   approve access there, then you'll be sent back automatically.

Your Reddit app secret is stored encrypted and is never shown again once
you save it.

---

## Mastodon (guided, a couple of minutes)

Mastodon works a little differently: instead of one central website,
Mastodon accounts live on many independent "servers" (also called
instances). SocialAutomation needs to know which server your account is on
before it can register an app there.

1. In the wizard, type your **Mastodon server address** — this is the part
   of your handle after the `@`. For example, if your handle is
   `@you@mastodon.social`, type `mastodon.social`.
2. A link to **your server's application settings** appears — click it and
   log in with your normal Mastodon account on that server.
3. Click **New application**.
4. **Name** — type anything you like, e.g. "My Stream Announcements".
5. **Redirect URI** — replace whatever's already in this box with the
   address the wizard gives you (use its **Copy** button).
6. **Scopes** — make sure **write** is checked. This is what lets
   SocialAutomation post on your behalf; it never asks for more access than
   that.
7. Click **Submit**, then open the application you just created.
8. Copy the **Client key** and **Client secret** shown there.
9. Back in the wizard, paste them into **App ID (Client ID)** and
   **App secret (Client Secret)**, then click **Save app details**.
10. Click **Connect Mastodon**. A sign-in window opens on your Mastodon
    server; approve access there, then you'll be sent back automatically.

---

## What "the sign-in window" actually does

For Twitch, Reddit, and Mastodon, after you save the app details and click
**Connect**, a new browser window or tab opens on the platform's own
website (not SocialAutomation's). You sign in and approve access there —
your password is only ever typed into the real platform's own page. Once
you approve, the platform sends you straight back, and the wizard
automatically shows "Connected" within a couple of seconds — you don't need
to do anything else or copy anything back yourself.

## Testing and reconnecting

Every connected account has a **Test this connection** button (in the
wizard and on the Accounts tab). It always gives you a plain-language
answer — "This connection is working" or a short explanation of what's
wrong — never a technical error message.

You can reconnect or add more platforms at any time from the **Accounts**
tab, including a **"Run setup again"** button that reopens the full wizard
from the start.
