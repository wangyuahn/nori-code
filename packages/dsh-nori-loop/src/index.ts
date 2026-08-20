/**
 * @nori-code/dsh-nori-loop — host plugin.
 *
 * nori loop state-machine prompt orchestration on DeepSeek Harness seams:
 * - `always` rules become a `systemPrompt` section (visible in the request
 *   header / trajectory prompt inspection),
 * - `on_phase` / `on_tool` rules are injected at the next `agent/pre-step`
 *   as durable plugin-source notice messages (visible in chat and
 *   trajectory as context nodes),
 * - Discuss state is folded from the session log's `discuss/mode` events (no
 *   dependency on the preset-scoped Discuss state),
 * - per-agent and per-rule pause/resume via the `nori_rule_control` tool.
 */

import type {
  DshCordisContext,
  DshSessionEvent,
  DshSystemPrompt,
  DshToolDefinition,
  DshToolParameters,
  DshToolsRegistry,
  InjectedMessage,
  NoriCore,
  PreStepDecision,
  PreStepPayload,
} from './types.dsh.js';
import { checkCondition, nextPhase, renderRules, ruleTargetsAgent, type RuleConfig } from './rule-engine.js';

export const name = 'nori-loop';

export const inject: string[] = ['tools'];

interface LoopConfig {
  phases?: string[];
  rules?: { definitions?: RuleConfig[] };
}

const DEFAULT_CONFIG: LoopConfig = { phases: ['discuss', 'implement', 'review'], rules: { definitions: [] } };

