# In-app help & tooltip copy

Short, plain-language strings the UI can embed directly next to the
relevant control — as tooltips, hint text under a field, or a small "?"
popover. Grouped by where they'd appear. Wording here matches the tone
already used in `packages/ui/src/wizard/` and the composer/accounts views;
treat this as a copy bank the wizard/dashboard code can pull from, not a
new component.

Existing hint text already shipped in the code (e.g. the "kept encrypted
and never shown again" lines in `DiscordStep.tsx`/`BlueskyStep.tsx`/
`RedirectConnectStep.tsx`, and the OAuth explainer in `wizardCopy.ts`) is
not repeated here — this list is additional copy for spots that don't yet
have a tooltip, plus a few reusable phrasings.

## Setup wizard — general

- **Wizard step tabs**: "Each tab is one platform. A checkmark means you're
  already connected there."
- **Skip / Next button**: "You can always connect this platform later from
  the Accounts tab."
- **Run setup again (Accounts tab)**: "Reopens the setup wizard from the
  start. Your already-connected accounts stay connected — this just lets
  you add more or review them."

## Discord step

- **Webhook vs. bot token choice**: "Not sure which one? Choose Webhook URL
  — it's faster and works for almost everyone."
- **Webhook URL field**: "Looks like `https://discord.com/api/webhooks/...`.
  Get it from your channel's Integrations settings."
- **Connection name field**: "Just a label so you can tell channels apart —
  doesn't affect posting."

## Bluesky step

- **App password field**: "Not your Bluesky login password. Create a
  separate one at Settings → App Passwords — takes 10 seconds."
- **Handle field**: "Your full Bluesky handle, including the domain — e.g.
  `you.bsky.social`."

## Twitch / Reddit / Mastodon (guided) steps

- **"Why do I need to register an app?"**: "This is a one-time step every
  outside tool has to do on this platform — it's how the platform confirms
  a real tool (not a stranger) is asking to connect, and it lets you revoke
  access any time from your own account settings."
- **Redirect URI / address field**: "Copy this exactly into the platform's
  form — don't retype it by hand, small typos will make the connection
  fail."
- **App ID / Client ID field**: "This isn't secret — it just identifies
  SocialAutomation to the platform."
- **App secret / Client Secret field**: "Keep this one private. It's stored
  encrypted here and never shown again after you save it."
- **Mastodon server address field**: "The part of your handle after the @.
  If your handle is `@you@mastodon.social`, type `mastodon.social`."
- **"Connect" button (after saving app details)**: "A window will open on
  the platform's own site. Sign in there — you'll be sent right back here
  automatically once you approve."
- **Waiting-for-approval status**: "Still waiting for you to approve access
  in the window that opened. Nothing happens here until you do."

## Test this connection button

- **Idle state tooltip**: "Checks that this account is still connected and
  able to post — doesn't publish anything."
- **Success message pattern**: "This connection is working."
- **Failure message pattern**: "This connection isn't working right now:
  <plain-language reason>. Try reconnecting from the Accounts tab."

## Composer

- **Content description field**: "Write what you want to say once — a
  version tailored to each platform's rules is generated automatically
  below."
- **Call to action field**: "Optional. A short line like 'Come say hi!' —
  some platforms will fold this into the post, others may leave it out if
  space is tight."
- **Link field**: "Optional. Your stream link, clip, or anything else you
  want included. Some platforms place it differently (e.g. Reddit puts it
  in the post body instead of as a separate field)."
- **Platform/account checklist**: "Pick everywhere you want this post to
  go. You can select more than one account per platform."
- **Live preview panel**: "This is a preview only — nothing is posted until
  you click Submit."
- **Preview generation note**: "Posts are written by an AI model running on
  your own computer. No API key, no cloud service, nothing about your post
  leaves this machine during writing."
- **Submit button**: "Publishes to every platform/account you selected
  above, right now."
- **Submit result summary**: "<N> enqueued, <N> rejected, <N> errored — click
  History for details on any that didn't go through."

## On-device model / download prompt

- **First-time download offer**: "SocialAutomation can write better,
  longer posts using a small AI model that runs on your own computer. It's
  about 2 GB and downloads once — you can also skip this and use the
  simpler built-in writer instead, which always works and needs no
  download."
- **Download progress**: "Downloading the writing model — <percent>%. You
  can keep using SocialAutomation while this finishes; posts will use the
  simpler built-in writer until it's done."
- **Download paused/resumed**: "Picking up your model download where it
  left off — nothing is lost."
- **Decline confirmation**: "No problem — SocialAutomation will keep using
  its built-in writer. You can turn the download back on any time from
  Settings."
- **Download failed**: "The download didn't finish correctly, so nothing
  was installed. Your posts are unaffected — the built-in writer is still
  being used. Try downloading again when you're ready."

## Accounts tab

- **Connected account row**: "Connected as <name>. Use Test this connection
  to confirm it's still working."
- **Disconnected/broken account row**: "This account needs reconnecting.
  Click Connect to go through it again — your other accounts aren't
  affected."

## Queue, History, Analytics (brief orientation tooltips)

- **Queue & Schedule tab**: "Everything that's scheduled or waiting to go
  out."
- **History tab**: "Everything that's already been published, and anything
  that was rejected or errored, with the reason."
- **Analytics tab**: "Performance numbers reported back by each platform
  once they're available — this can take a little time after publishing."
