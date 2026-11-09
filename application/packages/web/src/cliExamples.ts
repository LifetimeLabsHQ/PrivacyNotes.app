/**
 * What people save with pn: the one list of examples, shown on the homepage
 * (LandingCli.tsx) and in Settings > CLI (CommandLinePane.tsx), in each
 * surface's own look. Each example only adds a note, so each works today.
 * The words are `landing:cli.use<Key>Title` and `landing:cli.use<Key>Body`;
 * the command is what privacynotes takes, the same in every language.
 * Spec: docs/internal/plans/agent-cli.md (section 3.10)
 */
import { BracketsCurly, ClipboardText, ClockCountdown, GitBranch, Plugs, Robot, type Icon } from './icons';

export interface CliExample {
  key: 'Plan' | 'Chat' | 'Nightly' | 'Git' | 'Clip' | 'Tools';
  icon: Icon;
  command: string;
}

export const CLI_EXAMPLES: readonly CliExample[] = [
  { key: 'Plan', icon: Robot, command: 'privacynotes save --tag plan plan.md' },
  { key: 'Chat', icon: Plugs, command: 'privacynotes mcp' },
  { key: 'Nightly', icon: ClockCountdown, command: 'privacynotes save --tag nightly report.md' },
  { key: 'Git', icon: GitBranch, command: 'git log --since=8am | privacynotes save' },
  { key: 'Clip', icon: ClipboardText, command: 'pbpaste | privacynotes save --tag inbox' },
  { key: 'Tools', icon: BracketsCurly, command: 'privacynotes save --json note.md' },
];

export const cliExampleTitle = (key: CliExample['key']) => `landing:cli.use${key}Title` as const;
export const cliExampleBody = (key: CliExample['key']) => `landing:cli.use${key}Body` as const;
