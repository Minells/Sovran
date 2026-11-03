import type { ApprovalMode } from '../../../src/shared/protocol';
import type { MenuOption } from '../components/primitives';

export interface ApprovalOption extends MenuOption<ApprovalMode> {
  icon: string;
  /** Completes "Act mode · …" in the empty state. */
  summary: string;
  /** Longer explanation for the Settings view. */
  detail: string;
}

/** Single source of truth for how approval modes are named and explained in the UI. */
export const APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  {
    value: 'ask',
    label: 'Ask',
    icon: 'shield',
    description: 'Approve every file change and command',
    summary: 'you approve every change',
    detail: 'Every file change opens a diff for review and every command waits for you. Commands in your allowed list run directly.',
  },
  {
    value: 'edits',
    label: 'Auto-edit',
    icon: 'edit',
    description: 'Apply file changes without asking; commands still ask',
    summary: 'file changes are applied without asking',
    detail: 'File changes are applied right away and can be undone per response. Commands still wait for you unless they are in your allowed list.',
  },
  {
    value: 'auto',
    label: 'Auto',
    icon: 'zap',
    tone: 'warn',
    description: 'Edit and run commands without asking; risky actions still ask',
    summary: 'Sovran acts without asking',
    detail:
      'Sovran edits files and runs commands on its own. It still asks for protected files and for commands that delete, push, publish, use sudo, reach the network, leave the workspace or hide characters. Commands are not sandboxed: use Auto only in repositories you trust.',
  },
];

export const approvalOption = (mode: ApprovalMode): ApprovalOption => APPROVAL_OPTIONS.find((o) => o.value === mode) ?? APPROVAL_OPTIONS[0]!;

export const nextApprovalMode = (mode: ApprovalMode): ApprovalMode => {
  const i = APPROVAL_OPTIONS.findIndex((o) => o.value === mode);
  return APPROVAL_OPTIONS[(i + 1) % APPROVAL_OPTIONS.length]!.value;
};
