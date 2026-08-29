import type { Session, SkillSummary } from '@nori-code/sdk';

import { SkillsSelectorComponent, type SkillPickerItem } from '../components/dialogs/skills-selector';
import { LLM_NOT_SET_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';
import type { KimiSlashCommand } from './types';

export type SkillListSession = Pick<Session, 'listSkills'>;

export interface SkillSlashCommands {
  readonly commands: readonly KimiSlashCommand[];
  readonly commandMap: ReadonlyMap<string, string>;
}

export function isUserActivatableSkill(skill: SkillSummary): boolean {
  return (
    skill.type === undefined ||
    skill.type === 'prompt' ||
    skill.type === 'inline' ||
    skill.type === 'flow'
  );
}

/** Heuristic: SkillSummary has no arguments field. */
export function skillNeedsArguments(skill: SkillSummary): boolean {
  if (skill.type === 'prompt') return true;
  return /[\[$<]/.test(skill.description);
}

export async function showSkillsSelector(host: SlashCommandHost): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }
  let skills: readonly SkillSummary[];
  try {
    skills = await session.listSkills();
  } catch (error) {
    host.showError(`Failed to load skills: ${formatErrorMessage(error)}`);
    return;
  }

  const built = buildSkillSlashCommands(skills);
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const items: SkillPickerItem[] = [];
  for (const command of built.commands) {
    const skillName = built.commandMap.get(command.name) ?? command.name;
    const skill = byName.get(skillName);
    if (skill === undefined) continue;
    items.push({ slashName: command.name, skill });
  }

  host.mountEditorReplacement(
    new SkillsSelectorComponent({
      items,
      onSelect: (item) => {
        if (skillNeedsArguments(item.skill)) {
          host.restoreInputText(`/${item.slashName} `);
          return;
        }
        host.restoreEditor();
        host.sendSkillActivation(session, item.skill.name, '');
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

function compareSkillSlashCommands(a: SkillSummary, b: SkillSummary): number {
  return (
    getSkillSlashCommandGroup(a.source) - getSkillSlashCommandGroup(b.source) ||
    a.name.localeCompare(b.name)
  );
}

function getSkillSlashCommandGroup(source: SkillSummary['source']): number {
  return source === 'builtin' ? 0 : 1;
}

export function buildSkillSlashCommands(skills: readonly SkillSummary[]): SkillSlashCommands {
  const commandMap = new Map<string, string>();
  const sortedSkills = [...skills].toSorted(compareSkillSlashCommands);
  const commands = sortedSkills.filter(isUserActivatableSkill).map((skill) => {
    const commandName =
      skill.source === 'builtin' || skill.isSubSkill === true
        ? skill.name
        : `skill:${skill.name}`;
    commandMap.set(commandName, skill.name);
    return {
      name: commandName,
      aliases: [],
      description: skill.description ?? '',
    };
  });
  return { commands, commandMap };
}
