/**
 * On-device `ContentProvider` backed by a local GGUF model via `node-llama-cpp`.
 *
 * WHY THIS EXISTS: it is the credential-free generation path — no API key, no
 * network call, no per-token billing. When a model file is present on disk the
 * running app prefers this provider over `mock`; when it is absent (or the
 * native binary can't load, or the machine is too weak) the caller falls back
 * to the deterministic template path (that fallback chain is task t5's job —
 * this module only exposes the seams: `resolveLocalModelPath` /
 * `isLocalModelAvailable` for presence detection, and an `AiConfigError` /
 * `AiProviderError` surface a fallback can catch).
 *
 * NATIVE-BINARY NOTE (mirrors `@social/db`'s better-sqlite3 handling):
 * `node-llama-cpp` is a native addon that ships prebuilt binaries and, for a
 * real model, needs a ~2 GB GGUF file downloaded to disk (task t4). Neither is
 * guaranteed in every environment, so:
 *   - `node-llama-cpp` is an OPTIONAL dependency and is imported LAZILY, via a
 *     dynamic `import()` behind an indirection, only when a model is actually
 *     loaded. Importing THIS module never touches the native binary, so it
 *     type-checks, imports, and unit-tests cleanly with the binary absent.
 *   - The llama runtime is expressed as the injectable `LocalLlmRuntime`
 *     interface. Tests inject a fake runtime (see localProvider.test.ts) to
 *     prove prompt construction, per-platform formatting, and the
 *     `ContentProvider` contract WITHOUT loading a real model. Real GGUF
 *     download + inference is explicitly owed real-world verification.
 *
 * Prompt construction is shared with `ClaudeProvider`/`OpenAiProvider` via
 * `promptBuilder.ts`, so per-platform tone/length/hashtag guidance (built from
 * `platformProfiles.ts` by `CampaignGenerator`) holds identically here.
 */

import { statSync } from 'node:fs';
import type { StructuredLogger } from '@social/core';
import { AiConfigError, AiProviderError } from './errors';
import type { ContentGenerationTask, ContentProvider } from './types';
import { truncateToLimit } from './text';
import { buildPrompt, SYSTEM_PROMPT } from './promptBuilder';

/** Env var naming the on-disk path to the GGUF model file. Set by the model
 * download manager (task t4) once a model has been fetched. */
export const LOCAL_MODEL_PATH_ENV = 'LOCAL_MODEL_PATH';

/** Sensible defaults for short social copy: a little sampling entropy so the
 * four op variants (generate/rewrite) don't come out byte-identical, capped
 * output because posts are short. Overridable via `LocalProviderConfig`. */
export const DEFAULT_LOCAL_MAX_TOKENS = 400;
export const DEFAULT_LOCAL_TEMPERATURE = 0.8;
export const DEFAULT_LOCAL_TOP_P = 0.9;

// ---------------------------------------------------------------------------
// Injectable runtime seam — the ONLY surface LocalProvider needs from an
// on-device LLM. Kept deliberately tiny and free of any `node-llama-cpp` type
// import so this module compiles with the native package absent.
// ---------------------------------------------------------------------------

export interface LocalPromptOptions {
  maxTokens: number;
  temperature: number;
  topP: number;
}

/** A single, history-free chat turn against a loaded model. */
export interface LocalChatSession {
  /** One-shot completion of `prompt`; returns the model's raw text. */
  prompt(prompt: string, options: LocalPromptOptions): Promise<string>;
}

/** A model that has been loaded into memory and can mint fresh chat sessions. */
export interface LocalLoadedModel {
  /** Create a fresh session seeded with `systemPrompt` and NO prior history,
   * so distinct generation tasks never bleed context into one another. */
  createSession(systemPrompt: string): Promise<LocalChatSession>;
  /** Release native resources held by the model. */
  dispose(): Promise<void>;
}

/** The runtime LocalProvider depends on; a real one wraps `node-llama-cpp`
 * (see `createNodeLlamaCppRuntime`), tests inject a fake. */
export interface LocalLlmRuntime {
  /** Load the GGUF model at `modelPath`. Called at most once per provider. */
  loadModel(modelPath: string): Promise<LocalLoadedModel>;
}

// ---------------------------------------------------------------------------
// Model-presence helpers — the seam the download manager (t4) and the API
// context wiring use to decide whether `local` is usable right now.
// ---------------------------------------------------------------------------

