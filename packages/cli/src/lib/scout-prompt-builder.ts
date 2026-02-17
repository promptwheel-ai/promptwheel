/**
 * Fluent builder for scout prompt assembly.
 * Replaces manual string concatenation with ordered, named blocks.
 */

const BLOCK_ORDER = [
  'guidelines',
  'metadata',
  'taste',
  'goal',
  'trajectory',
  'index',
  'dedup',
  'cycle',
  'baselineHealth',
  'escalation',
  'learnings',
  'formula',
  'hints',
] as const;

type BlockKey = (typeof BLOCK_ORDER)[number];

export class ScoutPromptBuilder {
  private blocks = new Map<BlockKey, string>();

  addGuidelines(content: string): this {
    if (content) this.blocks.set('guidelines', content);
    return this;
  }

  addMetadata(content: string): this {
    if (content) this.blocks.set('metadata', content);
    return this;
  }

  addTasteProfile(content: string): this {
    if (content) this.blocks.set('taste', content);
    return this;
  }

  addGoalContext(content: string): this {
    if (content) this.blocks.set('goal', content);
    return this;
  }

  addTrajectoryContext(content: string): this {
    if (content) this.blocks.set('trajectory', content);
    return this;
  }

  addCodebaseIndex(content: string): this {
    if (content) this.blocks.set('index', content);
    return this;
  }

  addDedupMemory(content: string): this {
    if (content) this.blocks.set('dedup', content);
    return this;
  }

  addCycleContext(content: string): this {
    if (content) this.blocks.set('cycle', content);
    return this;
  }

  addBaselineHealth(content: string): this {
    if (content) this.blocks.set('baselineHealth', content);
    return this;
  }

  addEscalation(content: string): this {
    if (content) this.blocks.set('escalation', content);
    return this;
  }

  addLearnings(content: string): this {
    if (content) this.blocks.set('learnings', content);
    return this;
  }

  addFormulaPrompt(content: string): this {
    if (content) this.blocks.set('formula', content);
    return this;
  }

  addHints(content: string): this {
    if (content) this.blocks.set('hints', content);
    return this;
  }

  build(): string | undefined {
    const parts: string[] = [];
    for (const key of BLOCK_ORDER) {
      const block = this.blocks.get(key);
      if (block) parts.push(block);
    }
    return parts.length > 0 ? parts.join('\n\n') : undefined;
  }
}
