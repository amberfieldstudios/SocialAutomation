/**
 * Thin fetch wrapper for @social/api. The UI never talks to
 * @social/pipeline/@social/db/plugin connectors directly — every read/write
 * goes through this HTTP client, matching the architecture's "UI depends only
 * on api" direction (docs/ARCHITECTURE.md's dependency diagram).
 */

export interface AccountSummary {
  id: string;
  platformId: string;
  remoteId: string;
  handle?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  profileUrl?: string | null;
  status: 'active' | 'disconnected' | 'error' | 'revoked';
  connectedAt?: string | null;
  scopes?: string[];
  tokenExpiresAt?: string | null;
}

export interface ValidationIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  field?: string;
  limit?: number;
  actual?: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface PostPayload {
  platform: string;
  accountId: string;
  text?: string;
  title?: string;
  link?: string;
  tags?: string[];
  mentions?: string[];
  [key: string]: unknown;
}

export interface PlatformPreviewResult {
  platform: string;
  accountId: string;
  status: 'ok' | 'rejected' | 'error';
  payload?: PostPayload;
  textLength?: number;
  characterLimit?: number;
  validation?: ValidationResult;
  error?: string;
}

export interface PlatformCapabilities {
  platform: string;
  displayName: string;
  characterLimit: number;
  maxMediaCount: number;
  supportsScheduling: boolean;
  supportsAnalytics: boolean;
  [key: string]: unknown;
}

export interface PlatformInfo {
  id: string;
  capabilities: PlatformCapabilities;
}

export interface PlatformCampaignResult {
  platform: string;
  accountId: string;
  status: 'enqueued' | 'rejected' | 'error';
  textLength?: number;
  validation?: ValidationResult;
  postVariantId?: string;
  jobId?: string;
  error?: string;
}

