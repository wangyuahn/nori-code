---
title: "Bug: coder_write_enabled in nori.yaml is dead config"
type: analysis
date: 2026-07-02
tags: [bug, nori-yaml, coder-write, dead-config]
links: [nori.yaml]
---

## Summary

The `swarm.coder_write_enabled` field in `nori.yaml` is never read by any code. It is dead config.

## Evidence

### 1. TypeScript type missing the field
`packages/komi-core/src/types.ts:60-65`:
```typescript
export interface SwarmConfig {
  max_concurrency: number;
  max_swarm_depth: number;
  default_timeout: number;
  checks: SwarmCheckDef[];
  // ❌ coder_write_enabled is NOT here
}
```

### 2. nori.yaml parsing ignores it
`packages/agent-core/src/session/nori-providers.ts:411-412`:
```typescript
const swarm = noriConfig['swarm'] as Record<string, unknown> | undefined;
const maxSwarmDepth = (swarm?.['max_swarm_depth'] as number) ?? 3;
// ❌ coder_write_enabled is never read
```

### 3. Only working path is TUI slash command
The only way to enable coder write is `/setting coder write on` in the TUI, which sets `agent.coderWriteEnabled = true` on the main agent, then inherited by subagents via:
- `subagent-host.ts:489`: `child.coderWriteEnabled = parent.coderWriteEnabled`
- `ReadonlyPermissionPolicy` in `tools-readonly-deny.ts:15`: `if (this.agent.coderWriteEnabled) return;`

## Fix

1. Add `coder_write_enabled: boolean` to `SwarmConfig` type in `komi-core/src/types.ts`
2. Read it in `nori-providers.ts` and apply it when creating agents or setting up the session
3. Apply it as the default value for `agent.coderWriteEnabled` during main agent construction

## Related Files
- [[nori.yaml]] - config definition
- `packages/komi-core/src/types.ts` - SwarmConfig type
- `packages/agent-core/src/session/nori-providers.ts` - nori.yaml parsing
- `packages/agent-core/src/session/subagent-host.ts` - subagent inheritance
- `packages/agent-core/src/agent/permission/policies/tools-readonly-deny.ts` - permission check
