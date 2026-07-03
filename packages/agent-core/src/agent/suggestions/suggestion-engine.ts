/* ------------------------------------------------------------------ */
/*  Suggestion                                                          */
/* ------------------------------------------------------------------ */

export interface Suggestion {
  /** Unique identifier for deduplication within a session. */
  id: string;
  priority: 'high' | 'medium' | 'low';
  category: 'memory' | 'swarm' | 'review' | 'documentation' | 'quality';
  message: string;
  /** Optional tool name to suggest calling. */
  action?: string;
  /** Whether this suggestion is pending user approval before injection. */
  pending: boolean;
}

/* ------------------------------------------------------------------ */
/*  SuggestionContext                                                    */
/* ------------------------------------------------------------------ */

export interface SuggestionContext {
  currentTurn: {
    /** All tool names called in this turn. */
    toolsCalled: string[];
    /** Number of nori_memory_write calls. */
    memoryWriteCount: number;
    /** Number of nori_swarm_launch calls. */
    swarmLaunchCount: number;
    /** Number of nori_swarm_result / nori_swarm_status calls. */
    swarmResultCheckCount: number;
    /** Number of files created (Write tool calls). */
    filesCreated: number;
    /** Number of test files created. */
    testFilesCreated: number;
    /** Whether an ADR (decision-type note) was written this turn. */
    adrWritten: boolean;
  };
  /** Present when a phase transition just occurred. */
  phaseTransition?: {
    from: string;
    to: string;
  };
  /** The stop reason from the agent step. */
  stopReason: string;
}

/* ------------------------------------------------------------------ */
/*  SuggestionEngine                                                     */
/* ------------------------------------------------------------------ */

export class SuggestionEngine {
  /** Track suggestion IDs already shown to avoid repeated injections. */
  private shownSuggestions: Set<string> = new Set();

  /**
   * Generate suggestions based on the given context.
   * Suggestions already shown in this session are excluded.
   */
  generateSuggestions(context: SuggestionContext): Suggestion[] {
    const suggestions: Suggestion[] = [];

    // 1. If nori_memory_write was not called this turn → suggest writing notes
    if (context.currentTurn.memoryWriteCount <= 0) {
      this.addIfNew(suggestions, {
        id: 'write-analysis-note',
        priority: 'medium',
        category: 'memory',
        message:
          'Consider writing an analysis note to record your findings.',
        action: 'nori_memory_write',
        pending: true,
      });
    }

    // 2. If files were created and notes were written but no ADR → suggest ADR
    if (
      context.currentTurn.filesCreated > 0 &&
      context.currentTurn.memoryWriteCount > 0 &&
      !context.currentTurn.adrWritten
    ) {
      this.addIfNew(suggestions, {
        id: 'write-adr',
        priority: 'medium',
        category: 'documentation',
        message:
          'You made an architecture decision. Consider writing an ADR via nori_memory_write to decisions/.',
        action: 'nori_memory_write',
        pending: true,
      });
    }

    // 3. Swarm launched but results not checked
    if (
      context.currentTurn.swarmLaunchCount > 0 &&
      context.currentTurn.swarmResultCheckCount <= 0
    ) {
      this.addIfNew(suggestions, {
        id: 'check-swarm-results',
        priority: 'high',
        category: 'swarm',
        message:
          'Swarm results are ready. Review them before proceeding.',
        action: 'nori_swarm_result',
        pending: true,
      });
    }

    // 4. New files created but no tests written
    if (
      context.currentTurn.filesCreated > 0 &&
      context.currentTurn.testFilesCreated <= 0
    ) {
      this.addIfNew(suggestions, {
        id: 'run-swarm-check',
        priority: 'medium',
        category: 'quality',
        message:
          'New files created. Consider running a swarm check to verify.',
        action: 'nori_swarm_launch',
        pending: true,
      });
    }

    // 5. Phase transition: implement → review
    if (
      context.phaseTransition?.from === 'implement' &&
      context.phaseTransition?.to === 'review'
    ) {
      this.addIfNew(suggestions, {
        id: 'phase-review-enter',
        priority: 'medium',
        category: 'review',
        message:
          'Implementation complete. The review phase will automatically run tests and swarm checks.',
        pending: true,
      });
    }

    // 6. Always: search past decisions
    this.addIfNew(suggestions, {
      id: 'search-past-decisions',
      priority: 'low',
      category: 'memory',
      message:
        'When in doubt, nori_memory_search for related past decisions.',
      action: 'nori_memory_search',
      pending: true,
    });

    return suggestions;
  }

  /**
   * Format a list of suggestions into a system-reminder block
   * ready for injection into the LLM context.
   */
  formatSuggestions(suggestions: Suggestion[]): string {
    if (suggestions.length === 0) return '';

    const priorityMark = (p: Suggestion['priority']): string => {
      switch (p) {
        case 'high':
          return '[HIGH]';
        case 'medium':
          return '[MED]';
        case 'low':
          return '[LOW]';
      }
    };

    const needsApproval = suggestions.some((s) => s.pending);
    const approvalAttr = needsApproval ? ' needs_approval="true"' : '';

    const lines = suggestions.map(
      (s) => {
        const actionHint = s.action ? ` (try: \`${s.action}\`)` : '';
        const pendingMark = s.pending ? ' [⏳]' : '';
        return `- ${priorityMark(s.priority)} [${s.category}]${pendingMark} ${s.message}${actionHint}`;
      },
    );

    return [
      `<suggestions_pending${approvalAttr}>`,
      '## Post-Task Suggestions',
      '',
      needsApproval
        ? 'These suggestions require user approval before being shown to the agent. Review in /setting panel.'
        : 'The following suggestions are advisory only — you decide whether to follow them:',
      '',
      ...lines,
      '</suggestions_pending>',
    ].join('\n');
  }

  /**
   * Clear all shown-suggestion tracking (e.g. across sessions).
   */
  reset(): void {
    this.shownSuggestions.clear();
  }

  /* ------------------------------------------------------------------ */
  /*  Private helpers                                                     */
  /* ------------------------------------------------------------------ */

  private addIfNew(
    suggestions: Suggestion[],
    suggestion: Suggestion,
  ): void {
    if (!this.shownSuggestions.has(suggestion.id)) {
      this.shownSuggestions.add(suggestion.id);
      suggestions.push(suggestion);
    }
  }
}
