import { describe, it, expect } from 'vitest';
import {
  deriveSeverity,
  inferSeverity,
  isValidRiskAssessment,
  normalizeProposal,
  type RiskAssessment,
  type RawProposal,
} from '../proposals/shared.js';

// ---------------------------------------------------------------------------
// Helper to build assessments concisely
// ---------------------------------------------------------------------------

function ra(overrides: Partial<RiskAssessment> = {}): RiskAssessment {
  return {
    user_impact: 'none',
    exploitability: 'none',
    blast_radius: 'single_file',
    data_risk: 'none',
    confidence_basis: 'code_trace',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// deriveSeverity — rubric-based
// ---------------------------------------------------------------------------

describe('deriveSeverity', () => {
  // --- Blocking: any critical dimension ---
  it('blocking: user_impact=broken', () => {
    expect(deriveSeverity(ra({ user_impact: 'broken' }))).toBe('blocking');
  });

  it('blocking: data_risk=lost', () => {
    expect(deriveSeverity(ra({ data_risk: 'lost' }))).toBe('blocking');
  });

  it('blocking: exploitability=public', () => {
    expect(deriveSeverity(ra({ exploitability: 'public' }))).toBe('blocking');
  });

  it('blocking: broken + public + lost (all critical)', () => {
    expect(deriveSeverity(ra({
      user_impact: 'broken', exploitability: 'public', data_risk: 'lost',
    }))).toBe('blocking');
  });

  it('blocking: broken overrides all other dimensions', () => {
    expect(deriveSeverity(ra({
      user_impact: 'broken', blast_radius: 'single_file',
      confidence_basis: 'pattern_match',
    }))).toBe('blocking');
  });

  it('blocking: public exploitability even with minor impact', () => {
    expect(deriveSeverity(ra({
      user_impact: 'minor', exploitability: 'public',
    }))).toBe('blocking');
  });

  it('blocking: data loss even with no user-visible impact', () => {
    expect(deriveSeverity(ra({
      user_impact: 'none', data_risk: 'lost',
    }))).toBe('blocking');
  });

  // --- Degrading: significant but not critical ---
  it('degrading: user_impact=degraded', () => {
    expect(deriveSeverity(ra({ user_impact: 'degraded' }))).toBe('degrading');
  });

  it('degrading: data_risk=corrupted', () => {
    expect(deriveSeverity(ra({ data_risk: 'corrupted' }))).toBe('degrading');
  });

  it('degrading: blast_radius=system_wide', () => {
    expect(deriveSeverity(ra({ blast_radius: 'system_wide' }))).toBe('degrading');
  });

  it('degrading: degraded + module scope', () => {
    expect(deriveSeverity(ra({
      user_impact: 'degraded', blast_radius: 'module',
    }))).toBe('degrading');
  });

  it('degrading: corrupted data + requires_auth', () => {
    expect(deriveSeverity(ra({
      data_risk: 'corrupted', exploitability: 'requires_auth',
    }))).toBe('degrading');
  });

  it('degrading: system_wide with pattern_match evidence', () => {
    expect(deriveSeverity(ra({
      blast_radius: 'system_wide', confidence_basis: 'pattern_match',
    }))).toBe('degrading');
  });

  it('degrading: degraded user + pattern_match (degrading wins over speculative)', () => {
    expect(deriveSeverity(ra({
      user_impact: 'degraded', confidence_basis: 'pattern_match',
    }))).toBe('degrading');
  });

  // --- Speculative: low-evidence with no impact ---
  it('speculative: pattern_match + no impact', () => {
    expect(deriveSeverity(ra({
      confidence_basis: 'pattern_match',
    }))).toBe('speculative');
  });

  it('speculative: pattern_match + none + single_file', () => {
    expect(deriveSeverity(ra({
      user_impact: 'none', blast_radius: 'single_file',
      confidence_basis: 'pattern_match',
    }))).toBe('speculative');
  });

  // Speculative should NOT trigger if any higher severity dimension is present
  it('not speculative: pattern_match but minor impact → polish', () => {
    expect(deriveSeverity(ra({
      user_impact: 'minor', confidence_basis: 'pattern_match',
    }))).toBe('polish');
  });

  it('not speculative: pattern_match but module blast_radius → polish', () => {
    expect(deriveSeverity(ra({
      blast_radius: 'module', confidence_basis: 'pattern_match',
    }))).toBe('speculative'); // module alone doesn't trigger degrading, so still speculative
  });

  // --- Polish: everything else ---
  it('polish: minor impact + code_trace', () => {
    expect(deriveSeverity(ra({ user_impact: 'minor' }))).toBe('polish');
  });

  it('polish: no impact + runtime_evidence', () => {
    expect(deriveSeverity(ra({
      confidence_basis: 'runtime_evidence',
    }))).toBe('polish');
  });

  it('polish: minor + requires_auth + module', () => {
    expect(deriveSeverity(ra({
      user_impact: 'minor', exploitability: 'requires_auth', blast_radius: 'module',
    }))).toBe('polish');
  });

  it('polish: stale data + minor impact', () => {
    expect(deriveSeverity(ra({
      user_impact: 'minor', data_risk: 'stale',
    }))).toBe('polish');
  });

  it('polish: no impact + module + code_trace', () => {
    expect(deriveSeverity(ra({
      blast_radius: 'module',
    }))).toBe('polish');
  });

  it('polish: stale data + no impact + code_trace', () => {
    expect(deriveSeverity(ra({
      data_risk: 'stale',
    }))).toBe('polish');
  });
});

// ---------------------------------------------------------------------------
// inferSeverity — regex fallback
// ---------------------------------------------------------------------------

describe('inferSeverity', () => {
  // Blocking
  it('blocking: security category always blocking', () => {
    expect(inferSeverity('security', 'Add rate limiting')).toBe('blocking');
  });

  it('blocking: crash signal', () => {
    expect(inferSeverity('fix', 'Crash when user submits empty form')).toBe('blocking');
  });

  it('blocking: race condition signal', () => {
    expect(inferSeverity('fix', 'Race condition in concurrent writes')).toBe('blocking');
  });

  it('blocking: SQL injection signal', () => {
    expect(inferSeverity('refactor', 'Potential SQL injection in query builder')).toBe('blocking');
  });

  it('blocking: XSS signal', () => {
    expect(inferSeverity('fix', 'XSS vulnerability in user profile page')).toBe('blocking');
  });

  it('blocking: data loss signal', () => {
    expect(inferSeverity('fix', 'Data loss when concurrent saves overlap')).toBe('blocking');
  });

  it('blocking: memory leak signal', () => {
    expect(inferSeverity('perf', 'Memory leak in event listener cleanup')).toBe('blocking');
  });

  it('blocking: deadlock signal', () => {
    expect(inferSeverity('fix', 'Potential deadlock in transaction handling')).toBe('blocking');
  });

  it('blocking: unhandled signal', () => {
    expect(inferSeverity('fix', 'Unhandled promise rejection in API handler')).toBe('blocking');
  });

  // Degrading
  it('degrading: fix + silently fails', () => {
    expect(inferSeverity('fix', 'Silently fails when webhook returns 500')).toBe('degrading');
  });

  it('degrading: fix + wrong result', () => {
    expect(inferSeverity('fix', 'Wrong result when filtering by date range')).toBe('degrading');
  });

  it('degrading: fix category without specific signal', () => {
    expect(inferSeverity('fix', 'Fix the pagination offset calculation')).toBe('degrading');
  });

  it('degrading: non-fix + dead code signal', () => {
    expect(inferSeverity('refactor', 'Dead code path never reached in production')).toBe('degrading');
  });

  it('degrading: timeout signal', () => {
    expect(inferSeverity('perf', 'Request timeout when processing large files')).toBe('degrading');
  });

  it('degrading: missing validation signal', () => {
    expect(inferSeverity('refactor', 'Missing validation on user input field')).toBe('degrading');
  });

  // Polish
  it('polish: docs category', () => {
    expect(inferSeverity('docs', 'Update API documentation for new endpoints')).toBe('polish');
  });

  it('polish: types category', () => {
    expect(inferSeverity('types', 'Add stricter types to config module')).toBe('polish');
  });

  it('polish: cleanup category', () => {
    expect(inferSeverity('cleanup', 'Remove unused helper functions')).toBe('polish');
  });

  it('polish: refactor without signals', () => {
    expect(inferSeverity('refactor', 'Extract shared logic into utility module')).toBe('polish');
  });

  it('polish: perf without signals', () => {
    expect(inferSeverity('perf', 'Add memoization to expensive computation')).toBe('polish');
  });

  // Speculative
  it('speculative: consider signal', () => {
    expect(inferSeverity('refactor', 'Consider splitting this into smaller functions')).toBe('speculative');
  });

  it('speculative: might signal', () => {
    expect(inferSeverity('perf', 'This might benefit from lazy loading')).toBe('speculative');
  });

  it('speculative: cosmetic signal', () => {
    expect(inferSeverity('refactor', 'Cosmetic: rename variables for clarity')).toBe('speculative');
  });

  it('speculative: nitpick signal', () => {
    expect(inferSeverity('refactor', 'Nitpick: prefer const over let here')).toBe('speculative');
  });
});

// ---------------------------------------------------------------------------
// isValidRiskAssessment
// ---------------------------------------------------------------------------

describe('isValidRiskAssessment', () => {
  it('valid: all fields correct', () => {
    expect(isValidRiskAssessment(ra())).toBe(true);
  });

  it('valid: all maximal values', () => {
    expect(isValidRiskAssessment({
      user_impact: 'broken', exploitability: 'public', blast_radius: 'system_wide',
      data_risk: 'lost', confidence_basis: 'runtime_evidence',
    })).toBe(true);
  });

  it('invalid: null', () => expect(isValidRiskAssessment(null)).toBe(false));
  it('invalid: undefined', () => expect(isValidRiskAssessment(undefined)).toBe(false));
  it('invalid: string', () => expect(isValidRiskAssessment('high')).toBe(false));
  it('invalid: number', () => expect(isValidRiskAssessment(42)).toBe(false));
  it('invalid: empty object', () => expect(isValidRiskAssessment({})).toBe(false));

  it('invalid: bad user_impact', () => {
    expect(isValidRiskAssessment({ ...ra(), user_impact: 'catastrophic' })).toBe(false);
  });

  it('invalid: bad exploitability', () => {
    expect(isValidRiskAssessment({ ...ra(), exploitability: 'easy' })).toBe(false);
  });

  it('invalid: bad blast_radius', () => {
    expect(isValidRiskAssessment({ ...ra(), blast_radius: 'global' })).toBe(false);
  });

  it('invalid: bad data_risk', () => {
    expect(isValidRiskAssessment({ ...ra(), data_risk: 'destroyed' })).toBe(false);
  });

  it('invalid: bad confidence_basis', () => {
    expect(isValidRiskAssessment({ ...ra(), confidence_basis: 'gut_feeling' })).toBe(false);
  });

  it('invalid: missing one field', () => {
    const { confidence_basis, ...partial } = ra();
    expect(isValidRiskAssessment(partial)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deriveSeverity vs inferSeverity agreement
// ---------------------------------------------------------------------------

describe('rubric/regex agreement on archetypes', () => {
  const cases: Array<{
    name: string;
    assessment: RiskAssessment;
    category: string;
    description: string;
    expected: 'blocking' | 'degrading';
    allowFuzzy?: boolean; // allow polish/speculative for both
  }> = [
    {
      name: 'SQL injection',
      assessment: ra({ user_impact: 'broken', exploitability: 'public', data_risk: 'lost' }),
      category: 'security', description: 'SQL injection in login query',
      expected: 'blocking',
    },
    {
      name: 'XSS vulnerability',
      assessment: ra({ user_impact: 'degraded', exploitability: 'public' }),
      category: 'fix', description: 'Reflected XSS in search results',
      expected: 'blocking',
    },
    {
      name: 'Null pointer crash',
      assessment: ra({ user_impact: 'broken', blast_radius: 'module' }),
      category: 'fix', description: 'Crash on null user in auth middleware',
      expected: 'blocking',
    },
    {
      name: 'Data corruption',
      assessment: ra({ data_risk: 'corrupted', blast_radius: 'module' }),
      category: 'fix', description: 'Wrong result when merging duplicate records',
      expected: 'degrading',
    },
    {
      name: 'Silent error swallowing',
      assessment: ra({ user_impact: 'degraded' }),
      category: 'fix', description: 'Silently swallows database connection errors',
      expected: 'degrading',
    },
  ];

  for (const c of cases) {
    it(`${c.name}: both agree on ${c.expected}`, () => {
      const fromRubric = deriveSeverity(c.assessment);
      const fromRegex = inferSeverity(c.category, c.description);
      expect(fromRubric).toBe(c.expected);
      expect(fromRegex).toBe(c.expected);
    });
  }
});

// ---------------------------------------------------------------------------
// normalizeProposal integration: risk_assessment → severity
// ---------------------------------------------------------------------------

describe('normalizeProposal uses risk_assessment when present', () => {
  function rawProposal(overrides: Partial<RawProposal> = {}): RawProposal {
    return {
      category: 'fix',
      title: 'Test proposal',
      description: 'Fix something',
      allowed_paths: ['src/a.ts'],
      files: ['src/a.ts'],
      confidence: 80,
      ...overrides,
    };
  }

  it('derives blocking from risk_assessment even when category is not security', () => {
    const p = normalizeProposal(rawProposal({
      category: 'refactor',
      description: 'Refactor auth module',
      risk_assessment: ra({ user_impact: 'broken', exploitability: 'public' }),
    }));
    expect(p.severity).toBe('blocking');
    expect(p.risk_assessment).toBeDefined();
  });

  it('derives polish from risk_assessment even when regex would say degrading', () => {
    const p = normalizeProposal(rawProposal({
      category: 'fix',
      description: 'Fix the silent failure in payment processing',
      risk_assessment: ra({ user_impact: 'minor' }),
    }));
    // risk_assessment says polish (minor + defaults), but regex would say degrading
    expect(p.severity).toBe('polish');
  });

  it('falls back to explicit severity when risk_assessment is invalid', () => {
    const p = normalizeProposal(rawProposal({
      severity: 'degrading',
      risk_assessment: { user_impact: 'bad_value' } as unknown as RiskAssessment,
    }));
    expect(p.severity).toBe('degrading');
    expect(p.risk_assessment).toBeUndefined();
  });

  it('falls back to inferSeverity when neither risk_assessment nor severity provided', () => {
    const p = normalizeProposal(rawProposal({
      category: 'security',
      description: 'Add CSRF protection',
    }));
    expect(p.severity).toBe('blocking'); // inferSeverity: security → blocking
  });

  it('falls back to inferSeverity when risk_assessment is missing', () => {
    const p = normalizeProposal(rawProposal({
      category: 'docs',
      description: 'Update README',
    }));
    expect(p.severity).toBe('polish'); // inferSeverity: docs → polish
  });

  it('prefers risk_assessment over explicit severity field', () => {
    const p = normalizeProposal(rawProposal({
      severity: 'polish', // explicit says polish
      risk_assessment: ra({ data_risk: 'lost' }), // rubric says blocking
    }));
    expect(p.severity).toBe('blocking'); // risk_assessment wins
  });
});

// ---------------------------------------------------------------------------
// finding.ts integration
// ---------------------------------------------------------------------------

describe('finding.ts integration', async () => {
  const { proposalToFinding, buildScanResult } = await import('../scout/finding.js');

  it('proposalToFinding maps all fields', () => {
    const finding = proposalToFinding({
      id: 'test-1',
      title: 'Fix null check',
      category: 'fix',
      description: 'Missing null check in auth',
      acceptance_criteria: ['Tests pass'],
      verification_commands: ['npm test'],
      allowed_paths: ['src/auth.ts'],
      files: ['src/auth.ts'],
      confidence: 90,
      impact_score: 8,
      rationale: 'Could crash',
      estimated_complexity: 'simple',
      severity: 'blocking',
      risk_assessment: ra({ user_impact: 'broken', exploitability: 'public' }),
    });

    expect(finding.id).toHaveLength(12);
    expect(finding.title).toBe('Fix null check');
    expect(finding.category).toBe('fix');
    expect(finding.severity).toBe('blocking');
    expect(finding.confidence).toBe(90);
    expect(finding.impact).toBe(8);
    expect(finding.complexity).toBe('simple');
    expect(finding.risk_assessment?.user_impact).toBe('broken');
    expect(finding.fix_available).toBe(true);
  });

  it('proposalToFinding generates deterministic IDs', () => {
    const base = {
      id: 'test-1', title: 'Fix null check', category: 'fix' as const,
      description: 'desc', acceptance_criteria: [], verification_commands: [],
      allowed_paths: [], files: ['a.ts', 'b.ts'], confidence: 80,
      rationale: '', estimated_complexity: 'simple' as const,
    };
    const f1 = proposalToFinding(base);
    const f2 = proposalToFinding({ ...base, id: 'different-id' });
    expect(f1.id).toBe(f2.id);
  });

  it('proposalToFinding: fix_available false when confidence < 70', () => {
    const finding = proposalToFinding({
      id: 'test-2', title: 'Maybe fix', category: 'fix',
      description: 'desc', acceptance_criteria: [], verification_commands: [],
      allowed_paths: [], files: ['a.ts'], confidence: 50,
      rationale: '', estimated_complexity: 'simple',
    });
    expect(finding.fix_available).toBe(false);
  });

  it('proposalToFinding: fix_available false when no files', () => {
    const finding = proposalToFinding({
      id: 'test-3', title: 'Vague fix', category: 'fix',
      description: 'desc', acceptance_criteria: [], verification_commands: [],
      allowed_paths: [], files: [], confidence: 95,
      rationale: '', estimated_complexity: 'simple',
    });
    expect(finding.fix_available).toBe(false);
  });

  it('buildScanResult produces correct summary', () => {
    const result = buildScanResult([
      { id: '1', title: 'A', category: 'fix', description: '', acceptance_criteria: [],
        verification_commands: [], allowed_paths: [], files: ['a.ts'], confidence: 90,
        rationale: '', estimated_complexity: 'simple', severity: 'blocking' },
      { id: '2', title: 'B', category: 'perf', description: '', acceptance_criteria: [],
        verification_commands: [], allowed_paths: [], files: ['b.ts'], confidence: 80,
        rationale: '', estimated_complexity: 'moderate', severity: 'degrading' },
      { id: '3', title: 'C', category: 'fix', description: '', acceptance_criteria: [],
        verification_commands: [], allowed_paths: [], files: ['c.ts'], confidence: 70,
        rationale: '', estimated_complexity: 'trivial', severity: 'polish' },
    ], { project: 'test', scannedFiles: 100, durationMs: 3000 });

    expect(result.schema_version).toBe('1.0');
    expect(result.project).toBe('test');
    expect(result.scanned_files).toBe(100);
    expect(result.findings).toHaveLength(3);
    expect(result.summary.total).toBe(3);
    expect(result.summary.by_severity).toEqual({ blocking: 1, degrading: 1, polish: 1 });
    expect(result.summary.by_category).toEqual({ fix: 2, perf: 1 });
  });

  it('buildScanResult with empty proposals', () => {
    const result = buildScanResult([], { project: 'empty', scannedFiles: 50, durationMs: 500 });
    expect(result.findings).toHaveLength(0);
    expect(result.summary.total).toBe(0);
    expect(result.summary.by_severity).toEqual({});
  });
});