export function apply(ctx: DshCordisContext): void {
  const systemPrompt = ctx.get<DshSystemPrompt>('systemPrompt');
  if (systemPrompt === undefined) return;
  const fs = ctx.get('fs');

  // Optional cross-plugin bridge provided by dsh-nori-memory.
  // Read through ctx.get so the row still mounts (with graceful degradation)
  // in contexts where the shared instance is not visible.
  const noriCore: NoriCore = ctx.get<NoriCore>('nori-core') ?? {};

  const state = {
    phases: new Map<string, string>(),
    discussWasActive: new Map<string, boolean>(),
    pausedAgents: new Set<string>(),
    pausedRules: new Set<string>(),
    injected: new Map<string, Set<string>>(),
    pendingRules: new Map<string, string[]>(),
    lastRoot: '',
  };
  const discussFold = new Map<string, { seq: number; active: boolean }>();
  let seq = 0;

  const configCache = new Map<string, LoopConfig>();

  async function loadConfig(root: string): Promise<LoopConfig> {
    const cached = configCache.get(root);
    if (cached !== undefined) return cached;
    let cfg: LoopConfig = DEFAULT_CONFIG;
    if (root.length > 0 && fs !== undefined) {
      try {
        const fsAny = fs as { resolve(p: string, o?: { cwd?: string }): Promise<{ displayPath: string } | undefined>; readText(t: unknown): Promise<string> };
        const target = await fsAny.resolve(`${root.replace(/[\\/]+$/, '')}/nori-harness.json`, { cwd: root });
        if (target !== undefined) {
          const text = await fsAny.readText(target);
          const parsed = JSON.parse(text) as LoopConfig;
          if (parsed !== null && typeof parsed === 'object' && parsed.rules !== undefined) cfg = parsed;
        }
      } catch {
        /* config is optional */
      }
    }
    configCache.set(root, cfg);
    return cfg;
  }

  interface AgentFace {
  id: string;
  session: {
    header?: { cwd?: string; origin?: string };
    events: readonly DshSessionEvent[];
  };
}

function agentKey(agent: { id: string }): string {
    try {
      return String(agent.id);
    } catch {
      return '';
    }
  }

  function isSubagent(agent: { session?: { header?: { origin?: string } } }): boolean {
    try {
      return agent?.session?.header?.origin === 'subagent';
    } catch {
      return false;
    }
  }

  function agentTypeOf(agentId: string): string | undefined {
    try {
      const subagent = noriCore.subagent;
      if (subagent !== undefined && typeof subagent.typeOf === 'function') return subagent.typeOf(agentId);
    } catch {
      /* ignore */
    }
    return undefined;
  }

  function discussActiveOf(agent: { id: string; session: { events: readonly DshSessionEvent[] } }): boolean {
    try {
      const events = agent.session.events;
      const agentId = agentKey(agent);
      let fold = discussFold.get(agentId) ?? { seq: 0, active: false };
      for (let i = fold.seq; i < events.length; i++) {
        const e = events[i];
        if (e !== undefined && e.type === 'discuss/mode' && typeof e.data['active'] === 'boolean') {
          fold = { seq: i + 1, active: e.data['active'] };
        }
      }
      fold = { ...fold, seq: events.length };
      discussFold.set(agentId, fold);
      return fold.active;
    } catch {
      return false;
    }
  }

  function ruleUsable(rule: RuleConfig, isSub: boolean, type: string | undefined): boolean {
    return !state.pausedRules.has(rule.name) && ruleTargetsAgent(rule, isSub, type);
  }

  function injectionMessage(text: string, summary: string): InjectedMessage {
    seq += 1;
    return {
      id: `nori-loop-${seq}-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'nori-loop', form: 'notice', summary },
    };
  }

  async function phaseOf(agent: AgentFace): Promise<{ phase: string; msgs: InjectedMessage[] }> {
    const root = agent.session?.header?.cwd ?? '';
    if (root.length > 0) state.lastRoot = root;
    const cfg = await loadConfig(root);
    const agentId = agentKey(agent);
    const discussActive = discussActiveOf(agent);
    const wasActive = state.discussWasActive.get(agentId) === true;
    const current = state.phases.get(agentId) ?? 'idle';
    const next = nextPhase(discussActive, wasActive, current);
    state.discussWasActive.set(agentId, discussActive);
    const firstSeen = !state.phases.has(agentId);
    if (next !== current && !firstSeen) {
      state.phases.set(agentId, next);
      const isSub = isSubagent(agent);
      const type = isSub ? agentTypeOf(agentId) : undefined;
      const enterRules = (cfg.rules?.definitions ?? []).filter(
        (r) => checkCondition(r.condition, { currentPhase: next, phaseStage: 'enter' }) && ruleUsable(r, isSub, type),
      );
      const exitRules = (cfg.rules?.definitions ?? []).filter(
        (r) => checkCondition(r.condition, { currentPhase: current, phaseStage: 'exit' }) && ruleUsable(r, isSub, type),
      );
      const parts: string[] = [];
      if (current !== 'idle' && exitRules.length > 0) parts.push(renderRules(exitRules));
      if (enterRules.length > 0) parts.push(renderRules(enterRules));
      if (parts.length > 0) {
        return { phase: next, msgs: [injectionMessage(parts.join('\n\n'), `nori phase transition: ${current} -> ${next}`)] };
      }
      return { phase: next, msgs: [] };
    }
    state.phases.set(agentId, next);
    return { phase: next, msgs: [] };
  }

  async function computeInjection(agent: AgentFace): Promise<InjectedMessage[]> {
    const agentId = agentKey(agent);
    const msgs: InjectedMessage[] = [];
    if (state.pausedAgents.has(agentId)) return msgs;
    const root = agent.session?.header?.cwd ?? '';
    const cfg = await loadConfig(root);
    const phaseInfo = await phaseOf(agent);
    msgs.push(...phaseInfo.msgs);
    const pending = state.pendingRules.get(agentId) ?? [];
    if (pending.length > 0) {
      state.pendingRules.set(agentId, []);
      const isSub = isSubagent(agent);
      const type = isSub ? agentTypeOf(agentId) : undefined;
      const matched: RuleConfig[] = [];
      for (const name of pending) {
        const rule = (cfg.rules?.definitions ?? []).find((r) => r.name === name);
        if (rule !== undefined && ruleUsable(rule, isSub, type)) {
          const seen = state.injected.get(agentId) ?? new Set<string>();
          if (!seen.has(name)) matched.push(rule);
        }
      }
      if (matched.length > 0) {
        const seen = state.injected.get(agentId) ?? new Set<string>();
        for (const r of matched) seen.add(r.name);
        state.injected.set(agentId, seen);
        msgs.push(injectionMessage(renderRules(matched), `nori tool-rule fired: ${matched.map((r) => r.name).join(', ')}`));
      }
    }
    return msgs;
  }

  ctx.on('agent/pre-step', async function onPreStep(payload, next) {
    const decision = (await (next as () => Promise<PreStepDecision>)()) as PreStepDecision;
    try {
      const p = payload as PreStepPayload;
      if (decision !== undefined && decision.kind === 'enter' && Array.isArray(decision.messages)) {
        const msgs = await computeInjection(p.agent as unknown as AgentFace);
        if (msgs.length > 0) decision.messages = [...decision.messages, ...msgs];
      }
    } catch {
      /* injection failure must never break the step */
    }
    return decision;
  });

  function toolNameOf(exec: unknown): string | undefined {
    if (exec === undefined || exec === null) return undefined;
    const record = exec as { name?: string; definition?: { name?: string } };
    if (typeof record.name === 'string' && record.name.length > 0) return record.name;
    try {
      if (typeof record.definition?.name === 'string') return record.definition.name;
    } catch {
      /* ignore */
    }
    return undefined;
  }

  function execAgentId(exec: unknown): string | undefined {
    try {
      const record = exec as { agent?: { id: unknown } };
      if (record !== undefined && record.agent !== undefined) return String(record.agent.id);
    } catch {
      /* ignore */
    }
    return undefined;
  }

  ctx.on('tools/pre-execute', function onToolPre(exec, next) {
    try {
      const agentId = execAgentId(exec);
      const name = toolNameOf(exec);
      if (agentId !== undefined && name !== undefined) {
        void loadConfig(state.lastRoot).then((cfg) => {
          const matched = (cfg.rules?.definitions ?? []).filter(
            (r) => checkCondition(r.condition, { currentTool: name, toolStage: 'before' }),
          );
          if (matched.length > 0) {
            const pending = state.pendingRules.get(agentId) ?? [];
            for (const r of matched) if (!pending.includes(r.name)) pending.push(r.name);
            state.pendingRules.set(agentId, pending);
          }
        });
      }
    } catch {
      /* ignore */
    }
    return (next as () => unknown)();
  });

  ctx.on('tools/result', function onToolResult(exec) {
    try {
      const agentId = execAgentId(exec);
      const name = toolNameOf(exec);
      if (agentId !== undefined && name !== undefined) {
        void loadConfig(state.lastRoot).then((cfg) => {
          const matched = (cfg.rules?.definitions ?? []).filter(
            (r) => checkCondition(r.condition, { currentTool: name, toolStage: 'after' }),
          );
          if (name === 'TeamAssign') {
            const t = state.phases.get(agentId);
            if (t !== undefined && t !== 'review') state.phases.set(agentId, 'review');
          }
          if (matched.length > 0) {
            const pending = state.pendingRules.get(agentId) ?? [];
            for (const r of matched) if (!pending.includes(r.name)) pending.push(r.name);
            state.pendingRules.set(agentId, pending);
          }
        });
      }
    } catch {
      /* ignore */
    }
    return undefined;
  });

  systemPrompt.section({
    name: 'nori-rules',
    order: 200,
    text: () => {
      const cfg = configCache.get(state.lastRoot) ?? DEFAULT_CONFIG;
      const always = (cfg.rules?.definitions ?? []).filter((r) => r.condition.type === 'always');
      return always.length > 0 ? `<nori_rules>\n${renderRules(always)}\n</nori_rules>` : '';
    },
  });

  const loopApi = {
    state,
    planFold,
    loadConfig,
    computeInjection,
    phaseOf,
    planActiveOf,
    getPhases(): Record<string, string> {
      const out: Record<string, string> = {};
      for (const [k, v] of state.phases) out[k] = v;
      return out;
    },
    pausedAgents(): string[] {
      return [...state.pausedAgents];
    },
    pausedRules(): string[] {
      return [...state.pausedRules];
    },
    pauseAgent(id: string): boolean {
      state.pausedAgents.add(id);
      return true;
    },
    resumeAgent(id: string): boolean {
      state.pausedAgents.delete(id);
      return true;
    },
    pauseRule(name: string): boolean {
      state.pausedRules.add(name);
      return true;
    },
    resumeRule(name: string): boolean {
      state.pausedRules.delete(name);
      return true;
    },
    resetAgent(agentId: string): void {
      state.phases.delete(agentId);
      state.planWasActive.delete(agentId);
      state.injected.delete(agentId);
      state.pendingRules.delete(agentId);
      planFold.delete(agentId);
    },
  };
  noriCore.loop = loopApi;

  const tools = ctx.get<DshToolsRegistry>('tools');
  if (tools === undefined) return;

  const controlTool: DshToolDefinition = {
    name: 'nori_rule_control',
    description:
      'Control the nori loop prompt-insertion system: list current phases/pauses, or pause/resume rule injection for one agent (by session id) or one rule (by name). Paused agents stop receiving boundary rule injections; always-on sections remain.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'pause', 'resume'] },
        agent: { type: 'string' },
        rule: { type: 'string' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: DshToolParameters): Promise<string> {
      try {
        const action = String(args['action']);
        if (action === 'list') {
          return JSON.stringify({ phases: loopApi.getPhases(), pausedAgents: loopApi.pausedAgents(), pausedRules: loopApi.pausedRules() }, null, 1);
        }
        if (action === 'pause') {
          if (typeof args['agent'] === 'string' && args['agent'].length > 0) {
            loopApi.pauseAgent(args['agent']);
            return `paused injections for agent ${args['agent']}`;
          }
          if (typeof args['rule'] === 'string' && args['rule'].length > 0) {
            loopApi.pauseRule(args['rule']);
            return `paused rule ${args['rule']}`;
          }
          return 'Error: pause requires agent or rule';
        }
        if (action === 'resume') {
          if (typeof args['agent'] === 'string' && args['agent'].length > 0) {
            loopApi.resumeAgent(args['agent']);
            return `resumed injections for agent ${args['agent']}`;
          }
          if (typeof args['rule'] === 'string' && args['rule'].length > 0) {
            loopApi.resumeRule(args['rule']);
            return `resumed rule ${args['rule']}`;
          }
          return 'Error: resume requires agent or rule';
        }
        return 'Error: unknown action';
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };

  tools.register(controlTool);
}
