// src/ui/screens/profiles-view.tsx
// Presentational render for the profiles submenu. Pure: renders the current
// step + menu, and calls the handlers passed by the container
// (profiles-screen.tsx). No state or side effects beyond the read-only
// listAccounts/listProfiles lookups the picker needs.

import { Box, Text } from 'ink';
import { Badge, StatusMessage, TextInput } from '@inkjs/ui';
import { list as listAccounts } from '../../accounts/accounts.js';
import { listProfiles } from '../../profiles/profiles.js';
import { ORANGE } from '../theme.js';
import { type MenuItem, profileLabel } from './profiles/menu-items.js';
import { PickList } from './profiles/pick-list.js';
import type { Step } from './profiles-types.js';

interface ProfilesViewProps {
  step: Step;
  items: MenuItem[];
  cursor: number;
  error: string | null;
  accountsDirPath: string;
  onAccountPick: (email: string) => void;
  onProfilePick: (name: string) => void;
  onNameSubmit: (raw: string) => void;
  /** PickList cancel + note/error dismissal route back to the home menu. */
  onCancelToHome: () => void;
}

export function ProfilesView({
  step,
  items,
  cursor,
  error,
  accountsDirPath,
  onAccountPick,
  onProfilePick,
  onNameSubmit,
  onCancelToHome,
}: ProfilesViewProps) {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Badge color={ORANGE}>Profiles</Badge>
        <Text color="gray"> per-terminal isolated sessions</Text>
      </Box>

      {error && (
        <Box marginBottom={1}>
          <StatusMessage variant="error">{error}</StatusMessage>
        </Box>
      )}

      {step.kind === 'home' && (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          {items.map((item, i) => {
            const selected = i === cursor;
            return (
              <Box key={item.value}>
                <Text color={selected ? ORANGE : undefined}>{selected ? '▸ ' : '  '}</Text>
                <Text bold={selected}>{item.label}</Text>
                {item.hint && <Text color="gray">  · {item.hint}</Text>}
              </Box>
            );
          })}
        </Box>
      )}

      {step.kind === 'pick-account' && (
        <PickList<string>
          title={step.purpose === 'isolated' ? 'Open which account isolated?' : 'Import which account?'}
          items={listAccounts(accountsDirPath)}
          keyOf={(a) => a}
          formatLabel={(a) => a}
          onPick={onAccountPick}
          onCancel={onCancelToHome}
        />
      )}

      {step.kind === 'pick-profile' && (
        <PickList<string>
          title={
            step.purpose === 'use' ? 'Use which profile?'
            : step.purpose === 'login' ? 'Authenticate which profile?'
            : 'Remove which profile?'
          }
          items={listProfiles()}
          keyOf={(name) => name}
          formatLabel={(name) => profileLabel(name).label}
          formatHint={(name) => profileLabel(name).hint}
          onPick={onProfilePick}
          onCancel={onCancelToHome}
        />
      )}

      {step.kind === 'enter-name' && (
        <Box flexDirection="column">
          <Text>{step.purpose === 'create' ? 'Profile name' : 'Profile name (Enter for default)'}</Text>
          <Box>
            <Text>› </Text>
            <TextInput
              defaultValue={step.defaultName ?? ''}
              placeholder={step.defaultName ?? 'work, personal, project-x'}
              onSubmit={onNameSubmit}
            />
          </Box>
          {step.error && <StatusMessage variant="error">{step.error}</StatusMessage>}
          <Text color="gray">(esc not supported here — type a name then Enter)</Text>
        </Box>
      )}

      {step.kind === 'confirm-remove' && (
        <Box flexDirection="column">
          <Text>Delete profile "<Text bold>{step.profileName}</Text>" and all its state?</Text>
          <Text color="yellow">(y / n)</Text>
        </Box>
      )}

      {step.kind === 'note' && (
        <Box flexDirection="column" borderStyle="round" borderColor={ORANGE} paddingX={1}>
          <Text bold color={ORANGE}>{step.title}</Text>
          {(() => {
            // De-duplicate identical lines (blank lines especially) before
            // mapping so React keys can be derived from content alone.
            const seen = new Map<string, number>();
            return step.body.split('\n').map((line) => {
              const n = (seen.get(line) ?? 0) + 1;
              seen.set(line, n);
              return <Text key={`${line}#${n}`} color="gray">{line}</Text>;
            });
          })()}
          <Box marginTop={1}>
            <Text color="gray">(enter or esc to go back)</Text>
          </Box>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray">↑↓ select · enter activate · esc back</Text>
      </Box>
    </Box>
  );
}
