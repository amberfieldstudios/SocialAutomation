/**
 * Plain-language wizard copy per platform, translated from `docs/AUTH.md`
 * (per-platform table + §10.5 "real app registration") for a non-technical
 * streamer. No raw jargon (OAuth/scope/client secret/redirect URI) appears
 * without a one-line explanation next to it.
 */

export type WizardPlatformId = 'discord' | 'bluesky' | 'twitch' | 'reddit' | 'mastodon';

export interface EasyPlatformCopy {
  kind: 'direct';
  id: WizardPlatformId;
  label: string;
  blurb: string;
}

export interface GuidedPlatformCopy {
  kind: 'guided';
  id: WizardPlatformId;
  label: string;
  blurb: string;
  /** Where the user goes to register a small "app" for this platform. */
  consoleUrl: string;
  consoleLabel: string;
  /** Ordered plain-language steps for the app-registration screen. */
  registrationSteps: string[];
  /** Whether this platform needs a per-instance server address (Mastodon). */
  needsInstanceUrl?: boolean;
  /** Whether the app secret field is required (vs. optional/public-client). */
  secretRequired: boolean;
}

export type PlatformCopy = EasyPlatformCopy | GuidedPlatformCopy;

export const PLATFORM_COPY: Record<WizardPlatformId, PlatformCopy> = {
  discord: {
    kind: 'direct',
    id: 'discord',
    label: 'Discord',
    blurb: 'Post announcements to a channel on your Discord server.',
  },
  bluesky: {
    kind: 'direct',
    id: 'bluesky',
    label: 'Bluesky',
    blurb: 'Post to your Bluesky account using your handle and a one-time app password.',
  },
  twitch: {
    kind: 'guided',
    id: 'twitch',
    label: 'Twitch',
    blurb:
      "Twitch requires you to register a free \"app\" before it will let SocialAutomation connect — this is a one-time, 2-minute setup Twitch requires of every tool, not something specific to us.",
    consoleUrl: 'https://dev.twitch.tv/console/apps',
    consoleLabel: 'Twitch Developer Console',
    secretRequired: false,
    registrationSteps: [
      'Open the Twitch Developer Console (button below) and log in with your normal Twitch account.',
      'Click "Register Your Application".',
      'Name — type anything you like, e.g. "My Stream Announcements".',
      'OAuth Redirect URLs — paste the address below into this box exactly as shown.',
      'Category — choose "Application Integration".',
      'Client Type — choose "Public".',
      'Click "Create", then open the application you just created.',
      'Copy the "Client ID" shown there and paste it below.',
    ],
  },
  reddit: {
    kind: 'guided',
    id: 'reddit',
    label: 'Reddit',
    blurb:
      "Reddit requires you to register a free \"app\" before it will let SocialAutomation connect — this is a one-time, 2-minute setup Reddit requires of every tool, not something specific to us.",
    consoleUrl: 'https://www.reddit.com/prefs/apps',
    consoleLabel: "Reddit's app settings page",
    secretRequired: true,
    registrationSteps: [
      "Open Reddit's app settings page (button below) and log in with your normal Reddit account.",
      'Click "create another app..." near the bottom of the page.',
      'Name — type anything you like, e.g. "My Stream Announcements".',
      'Type — choose "web app".',
      'redirect uri — paste the address below into this box exactly as shown.',
      'Click "create app".',
      'Copy the string just under the app\'s name (that\'s the app ID) and the "secret" value, and paste them below.',
    ],
  },
  mastodon: {
    kind: 'guided',
    id: 'mastodon',
    label: 'Mastodon',
    blurb:
      'Mastodon is spread across many independent servers ("instances"), so it needs to know which server your account lives on, plus a free one-time "app" registration on that server.',
    consoleUrl: '',
    consoleLabel: "your Mastodon server's application settings",
    secretRequired: true,
    needsInstanceUrl: true,
    registrationSteps: [
      'Type your Mastodon server address below, e.g. "mastodon.social" (the part after the @ in your handle).',
      'Open your server\'s application settings (button below appears once you enter a server) and log in.',
      'Click "New application".',
      'Name — type anything you like, e.g. "My Stream Announcements".',
      'Redirect URI — paste the address below into this box exactly as shown, replacing any text already there.',
      'Scopes — make sure "write" is checked (this is what lets us post on your behalf; we never request more than that).',
      'Click "Submit", then open the application you just created.',
      'Copy the "Client key" and "Client secret" shown there and paste them below.',
    ],
  },
};

/** A friendly explanation of "OAuth" shown once, the first time a guided flow appears. */
export const OAUTH_EXPLAINER =
  "Next you'll click Connect and a window from the platform itself will open. You sign in there, on their site — SocialAutomation never sees your password. When you approve, the platform sends you right back here, connected.";
