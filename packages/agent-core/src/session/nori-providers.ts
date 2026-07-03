import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { relative } from 'pathe';
import { load as loadYaml } from 'js-yaml';
import type { NoriMemoryProvider, NoriSwarmProvider } from '../tools/builtin/nori/types';
import type { Agent } from '../agent';
import type { QueuedSubagentTask, SubagentResult } from './subagent-batch';

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

interface SwarmCheckDef {
  id: string;
  agent_type: string;
  depends_on: string[];
  on_failure: string;
}

interface SwarmState {
  status: 'running' | 'completed' | 'failed';
  taskCount: number;
  task_results: Record<string, { status: string; output?: { analysis_summary?: string } }>;
}

/* ------------------------------------------------------------------ */
/*  Simple Memory Provider (filesystem-based, Obsidian-style vault)    */
/* ------------------------------------------------------------------ */

class SimpleMemoryProvider implements NoriMemoryProvider {
  constructor(private readonly vaultPath: string) {
    mkdirSync(vaultPath, { recursive: true });
    for (const dir of MEMORY_NOTE_DIRS) {
      mkdirSync(path.join(vaultPath, dir), { recursive: true });
    }
  }

  async multiRetrieve(keywords: string[], options?: {
    top_k?: number;
    type_filter?: string[];
    weights?: { embedding: number; fulltext: number; graph: number };
    link_depth?: number;
  }): Promise<Array<{ title: string; path: string; score?: number; excerpt?: string; content?: string }>> {
    const topK = options?.top_k ?? 10;
    const typeFilter = options?.type_filter;
    const results: Array<{ title: string; path: string; score: number; excerpt: string; content: string }> = [];
    const dirs = typeFilter?.length
      ? unique(typeFilter.flatMap(noteTypeDirs)).map(d => path.join(this.vaultPath, d))
      : [this.vaultPath];
    const seenFiles = new Set<string>();

    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      try {
        for (const fp of this.markdownFiles(dir)) {
          if (seenFiles.has(fp)) continue;
          seenFiles.add(fp);
          const raw = readFileSync(fp, 'utf-8');
          const { title, frontmatter, body } = this.parseFrontmatter(raw);
          const notePath = relative(this.vaultPath, fp).replace(/\\/g, '/');
          const searchable = `${title}\n${notePath}\n${path.basename(fp)}\n${frontmatter}\n${body}`;
          const lower = searchable.toLowerCase();
          let score = 0;
          for (const kw of keywords) {
            const needle = kw.trim().toLowerCase();
            if (needle.length === 0) continue;
            let idx = 0;
            while ((idx = lower.indexOf(needle, idx)) !== -1) { score++; idx++; }
          }
          if (score > 0) {
            results.push({
              title,
              path: notePath,
              score,
              excerpt: body.length > 500 ? body.substring(0, 500) + '...' : body,
              content: body,
            });
          }
        }
      } catch { /* skip inaccessible dirs */ }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  async writeNote(params: {
    note_type: string; title: string; content: string; links?: string[]; tags?: string[];
  }): Promise<{ path: string }> {
    const dir = path.join(this.vaultPath, params.note_type);
    mkdirSync(dir, { recursive: true });
    const dateStr = new Date().toISOString().split('T')[0];
    const safeName = params.title
      .replace(/[<>:\"/\\|?*]/g, '-').replace(/\s+/g, '-').toLowerCase().substring(0, 80);
    const fileName = dateStr + '-' + safeName + '.md';
    const fp = path.join(dir, fileName);

    const tagsYaml = params.tags?.length ? '\ntags: [' + params.tags.join(', ') + ']' : '';
    const linksYaml = params.links?.length ? '\nlinks: [' + params.links.join(', ') + ']' : '';
    const fm = [
      '---', 'title: \"' + params.title + '\"', 'type: ' + params.note_type,
      'date: ' + dateStr,
      ...(tagsYaml ? [tagsYaml.trim()] : []),
      ...(linksYaml ? [linksYaml.trim()] : []),
      '---',
    ].filter(l => l.length > 0).join('\n');

    writeFileSync(fp, fm + '\n\n' + params.content, 'utf-8');
    return { path: relative(this.vaultPath, fp).replace(/\\/g, '/') };
  }

  private markdownFiles(dir: string): string[] {
    const files: string[] = [];
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) continue;
      try {
        for (const entry of readdirSync(current)) {
          const fp = path.join(current, entry);
          const stat = statSync(fp);
          if (stat.isDirectory()) {
            stack.push(fp);
          } else if (stat.isFile() && entry.endsWith('.md')) {
            files.push(fp);
          }
        }
      } catch {
        // Skip inaccessible directories without failing the whole retrieval.
      }
    }
    return files;
  }

  private parseFrontmatter(content: string): { title: string; frontmatter: string; body: string } {
    const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const m = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!m) return { title: 'Untitled', frontmatter: '', body: normalized };
    const frontmatter = m[1] ?? '';
    const body = m[2] ?? '';
    const tm = frontmatter.match(/^title:\s*['"]?(.+?)['"]?\s*$/m);
    return { title: tm?.[1] ?? 'Untitled', frontmatter, body };
  }
}

const MEMORY_NOTE_DIRS = [
  'analysis',
  'decision',
  'decisions',
  'task',
  'tasks',
  'review',
  'reviews',
] as const;

function noteTypeDirs(noteType: string): string[] {
  switch (noteType) {
    case 'analysis':
      return ['analysis'];
    case 'decision':
    case 'decisions':
      return ['decision', 'decisions'];
    case 'task':
    case 'tasks':
      return ['task', 'tasks'];
    case 'review':
    case 'reviews':
      return ['review', 'reviews'];
    default:
      return [noteType];
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/* ------------------------------------------------------------------ */
/*  Concurrent Swarm Provider (SubagentBatch-based)                    */
/* ------------------------------------------------------------------ */

class SimpleSwarmProvider implements NoriSwarmProvider {
  private agent?: Agent;
  private noriConfig?: Record<string, unknown>;
  private readonly activeSwarms = new Map<string, SwarmState>();

  wireToAgent(agent: Agent): void { this.agent = agent; }
  setNoriConfig(config: Record<string, unknown>): void { this.noriConfig = config; }

  private host() {
    if (!this.agent) throw new Error('SwarmProvider not wired to agent');
    return this.agent.subagentHost;
  }

  async launchDag(
    templateName: string,
    params: Record<string, unknown>,
    depth: number,
  ): Promise<{ swarm_id: string }> {
    const h = this.host();
    if (!h) throw new Error('No subagent host available');

    const swarmId = 'swarm_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

    // Build tasks from nori.yaml swarm.checks or fallback templates
    const checkDefs = this.resolveCheckDefs(templateName, params);
    const tasks: QueuedSubagentTask<string>[] = checkDefs.map((check, idx) => ({
      kind: 'spawn' as const,
      data: check.id,
      profileName: this.mapAgentType(check.agent_type),
      parentToolCallId: 'nori-swarm-launch',
      prompt: this.buildCheckPrompt(check, params),
      description: 'swarm:' + check.id,
      swarmIndex: idx,
      swarmItem: check.id,
      runInBackground: false,
    }));

    // Fire-and-forget: launch all tasks concurrently via SubagentBatch
    this.activeSwarms.set(swarmId, {
      status: 'running',
      taskCount: tasks.length,
      task_results: {},
    });

    this.executeSwarm(swarmId, tasks).catch(err => {
      const existing = this.activeSwarms.get(swarmId);
      if (existing) existing.status = 'failed';
    });

    return { swarm_id: swarmId };
  }

  private async executeSwarm(swarmId: string, tasks: QueuedSubagentTask<string>[]): Promise<void> {
    const h = this.host();
    if (!h) return;

    const results: Array<SubagentResult<string>> = await h.runQueued(tasks);
    const taskResults: Record<string, { status: string; output?: { analysis_summary?: string } }> = {};

    for (const r of results) {
      taskResults[r.task.data] = {
        status: r.status,
        output: r.result ? { analysis_summary: r.result } : undefined,
      };
    }

    const allSucceeded = results.every(r => r.status === 'completed');
    this.activeSwarms.set(swarmId, {
      status: allSucceeded ? 'completed' : 'failed',
      taskCount: results.length,
      task_results: taskResults,
    });
  }

  async getStatus(swarmId: string): Promise<{ status: string; results?: Record<string, unknown> }> {
    const s = this.activeSwarms.get(swarmId);
    if (!s) return { status: 'not_found' };
    return { status: s.status, results: s.task_results as Record<string, unknown> };
  }

  async getResult(swarmId: string): Promise<{
    status: string;
    task_results: Record<string, { status: string; output?: { analysis_summary?: string } }>;
  }> {
    const s = this.activeSwarms.get(swarmId);
    if (!s) return { status: 'not_found', task_results: {} };
    return { status: s.status, task_results: s.task_results };
  }

  /* ------------------------------------------------------------------ */
  /*  Task building                                                       */
  /* ------------------------------------------------------------------ */

  /** Resolve which checks to run based on template name. */
  private resolveCheckDefs(templateName: string, params: Record<string, unknown>): SwarmCheckDef[] {
    const checks = this.getConfiguredChecks();

    // If template_name is 'all' or empty, run all checks
    if (!templateName || templateName === 'all' || templateName === 'default') {
      if (checks.length > 0) return checks;
      // Fallback: default coding + testing checks
      return this.defaultChecks(params);
    }

    // Specific template: filter checks by id
    const matching = checks.filter(c => c.id === templateName);
    if (matching.length > 0) return matching;

    // Template not in checks: create a single coder task
    return [{
      id: templateName,
      agent_type: (params['agent_type'] as string | undefined) ?? 'nori-coder',
      depends_on: [],
      on_failure: 'report',
    }];
  }

  /** Default checks when no nori.yaml swarm.checks are defined. */
  private defaultChecks(params: Record<string, unknown>): SwarmCheckDef[] {
    const taskDesc =
      (params['description'] as string | undefined) ??
      (params['prompt'] as string | undefined) ??
      'implementation task';
    return [
      {
        id: 'code_implementation',
        agent_type: 'nori-coder',
        depends_on: [],
        on_failure: 'block',
      },
      {
        id: 'unit_tests',
        agent_type: 'coder',
        depends_on: [],
        on_failure: 'warn',
      },
    ];
  }

  private getConfiguredChecks(): SwarmCheckDef[] {
    const swarm = this.noriConfig?.['swarm'] as Record<string, unknown> | undefined;
    const checks = swarm?.['checks'] as Array<Record<string, unknown>> | undefined;
    if (!checks) return [];
    return checks.map(c => ({
      id: c['id'] as string,
      agent_type: c['agent_type'] as string,
      depends_on: (c['depends_on'] as string[]) ?? [],
      on_failure: c['on_failure'] as string ?? 'report',
    }));
  }

  private mapAgentType(agentType: string): string {
    // coder: writes code (has Write/Edit/Bash, not tools_readonly)
    // nori-coder: read-only orchestrator (plans and delegates)
    // explore: read-only codebase explorer
    // plan: read-only planner
    switch (agentType) {
      case 'coder': return 'coder';
      case 'explore': return 'explore';
      case 'nori-coder': return 'coder';  // swarm coding tasks use coder profile
      case 'plan': return 'plan';
      case 'test': case 'test_check': return 'coder';
      case 'review': case 'style_check': case 'security': return 'explore';
      default: return 'coder';
    }
  }

  private buildCheckPrompt(check: SwarmCheckDef, params: Record<string, unknown>): string {
    const context = (params['context'] as string | undefined) ?? '';
    const taskDesc = (params['description'] as string | undefined) ?? check.id;
    const filesChanged = (params['changed_files'] as string[] | undefined) ?? [];
    const isCoder = check.agent_type === 'coder' || check.agent_type === 'nori-coder';
    const isReviewer = !isCoder;

    let prompt = '';

    if (isCoder) {
      prompt += [
        '# Swarm Task: ' + check.id,
        '',
        '## Role: Coder',
        '',
        'You are a coder sub-agent in a **parallel swarm**. The orchestrator has delegated this implementation task to you. Other swarm agents are working on related tasks concurrently.',
        '',
        '## Core Instructions',
        '',
        '1. **Search memory first.** Call `nori_memory_search` with keywords relevant to this task before writing any code. Check for past decisions, patterns, and related analyses.',
        '2. **Read the codebase.** Use Read/Grep/Glob to understand the relevant files and their context.',
        '3. **Implement the changes.** Use Write/Edit/Bash to make the actual code changes. Follow existing patterns and conventions in the codebase.',
        '4. **Verify your work.** Run relevant tests with Bash. Fix any failures before reporting completion.',
        '5. **Document findings.** Use `nori_memory_write` to record decisions, trade-offs, or patterns discovered during implementation.',
        '',
        '## Important',
        '',
        '- Make **minimal changes** to achieve the goal. No speculative refactors or cleanup.',
        '- Follow the **existing coding style** in the project.',
        '- You have Write/Edit/Bash access 鈥?actually make the changes, do not just describe them.',
        '- If you encounter ambiguity, resolve it yourself based on the codebase context.',
        '- Do NOT ask the end user questions. Report any ambiguity in your summary.',
      ].join('\n');
    } else {
      prompt += [
        '# Swarm Task: ' + check.id,
        '',
        '## Role: Reviewer',
        '',
        'You are a reviewer sub-agent in a **parallel swarm**. Your job is to inspect, verify, and report. Do NOT modify code.',
        '',
        '## Core Instructions',
        '',
        '1. **Search memory.** Call `nori_memory_search` for related decisions, past reviews, and known patterns.',
        '2. **Inspect the code.** Use Read/Grep/Glob to analyze the relevant files.',
        '3. **Evaluate quality.** Check for: correctness, adherence to project conventions, edge cases, test coverage, security concerns, performance issues.',
        '4. **Report findings.** Be specific about issues found. Include file paths and line references.',
        '5. **Document.** Use `nori_memory_write` to record your review findings.',
        '',
        '## Important',
        '',
        '- You are **read-only**. Do not modify any files.',
        '- If you find issues, describe them clearly for the orchestrator to handle.',
        '- If there are no issues, state that explicitly.',
      ].join('\n');
    }

    prompt += '\n\n---\n';
    prompt += '\n## Task Details\n\n';
    prompt += '**Task**: ' + taskDesc;

    if (filesChanged.length > 0) {
      prompt += '\n\n**Relevant files**:';
      for (const f of filesChanged) prompt += '\n- ' + f;
    }

    if (context) {
      prompt += '\n\n**Context from orchestrator**:\n> ' + context.replace(/\n/g, '\n> ');
    }

    prompt += '\n\n## Expected Output\n\n';
    prompt += 'At the end of your turn, provide a clear summary including:\n';
    if (isCoder) {
      prompt += '- What files were changed and why\n';
      prompt += '- Test results (pass/fail)\n';
      prompt += '- Any decisions or trade-offs made\n';
    } else {
      prompt += '- What was inspected\n';
      prompt += '- Issues found (with file:line references)\n';
      prompt += '- Recommendations\n';
    }
    prompt += '- Whether the task is complete or needs follow-up\n';

    return prompt;
  }
}

/* ------------------------------------------------------------------ */
/*  Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Try to load nori.yaml from the given cwd (walks upward).
 * Returns the parsed config object or null if not found.
 */
export function loadNoriYamlConfig(cwd: string): Record<string, unknown> | null {
  let dir = cwd;
  while (dir !== path.parse(dir).root) {
    const noriYaml = path.join(dir, 'nori.yaml');
    if (existsSync(noriYaml)) {
      try {
        const content = readFileSync(noriYaml, 'utf-8');
        return loadYaml(content) as Record<string, unknown>;
      } catch { return null; }
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Create nori providers from a nori.yaml configuration object.
 * Returns null if nori.yaml is not present or has no vault_path configured.
 */
export function createNoriProvidersFromConfig(noriConfig: Record<string, unknown> | null, resolveBaseDir?: string): {
  memory: NoriMemoryProvider;
  swarm: SimpleSwarmProvider;
  maxSwarmDepth: number;
  coderWriteEnabled: boolean;
} | null {
  if (!noriConfig) return null;

  const obsidian = noriConfig['obsidian'] as Record<string, unknown> | undefined;
  const rawVaultPath = (obsidian?.['vault_path'] as string) ?? null;
  if (!rawVaultPath) return null;

    // Resolve relative paths against the directory containing nori.yaml
    const vaultPath = resolveBaseDir ? path.resolve(resolveBaseDir, rawVaultPath) : rawVaultPath;

  const swarm = noriConfig['swarm'] as Record<string, unknown> | undefined;
  const maxSwarmDepth = (swarm?.['max_swarm_depth'] as number) ?? 3;

  const coderWriteEnabled = (swarm?.['coder_write_enabled'] as boolean) ?? false;
  const swarmProvider = new SimpleSwarmProvider();
  swarmProvider.setNoriConfig(noriConfig);

  return {
    memory: new SimpleMemoryProvider(vaultPath),
    swarm: swarmProvider,
    maxSwarmDepth,
    coderWriteEnabled,
  };
}




