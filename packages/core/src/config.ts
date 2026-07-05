/**
 * Typed, validated application configuration.
 *
 * Sources, lowest to highest precedence:
 *   1. Built-in defaults (dev-friendly: SQLite, `plugins/*`, info-level logs).
 *   2. An optional JSON config file (`SOCIAL_CONFIG_FILE` env var, or an
 *      explicit `filePath`).
 *   3. Environment variables (`SOCIAL_*`, plus `NODE_ENV`).
 *
 * The merged object is validated with zod so every consumer gets a typed,
 * guaranteed-shaped `AppConfig` — never a loosely-typed `process.env` grab.
 *
 * SECURITY: this module never reads or stores platform app secrets
 * (client secrets/tokens live in the auth layer's vault, not here). As a
 * defense-in-depth measure, `redactedConfigSummary()` still scrubs any
 * secret-shaped key before a caller logs a config snapshot.
 */

import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

const DEFAULT_SQLITE_URL = './data/dev.sqlite';

const AppConfigSchema = z.object({
  nodeEnv: z.enum(NODE_ENVS).default('development'),
  workspaceRoot: z.string().min(1).default(() => process.cwd()),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  plugins: z
    .object({
      globs: z.array(z.string().min(1)).default(['plugins/*']),
    })
    .default({}),
  database: z
    .object({
      driver: z.enum(['sqlite', 'postgres']).default('sqlite'),
      url: z.string().min(1).default(DEFAULT_SQLITE_URL),
    })
    .default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export interface LoadConfigOptions {
  /** Defaults to `process.env`. Inject a fake object in tests. */
  env?: NodeJS.ProcessEnv;
  /** Explicit config file path; falls back to `env.SOCIAL_CONFIG_FILE`. */
  filePath?: string;
  /** Used as the default `workspaceRoot` when nothing else supplies one. */
  workspaceRoot?: string;
}

/** Thrown when the merged configuration fails schema validation. */
export class ConfigError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[]) {
    super(`${message} ${issues.join('; ')}`.trim());
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

type PlainRecord = Record<string, unknown>;

function readFileConfig(filePath: string | undefined): PlainRecord {
  if (!filePath || !existsSync(filePath)) {
    return {};
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (cause) {
    throw new ConfigError(`Failed to read config file "${filePath}".`, [String(cause)]);
  }
  try {
    return JSON.parse(raw) as PlainRecord;
  } catch (cause) {
    throw new ConfigError(`Failed to parse config file "${filePath}" as JSON.`, [String(cause)]);
  }
}

function fromEnv(env: NodeJS.ProcessEnv): PlainRecord {
  const out: PlainRecord = {};
  if (env.NODE_ENV) out.nodeEnv = env.NODE_ENV;
  if (env.SOCIAL_WORKSPACE_ROOT) out.workspaceRoot = env.SOCIAL_WORKSPACE_ROOT;
  if (env.SOCIAL_LOG_LEVEL) out.logLevel = env.SOCIAL_LOG_LEVEL;
  if (env.SOCIAL_PLUGIN_GLOBS) {
    out.plugins = {
      globs: env.SOCIAL_PLUGIN_GLOBS.split(',')
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0),
    };
  }
  if (env.SOCIAL_DB_DRIVER || env.SOCIAL_DB_URL) {
    out.database = {
      ...(env.SOCIAL_DB_DRIVER ? { driver: env.SOCIAL_DB_DRIVER } : {}),
      ...(env.SOCIAL_DB_URL ? { url: env.SOCIAL_DB_URL } : {}),
    };
  }
  return out;
}

function isPlainObject(value: unknown): value is PlainRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base: PlainRecord, override: PlainRecord): PlainRecord {
  const out: PlainRecord = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseValue = base[key];
    if (isPlainObject(value) && isPlainObject(baseValue)) {
      out[key] = deepMerge(baseValue, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Loads, merges, and validates config from defaults + optional file + env. */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env;
  const fileConfig = readFileConfig(options.filePath ?? env.SOCIAL_CONFIG_FILE);
  const envConfig = fromEnv(env);
  const merged = deepMerge(fileConfig, envConfig);

  if (options.workspaceRoot !== undefined && merged.workspaceRoot === undefined) {
    merged.workspaceRoot = options.workspaceRoot;
  }

  const result = AppConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new ConfigError('Invalid configuration.', issues);
  }
  return result.data;
}

/** Key names never safe to log, even if config grows secret-shaped fields later. */
const SECRET_KEY_PATTERN = /secret|token|password|credential|key$/i;

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (isPlainObject(value)) {
    const out: PlainRecord = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : scrub(v);
    }
    return out;
  }
  return value;
}

/** A projection of `AppConfig` guaranteed safe to pass to a logger. */
export function redactedConfigSummary(config: AppConfig): Record<string, unknown> {
  return scrub(JSON.parse(JSON.stringify(config))) as Record<string, unknown>;
}