export interface PublishJobRecord {
  id: string;
  postVariantId: string;
  operation: string;
  status: 'pending' | 'claimed' | 'running' | 'succeeded' | 'failed' | 'dead';
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeadLetterJobRecord {
  id: string;
  publishJobId: string;
  operation: string;
  attempts: number;
  errorMessage?: string | null;
  failedAt: string;
}

export interface ScheduleRecord {
  id: string;
  mode: 'immediate' | 'scheduled' | 'recurring';
  runAt: string | null;
  timezone: string;
  recurrenceRule: string | null;
  nextRunAt: string | null;
  status: string;
}

export interface HistoryEntry {
  variantId: string;
  campaignId: string | null;
  platformId: string;
  accountId: string;
  accountHandle: string | null;
  text: string | null;
  status: string;
  remoteUrl: string | null;
  publishedAt: string | null;
  createdAt: string;
}

export interface CampaignSummary {
  id: string;
  name: string;
  status: string;
  createdAt: string;
}

export interface CampaignAnalyticsSummary {
  campaignId: string;
  snapshotCount: number;
  postVariantCount: number;
  platforms: string[];
  totals: Record<string, number>;
  ctr?: number;
  generatedAt: string;
}

export interface ComposeInput {
  description: string;
  title?: string;
  link?: string;
  tags?: string[];
  mentions?: string[];
  campaign?: string;
  cta?: string;
  /**
   * `platformOptions` carries per-target platform-specific fields the
   * generic composer doesn't know about — e.g. Reddit's required
   * `subreddit` (docs/PLATFORM-RULES.md; `plugins/reddit/src/connector.ts`'s
   * `validatePost` rejects a Reddit post with none). Threaded verbatim
   * through `/api/compose-preview` and `/api/campaigns` into
   * `CampaignService.composeAndSubmit`, which merges it onto the generated
   * payload before `validatePost`/`publish` (t14).
   */
  platforms: { platformId: string; accountId: string; platformOptions?: Record<string, unknown> }[];
}

export interface AppCredentialsStatus {
  platformId: string;
  configured: boolean;
}

export type BeginPairingResponse =
  | { kind: 'authorize_url'; state: string; authorizeUrl: string; scopes: string[] }
  | {
      kind: 'device_code';
      state: string;
      scopes: string[];
      deviceAuthorization: {
        userCode: string;
        verificationUri: string;
        verificationUriComplete?: string;
        expiresInSec: number;
        intervalSec: number;
      };
    };

export type PairingPollResponse =
  | { status: 'pending' }
  | { status: 'succeeded'; account: AccountSummary }
  | { status: 'failed'; message: string };

export interface TestConnectionResult {
  ok: boolean;
  message: string;
}

export interface WizardState {
  completed: boolean;
  currentStepId: string;
  updatedAt: string;
}

// --- Update story (t7) ----------------------------------------------------
export interface UpdateStatus {
  /** False when the app owner hasn't set SOCIAL_AUTOMATION_UPDATE_REPO yet — not an error, just "no update source configured". */
  configured: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseName?: string;
  releaseUrl?: string;
  updateAvailable: boolean;
  /** Plain-language message on a failed check (e.g. offline) — never a stack trace. */
  error?: string;
  /** True if the user already dismissed the banner for this specific latestVersion. */
  dismissed: boolean;
}

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // ignore body parse failure
    }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  health: () => request<{ ok: boolean }>('/api/health'),

  listPlatforms: () => request<{ platforms: PlatformInfo[] }>('/api/platforms'),

  listAccounts: (filter?: { platformId?: string; status?: string }) => {
    const qs = new URLSearchParams(filter as Record<string, string>).toString();
    return request<{ accounts: AccountSummary[] }>(`/api/accounts${qs ? `?${qs}` : ''}`);
  },
  addAccount: (input: {
    platformId: string;
    remoteId: string;
    handle?: string;
    displayName?: string;
    avatarUrl?: string;
    profileUrl?: string;
  }) => request<{ account: AccountSummary }>('/api/accounts', { method: 'POST', body: JSON.stringify(input) }),
  reconnectAccount: (id: string) =>
    request<{ account: AccountSummary }>(`/api/accounts/${id}/reconnect`, { method: 'POST' }),
  removeAccount: (id: string) => request<void>(`/api/accounts/${id}`, { method: 'DELETE' }),
  testAccount: (id: string) => request<TestConnectionResult>(`/api/accounts/${id}/test`, { method: 'POST' }),

  // --- Setup wizard (t1) -------------------------------------------------
  getAppCredentialsStatus: (platformId: string) =>
    request<AppCredentialsStatus>(`/api/app-credentials/${encodeURIComponent(platformId)}`),
  saveAppCredentials: (input: { platformId: string; clientId: string; clientSecret?: string; redirectUri?: string; instanceUrl?: string }) =>
    request<void>('/api/app-credentials', { method: 'POST', body: JSON.stringify(input) }),
  beginPairing: (input: { platformId: string; operations?: string[] }) =>
    request<BeginPairingResponse>('/api/accounts/pair/begin', { method: 'POST', body: JSON.stringify(input) }),
  pollPairing: (state: string) => request<PairingPollResponse>(`/api/accounts/pair/poll/${encodeURIComponent(state)}`),
  pairWithPassword: (input: { platformId: string; identifier: string; password: string; operations?: string[] }) =>
    request<{ account: AccountSummary }>('/api/accounts/pair/password', { method: 'POST', body: JSON.stringify(input) }),
  pairWithToken: (input: { platformId: string; token: string; tokenType: string; remoteId?: string; handle?: string; displayName?: string }) =>
    request<{ account: AccountSummary }>('/api/accounts/pair/token', { method: 'POST', body: JSON.stringify(input) }),

  // --- Setup wizard: first-run detection + resume (t2) -------------------
  getWizardState: () => request<WizardState>('/api/wizard-state'),
  saveWizardState: (patch: { currentStepId?: string; completed?: boolean }) =>
    request<WizardState>('/api/wizard-state', { method: 'PUT', body: JSON.stringify(patch) }),
  restartWizard: () => request<WizardState>('/api/wizard-state/restart', { method: 'POST' }),

  composePreview: (input: ComposeInput) =>
    request<{ results: PlatformPreviewResult[] }>('/api/compose-preview', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  submitCampaign: (input: ComposeInput) =>
    request<{ results: PlatformCampaignResult[] }>('/api/campaigns', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  listJobs: (status?: string) =>
    request<{ jobs: PublishJobRecord[] }>(`/api/jobs${status ? `?status=${status}` : ''}`),
  listDeadLetters: () => request<{ jobs: DeadLetterJobRecord[] }>('/api/jobs/dead-letters'),

  listSchedules: () => request<{ schedules: ScheduleRecord[] }>('/api/schedules'),
  createSchedule: (input: ComposeInput & { mode: 'immediate' | 'once' | 'recurring'; localDateTime?: string; startLocalDateTime?: string; timezone?: string; recurrenceRule?: string }) =>
    request<{ schedule: ScheduleRecord }>('/api/schedules', { method: 'POST', body: JSON.stringify(input) }),
  materializeDueSchedules: () => request<{ outcomes: unknown[] }>('/api/schedules/materialize-due', { method: 'POST' }),

  listHistory: (filter?: { campaignId?: string; platformId?: string; status?: string }) => {
    const qs = new URLSearchParams(filter as Record<string, string>).toString();
    return request<{ entries: HistoryEntry[] }>(`/api/history${qs ? `?${qs}` : ''}`);
  },
  listCampaigns: () => request<{ campaigns: CampaignSummary[] }>('/api/campaigns-list'),

  campaignAnalytics: (campaignId: string) =>
    request<{ summary: CampaignAnalyticsSummary }>(`/api/analytics/${encodeURIComponent(campaignId)}`),

  // --- Update story (t7) --------------------------------------------------
  getUpdateStatus: () => request<UpdateStatus>('/api/update/status'),
  dismissUpdate: (version: string) =>
    request<{ ok: boolean }>('/api/update/dismiss', { method: 'POST', body: JSON.stringify({ version }) }),
};

export { ApiError };
