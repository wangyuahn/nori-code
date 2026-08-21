import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

export type SettingsSelection =
  | 'model'
  | 'theme'
  | 'editor'
  | 'permission'
  | 'experiments'
  | 'upgrade'
  | 'usage'
  | 'coder-write'
  | 'note-rules'
  | 'read-only'
  | 'workflow'
  | 'team';

const SETTINGS_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'model',
    label: 'Model',
    description: 'Switch the active model and thinking mode.',
  },
  {
    value: 'permission',
    label: 'Permission',
    description: 'Choose how tool actions are approved.',
  },
  {
    value: 'theme',
    label: 'Theme',
    description: 'Change the terminal UI theme.',
  },
  {
    value: 'editor',
    label: 'Editor',
    description: 'Set the external editor command.',
  },
  {
    value: 'experiments',
    label: 'Experiments',
    description: 'Turn experimental features on or off.',
  },
  {
    value: 'upgrade',
    label: 'Automatic updates',
    description: 'Turn automatic CLI updates on or off.',
  },
  {
    value: 'usage',
    label: 'Usage',
    description: 'Show session tokens, context window, and plan quotas.',
  },
  {
    value: 'coder-write',
    label: 'Coder Write',
    description: 'Allow nori-coder agents to write code directly.',
  },
  {
    value: 'note-rules',
    label: 'Note Rules',
    description: 'Require analysis/decision notes before proceeding.',
  },
  {
    value: 'read-only',
    label: 'Read-only Mode',
    description: 'Toggle main agent write permission.',
  },
  {
    value: 'workflow',
    label: 'Workflow',
    description: 'Configure review gate thresholds and auto-review behavior.',
  },
  {
    value: 'team',
    label: 'Team',
    description: 'Configure the team engineering tree, such as the maximum department depth.',
  },
];

function isSettingsSelection(value: string): value is SettingsSelection {
  return (
    value === 'model' ||
    value === 'theme' ||
    value === 'editor' ||
    value === 'permission' ||
    value === 'experiments' ||
    value === 'upgrade' ||
    value === 'usage' ||
    value === 'coder-write' ||
    value === 'note-rules' ||
    value === 'read-only' ||
    value === 'workflow' ||
    value === 'team'
  );
}

export interface SettingsSelectorOptions {
  readonly onSelect: (value: SettingsSelection) => void;
  readonly onCancel: () => void;
}

export class SettingsSelectorComponent extends ChoicePickerComponent {
  constructor(opts: SettingsSelectorOptions) {
    super({
      title: 'Settings',
      options: [...SETTINGS_OPTIONS],
      onSelect: (value) => {
        if (isSettingsSelection(value)) opts.onSelect(value);
      },
      onCancel: opts.onCancel,
    });
  }
}
