import { describe, it, expect } from 'vitest';
import { ScoutPromptBuilder } from '../lib/scout-prompt-builder.js';

// ---------------------------------------------------------------------------
// build() basics
// ---------------------------------------------------------------------------

describe('ScoutPromptBuilder', () => {
  it('returns undefined when no blocks are set', () => {
    const builder = new ScoutPromptBuilder();
    expect(builder.build()).toBeUndefined();
  });

  it('returns a single block without extra separators', () => {
    const result = new ScoutPromptBuilder()
      .addGuidelines('# Guidelines')
      .build();
    expect(result).toBe('# Guidelines');
  });

  it('joins multiple blocks with double newline', () => {
    const result = new ScoutPromptBuilder()
      .addGuidelines('block-a')
      .addMetadata('block-b')
      .build();
    expect(result).toBe('block-a\n\nblock-b');
  });

  // ---------------------------------------------------------------------------
  // Ordering
  // ---------------------------------------------------------------------------

  it('orders blocks according to BLOCK_ORDER regardless of insertion order', () => {
    // Insert in reverse of expected order
    const result = new ScoutPromptBuilder()
      .addHints('hints')
      .addFormulaPrompt('formula')
      .addLearnings('learnings')
      .addEscalation('escalation')
      .addBaselineHealth('baseline')
      .addCycleContext('cycle')
      .addDedupMemory('dedup')
      .addCodebaseIndex('index')
      .addTrajectoryContext('trajectory')
      .addGoalContext('goal')
      .addTasteProfile('taste')
      .addMetadata('metadata')
      .addGuidelines('guidelines')
      .build();

    const blocks = result!.split('\n\n');
    expect(blocks).toEqual([
      'guidelines',
      'metadata',
      'taste',
      'goal',
      'trajectory',
      'index',
      'dedup',
      'cycle',
      'baseline',
      'escalation',
      'learnings',
      'formula',
      'hints',
    ]);
  });

  it('maintains order with a subset of blocks', () => {
    const result = new ScoutPromptBuilder()
      .addHints('hints-content')
      .addGuidelines('guidelines-content')
      .addLearnings('learnings-content')
      .build();

    const blocks = result!.split('\n\n');
    expect(blocks).toEqual([
      'guidelines-content',
      'learnings-content',
      'hints-content',
    ]);
  });

  // ---------------------------------------------------------------------------
  // Truthy guards — falsy values are silently ignored
  // ---------------------------------------------------------------------------

  it('ignores empty string content', () => {
    const result = new ScoutPromptBuilder()
      .addGuidelines('')
      .addMetadata('meta')
      .build();
    expect(result).toBe('meta');
  });

  it('returns undefined when all blocks are empty strings', () => {
    const result = new ScoutPromptBuilder()
      .addGuidelines('')
      .addMetadata('')
      .addHints('')
      .build();
    expect(result).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Fluent API — all setters return `this`
  // ---------------------------------------------------------------------------

  it('all setters return the builder instance for chaining', () => {
    const builder = new ScoutPromptBuilder();
    expect(builder.addGuidelines('a')).toBe(builder);
    expect(builder.addMetadata('b')).toBe(builder);
    expect(builder.addTasteProfile('c')).toBe(builder);
    expect(builder.addGoalContext('d')).toBe(builder);
    expect(builder.addTrajectoryContext('e')).toBe(builder);
    expect(builder.addCodebaseIndex('f')).toBe(builder);
    expect(builder.addDedupMemory('g')).toBe(builder);
    expect(builder.addCycleContext('h')).toBe(builder);
    expect(builder.addBaselineHealth('i')).toBe(builder);
    expect(builder.addEscalation('j')).toBe(builder);
    expect(builder.addLearnings('k')).toBe(builder);
    expect(builder.addFormulaPrompt('l')).toBe(builder);
    expect(builder.addHints('m')).toBe(builder);
  });

  // ---------------------------------------------------------------------------
  // Individual setter coverage
  // ---------------------------------------------------------------------------

  it('addGuidelines sets the guidelines block', () => {
    const result = new ScoutPromptBuilder().addGuidelines('GL').build();
    expect(result).toBe('GL');
  });

  it('addMetadata sets the metadata block', () => {
    const result = new ScoutPromptBuilder().addMetadata('MD').build();
    expect(result).toBe('MD');
  });

  it('addTasteProfile sets the taste block', () => {
    const result = new ScoutPromptBuilder().addTasteProfile('TP').build();
    expect(result).toBe('TP');
  });

  it('addGoalContext sets the goal block', () => {
    const result = new ScoutPromptBuilder().addGoalContext('GC').build();
    expect(result).toBe('GC');
  });

  it('addTrajectoryContext sets the trajectory block', () => {
    const result = new ScoutPromptBuilder().addTrajectoryContext('TC').build();
    expect(result).toBe('TC');
  });

  it('addCodebaseIndex sets the index block', () => {
    const result = new ScoutPromptBuilder().addCodebaseIndex('CI').build();
    expect(result).toBe('CI');
  });

  it('addDedupMemory sets the dedup block', () => {
    const result = new ScoutPromptBuilder().addDedupMemory('DD').build();
    expect(result).toBe('DD');
  });

  it('addCycleContext sets the cycle block', () => {
    const result = new ScoutPromptBuilder().addCycleContext('CC').build();
    expect(result).toBe('CC');
  });

  it('addBaselineHealth sets the baselineHealth block', () => {
    const result = new ScoutPromptBuilder().addBaselineHealth('BH').build();
    expect(result).toBe('BH');
  });

  it('addEscalation sets the escalation block', () => {
    const result = new ScoutPromptBuilder().addEscalation('ES').build();
    expect(result).toBe('ES');
  });

  it('addLearnings sets the learnings block', () => {
    const result = new ScoutPromptBuilder().addLearnings('LR').build();
    expect(result).toBe('LR');
  });

  it('addFormulaPrompt sets the formula block', () => {
    const result = new ScoutPromptBuilder().addFormulaPrompt('FP').build();
    expect(result).toBe('FP');
  });

  it('addHints sets the hints block', () => {
    const result = new ScoutPromptBuilder().addHints('HN').build();
    expect(result).toBe('HN');
  });

  // ---------------------------------------------------------------------------
  // Overwrite behavior — last call wins
  // ---------------------------------------------------------------------------

  it('overwrites a block when the same setter is called twice', () => {
    const result = new ScoutPromptBuilder()
      .addGuidelines('first')
      .addGuidelines('second')
      .build();
    expect(result).toBe('second');
  });

  // ---------------------------------------------------------------------------
  // Content with newlines
  // ---------------------------------------------------------------------------

  it('preserves newlines within block content', () => {
    const result = new ScoutPromptBuilder()
      .addGuidelines('line1\nline2\nline3')
      .addMetadata('meta')
      .build();
    expect(result).toBe('line1\nline2\nline3\n\nmeta');
  });

  // ---------------------------------------------------------------------------
  // Independent builds
  // ---------------------------------------------------------------------------

  it('build() can be called multiple times with same result', () => {
    const builder = new ScoutPromptBuilder()
      .addGuidelines('a')
      .addHints('b');
    expect(builder.build()).toBe(builder.build());
  });

  it('adding blocks after build changes the next build result', () => {
    const builder = new ScoutPromptBuilder().addGuidelines('a');
    expect(builder.build()).toBe('a');

    builder.addHints('b');
    expect(builder.build()).toBe('a\n\nb');
  });
});