/** Resolve the configured model path: explicit arg, else `LOCAL_MODEL_PATH`. */
export function resolveLocalModelPath(explicit?: string): string | undefined {
  const candidate = explicit ?? process.env[LOCAL_MODEL_PATH_ENV];
  return candidate && candidate.length > 0 ? candidate : undefined;
}

/** True when `modelPath` names an existing regular file on disk. Cheap, sync,
 * no native binding required — safe to call at app startup to pick a default
 * provider. Does NOT validate that the file is a loadable GGUF (that is only
 * knowable by actually loading it — owed real-world verification). */
export function isLocalModelAvailable(modelPath: string | undefined): boolean {
  if (!modelPath) return false;
  try {
    return statSync(modelPath).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Real node-llama-cpp adapter. This is the thin wrapper whose behaviour can
// only be confirmed with the native binary + a real model present, so it is
// explicitly owed real-world verification. Everything above/below is unit
// tested with a stub runtime.
// ---------------------------------------------------------------------------

/** Minimal shape of the parts of `node-llama-cpp` this adapter uses. Declared
 * locally (not imported) so the absence of the package is not a compile error. */
interface NodeLlamaCppModule {
  getLlama(): Promise<NodeLlama>;
  LlamaChatSession: NodeLlamaChatSessionCtor;
}
interface NodeLlama {
  loadModel(options: { modelPath: string }): Promise<NodeLlamaModel>;
}
interface NodeLlamaModel {
  createContext(): Promise<NodeLlamaContext>;
  dispose(): Promise<void>;
}
interface NodeLlamaContext {
  getSequence(): unknown;
  dispose(): Promise<void>;
}
interface NodeLlamaChatSession {
  prompt(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number; topP?: number },
  ): Promise<string>;
}
type NodeLlamaChatSessionCtor = new (options: {
  contextSequence: unknown;
  systemPrompt?: string;
}) => NodeLlamaChatSession;

/** Dynamically import `node-llama-cpp`. The specifier is held in a variable so
 * TypeScript/the bundler does NOT try to resolve the (optional, possibly
 * absent) module at build time — matching the lazy-require pattern in
 * `@social/db`'s `sqlite.ts`. */
async function importNodeLlamaCpp(): Promise<NodeLlamaCppModule> {
  const specifier = 'node-llama-cpp';
  return (await import(specifier)) as NodeLlamaCppModule;
}

/** Build a real `LocalLlmRuntime` backed by `node-llama-cpp`. Constructing it
 * does NOT import the native package — the import happens lazily inside
 * `loadModel`, so this is safe to call as a default even when the binary is
 * absent. */
export function createNodeLlamaCppRuntime(): LocalLlmRuntime {
  return {
    async loadModel(modelPath: string): Promise<LocalLoadedModel> {
      const mod = await importNodeLlamaCpp();
      const llama = await mod.getLlama();
      const model = await llama.loadModel({ modelPath });
      return {
        async createSession(systemPrompt: string): Promise<LocalChatSession> {
          // A fresh context+sequence per session keeps each task independent.
          // Resource-lifecycle tuning (context pooling, sequence reuse) is a
          // real-model optimisation owed real-world verification.
          const context = await model.createContext();
          const session = new mod.LlamaChatSession({
            contextSequence: context.getSequence(),
            systemPrompt,
          });
          return {
            async prompt(prompt: string, options: LocalPromptOptions): Promise<string> {
              return session.prompt(prompt, {
                maxTokens: options.maxTokens,
                temperature: options.temperature,
                topP: options.topP,
              });
            },
          };
        },
        async dispose(): Promise<void> {
          await model.dispose();
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// LocalProvider
// ---------------------------------------------------------------------------

export interface LocalProviderConfig {
  /** On-disk path to the GGUF model file. Required (falls back to
   * `LOCAL_MODEL_PATH`). The provider does not download it — task t4 does. */
  modelPath?: string;
  logger: StructuredLogger;
  /** Inject a runtime (tests / custom transport). Defaults to the real
   * `node-llama-cpp`-backed runtime, imported lazily on first generation. */
  runtime?: LocalLlmRuntime;
  /** Max output tokens per call. Default `DEFAULT_LOCAL_MAX_TOKENS`. */
  maxTokens?: number;
  /** Sampling temperature. Default `DEFAULT_LOCAL_TEMPERATURE`. */
  temperature?: number;
  /** Nucleus-sampling top-p. Default `DEFAULT_LOCAL_TOP_P`. */
  topP?: number;
}

export class LocalProvider implements ContentProvider {
  readonly name = 'local';
  private readonly modelPath: string;
  private readonly logger: StructuredLogger;
  private readonly runtime: LocalLlmRuntime;
  private readonly promptOptions: LocalPromptOptions;
  /** Memoised model load; the model is loaded at most once, on first use. */
  private modelPromise: Promise<LocalLoadedModel> | undefined;

  constructor(config: LocalProviderConfig) {
    this.logger = config.logger.child({ component: 'ai.local_provider' });
    const modelPath = resolveLocalModelPath(config.modelPath);
    if (!modelPath) {
      throw new AiConfigError(
        'LocalProvider requires a model path: pass config.modelPath or set ' +
          `${LOCAL_MODEL_PATH_ENV}. The model is downloaded on first use by the ` +
          'model download manager; until one is present, use the credential-free ' +
          'fallback provider instead.',
      );
    }
    this.modelPath = modelPath;
    this.runtime = config.runtime ?? createNodeLlamaCppRuntime();
    this.promptOptions = {
      maxTokens: config.maxTokens ?? DEFAULT_LOCAL_MAX_TOKENS,
      temperature: config.temperature ?? DEFAULT_LOCAL_TEMPERATURE,
      topP: config.topP ?? DEFAULT_LOCAL_TOP_P,
    };
  }

  async generate(task: ContentGenerationTask): Promise<string> {
    return this.complete(task, buildPrompt(task, 'generate'));
  }

  async rewrite(task: ContentGenerationTask): Promise<string> {
    return this.complete(task, buildPrompt(task, 'rewrite'));
  }

  async shorten(task: ContentGenerationTask): Promise<string> {
    return this.complete(task, buildPrompt(task, 'shorten'));
  }

  async expand(task: ContentGenerationTask): Promise<string> {
    return this.complete(task, buildPrompt(task, 'expand'));
  }

  /** Load the model once and reuse it. A load failure (native binary missing,
   * unreadable/corrupt GGUF) surfaces as `AiConfigError` so a caller can fall
   * back to the template provider rather than error the request. */
  private async loadModel(): Promise<LocalLoadedModel> {
    if (!this.modelPromise) {
      this.modelPromise = this.runtime.loadModel(this.modelPath).catch((error: unknown) => {
        // Reset so a later call can retry once the environment is fixed.
        this.modelPromise = undefined;
        throw new AiConfigError(
          `LocalProvider could not load the model at "${this.modelPath}". ` +
            'Ensure node-llama-cpp is installed with a working native binary and ' +
            `the file is a valid GGUF model. Cause: ${errorMessage(error)}`,
        );
      });
    }
    return this.modelPromise;
  }

  private async complete(task: ContentGenerationTask, prompt: string): Promise<string> {
    const startedAt = Date.now();
    try {
      const model = await this.loadModel();
      const session = await model.createSession(SYSTEM_PROMPT);
      const raw = await session.prompt(prompt, this.promptOptions);
      // Final safety net — never trust a provider's self-reported length.
      // Richer post-processing (quote stripping, artifact removal, distinct
      // variants) is task t5's generation-quality work.
      const text = truncateToLimit(raw, task.maxLength, task.countGraphemes);

      this.logger.info('ai.local_completion', {
        platform: task.platform,
        kind: task.kind,
        promptLength: prompt.length,
        outputLength: text.length,
        durationMs: Date.now() - startedAt,
      });
      return text;
    } catch (error) {
      // A config/environment problem (missing binary, bad model) is not
      // retryable and is what the fallback chain (t5) keys off.
      if (error instanceof AiConfigError) {
        this.logger.warn('ai.local_unavailable', {
          platform: task.platform,
          kind: task.kind,
          errorName: error.name,
        });
        throw error;
      }
      this.logger.error('ai.local_error', {
        platform: task.platform,
        kind: task.kind,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw new AiProviderError(`Local model inference failed for ${task.platform}/${task.kind}.`, {
        retryable: false,
        cause: error,
      });
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
