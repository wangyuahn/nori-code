import { z } from 'zod';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';

import type { Agent } from '../../../agent';
import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';

const PLAN_DIRS = ['docs', 'plans', '.nori-code', '.opencode', 'design', 'specs'];
const PLAN_EXTENSIONS = ['.md', '.txt', '.yaml', '.yml', '.json', '.toml'];

const InputSchema = z.object({
  file_path: z.string().describe(
    'Relative project path such as docs/plan.md or plans/task.md. In plan mode, this is only a label: the tool writes to the active session plan file required by ExitPlanMode.',
  ),
  content: z.string().describe('Content to write'),
});

type Input = z.infer<typeof InputSchema>;

export class NoriPlanWriteTool implements BuiltinTool<Input> {
  readonly name = 'nori_plan_write' as const;
  readonly description = [
    'Write plan documents, analysis files, and design specs to the project workspace.',
    'When plan mode is active, this tool always writes to the current session plan file used by ExitPlanMode, even if file_path is plans/name.md.',
    'This tool is NOT blocked by read-only mode — it is specifically for documentation.',
    `Allowed directories: ${PLAN_DIRS.join(', ')}`,
    `Allowed extensions: ${PLAN_EXTENSIONS.join(', ')}`,
    'Use this to write plans, ADRs, analysis docs, design specs.',
    'Do NOT use this for source code files (use nori_swarm_launch instead).',
  ].join('\n');

  readonly parameters: Record<string, unknown> = toInputJsonSchema(InputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(input: Input): ToolExecution {
    const validated = InputSchema.parse(input);
    const filePath = validated.file_path;

    if (this.agent.planMode.isActive) {
      const activePlanFilePath = this.agent.planMode.planFilePath;
      if (activePlanFilePath === null || activePlanFilePath.length === 0) {
        return {
          output:
            'Plan mode is active but no current plan file path is available. Wait for the host to provide a plan file path before calling nori_plan_write or ExitPlanMode.',
          isError: true,
        };
      }

      return {
        accesses: ToolAccesses.none(),
        description: `Writing plan to ${activePlanFilePath}`,
        approvalRule: this.name,
        execute: (ctx) => this.execution(validated, activePlanFilePath, true, ctx),
      };
    }

    const ext = extname(filePath);
    if (!PLAN_EXTENSIONS.includes(ext)) {
      return {
        output: `Extension "${ext}" is not allowed for plan files. Allowed: ${PLAN_EXTENSIONS.join(', ')}`,
        isError: true,
      };
    }

    const firstDir = filePath.split('/')[0];
    if (!PLAN_DIRS.some(d => filePath.startsWith(d + '/') || filePath === d || firstDir === d)) {
      return {
        output: `Path "${filePath}" is not allowed. Plan files must be in: ${PLAN_DIRS.join(', ')}`,
        isError: true,
      };
    }

    const targetPath = this.projectPlanPath(filePath);
    return {
      accesses: ToolAccesses.none(),
      description: `Writing plan to ${targetPath}`,
      approvalRule: this.name,
      execute: (ctx) => this.execution(validated, targetPath, false, ctx),
    };
  }

  private async execution(
    args: Input,
    targetPath: string,
    usingActivePlanFile: boolean,
    _context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const { file_path: filePath, content } = args;
    try {
      if (!usingActivePlanFile && !this.isInsideProject(targetPath)) {
        return { output: 'Path must be within the project workspace.', isError: true };
      }

      await this.agent.kaos.mkdir(dirname(targetPath), { parents: true, existOk: true });
      await this.agent.kaos.writeText(targetPath, content);

      return {
        output: usingActivePlanFile && targetPath !== filePath
          ? `Plan written to ${targetPath} (active plan file; requested ${filePath})`
          : `Plan written to ${targetPath}`,
      };
    } catch (err: any) {
      return { output: `Failed to write plan: ${err.message}`, isError: true };
    }
  }

  private projectPlanPath(filePath: string): string {
    return resolve(this.agent.config.cwd, filePath);
  }

  private isInsideProject(targetPath: string): boolean {
    const relPath = relative(this.agent.config.cwd, targetPath);
    return relPath !== '..' && !relPath.startsWith(`..${this.pathSeparator()}`) && !isAbsolute(relPath);
  }

  private pathSeparator(): string {
    return this.agent.kaos.pathClass() === 'win32' ? '\\' : '/';
  }
}
