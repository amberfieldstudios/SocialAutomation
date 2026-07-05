import { describe, expect, it } from 'vitest';
import { MockProvider } from '../src/mockProvider';
import type { ContentGenerationTask } from '../src/types';

const baseTask: ContentGenerationTask = {
  kind: 'body',
  platform: 'discord',
  brief: { description: 'We are live streaming the new release tonight at 8pm.' },
  toneInstruction: 'Write a punchy Discord announcement.',
  maxLength: 200,
  targetLength: 150,
};

describe('MockProvider determinism', () => {
  it('generate() is a pure function of its input', async () => {
    const provider = new MockProvider();
    const a = await provider.generate(baseTask);
    const b = await provider.generate({ ...baseTask });
    expect(a).toBe(b);
  });

  it('never exceeds maxLength', async () => {
    const provider = new MockProvider();
    const text = await provider.generate({ ...baseTask, maxLength: 20 });
    expect(text.length).toBeLessThanOrEqual(20);
  });

  it('shorten() produces a strictly shorter result than the source', async () => {
    const provider = new MockProvider();
    const source = 'This is a reasonably long sentence about the new game release event tonight.';
    const shortened = await provider.shorten({
      ...baseTask,
      sourceText: source,
      targetLength: undefined,
      maxLength: 200,
    });
    expect(shortened.length).toBeLessThan(source.length);
  });

  it('expand() produces a strictly longer result than a short source (within maxLength)', async () => {
    const provider = new MockProvider();
    const source = 'New release tonight.';
    const expanded = await provider.expand({
      ...baseTask,
      sourceText: source,
      targetLength: 120,
      maxLength: 200,
    });
    expect(expanded.length).toBeGreaterThan(source.length);
    expect(expanded.length).toBeLessThanOrEqual(200);
  });

  it('produces honest copy: no keyword-stuffed padding, output is the brief, not repetition', async () => {
    const provider = new MockProvider();
    const description = 'We are live streaming the new release tonight at 8pm.';
    const out = await provider.generate({ ...baseTask, brief: { description }, maxLength: 2000, targetLength: 1500 });
    // The honest template returns the author's own message verbatim — it never
    // pads toward a target length by repeating the brief's words.
    expect(out).toBe(description);
    const words = out.toLowerCase().split(/\s+/).filter(Boolean);
    const counts = new Map<string, number>();
    for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
    // "streaming"/"release"/"tonight" appeared once in the brief and must not be
    // duplicated by filler expansion.
    expect(counts.get('streaming')).toBe(1);
    expect(counts.get('release')).toBe(1);
    expect(counts.get('tonight')).toBe(1);
  });

  it('leads with a distinct author title but never restates a redundant one', async () => {
    const provider = new MockProvider();
    const withTitle = await provider.generate({
      ...baseTask,
      brief: { description: 'Ten new tracks are available today.', title: 'Racing update is here' },
      maxLength: 2000,
    });
    expect(withTitle).toBe('Racing update is here. Ten new tracks are available today.');
  });

  it('rewrite() never leaks tone-instruction / prompt text into the output', async () => {
    const provider = new MockProvider();
    const source = 'The new season starts this weekend.';
    const out = await provider.rewrite({
      ...baseTask,
      kind: 'body',
      sourceText: source,
      toneInstruction: 'Write a punchy Discord announcement. Be high-energy.',
    });
    expect(out).toBe(source);
    expect(out).not.toContain('Write a punchy');
    expect(out).not.toContain('Discord announcement');
  });

  it('never fabricates network calls — runs with no ANTHROPIC_API_KEY set', async () => {
    const original = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const provider = new MockProvider();
      await expect(provider.generate(baseTask)).resolves.toEqual(expect.any(String));
    } finally {
      if (original !== undefined) process.env['ANTHROPIC_API_KEY'] = original;
    }
  });
});
