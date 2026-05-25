// src/ui/screens/setup-wizard-view.tsx
// Presentational render for the setup wizard. Pure: renders the current step
// and calls the handlers passed by the container (setup-wizard.tsx). No state
// or side effects live here.

import { Box, Text } from 'ink';
import { Badge, ConfirmInput, MultiSelect, StatusMessage, TextInput } from '@inkjs/ui';
import { ORANGE } from '../theme.js';
import { REPLACE_CHAIN_OPTS, type Step, VARIANT_OPTS } from './setup-wizard-types.js';

interface SetupStepViewProps {
  step: Step;
  onManualBinSubmit: (raw: string) => void;
  onPickConfigsSubmit: (selected: string[]) => void;
  /** sl-confirm "yes" → advance to the variant picker. */
  onConfirmStatusLine: () => void;
  /** sl-confirm "no" → finish without installing. */
  onCancelStatusLine: () => void;
}

export function SetupStepView({
  step,
  onManualBinSubmit,
  onPickConfigsSubmit,
  onConfirmStatusLine,
  onCancelStatusLine,
}: SetupStepViewProps) {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Badge color={ORANGE}>claude-switch setup</Badge>
      </Box>

      {step.kind === 'detect-bin' && <Text color={ORANGE}>… looking for the real claude binary</Text>}

      {step.kind === 'manual-bin' && (
        <Box flexDirection="column">
          <StatusMessage variant="warning">No claude binary found on PATH.</StatusMessage>
          <Text color="gray">
            claude-switch needs the path to the real claude CLI. Install Claude Code first if you haven't:
          </Text>
          <Text color="gray">  https://docs.anthropic.com/en/docs/claude-code</Text>
          <Box marginTop={1}>
            <Text>Path (Enter to skip): </Text>
            <TextInput placeholder="/usr/local/bin/claude" onSubmit={onManualBinSubmit} />
          </Box>
          {step.error && <StatusMessage variant="error">{step.error}</StatusMessage>}
        </Box>
      )}

      {step.kind === 'detect-shell' && <Text color={ORANGE}>… detecting shell config</Text>}

      {step.kind === 'no-npm-bin' && (
        <Box flexDirection="column">
          <StatusMessage variant="warning">
            Could not detect the npm global bin directory. Skipping the PATH patch — set it manually.
          </StatusMessage>
        </Box>
      )}

      {step.kind === 'no-shell-config' && (
        <Box flexDirection="column">
          <StatusMessage variant="warning">No shell config detected (.zshrc, .bashrc, fish, …).</StatusMessage>
          <Text color="gray">Add this to your shell config manually:</Text>
          <Text bold>  export PATH="{step.npmBin}:$PATH"</Text>
          <Text color="gray">(enter or esc to continue)</Text>
        </Box>
      )}

      {step.kind === 'pick-configs' && (
        <Box flexDirection="column">
          <Text>Patch which shell config files? (space toggles, enter confirms)</Text>
          <Box marginTop={1}>
            <MultiSelect
              options={step.configs.map((c) => ({ value: c, label: c }))}
              defaultValue={step.configs}
              onSubmit={onPickConfigsSubmit}
            />
          </Box>
          <Text color="gray">(enter with no selection = patch nothing)</Text>
        </Box>
      )}

      {step.kind === 'sl-existing' && (
        <Box flexDirection="column">
          <StatusMessage variant="info">
            Claude Code already has a custom status line.
          </StatusMessage>
          <Text color="gray">  {step.existing.kind === 'foreign' ? step.existing.command : ''}</Text>
          <Text color="gray">
            claude-switch can replace it with the account badge, or chain it with ccstatusline.
          </Text>
          <Text color="gray">(enter or esc to continue)</Text>
        </Box>
      )}

      {step.kind === 'sl-replace-or-chain' && (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          <Text bold>What would you like to do?</Text>
          {REPLACE_CHAIN_OPTS.map((opt, i) => {
            const selected = i === step.cursor;
            return (
              <Box key={opt.value}>
                <Text color={selected ? ORANGE : undefined}>{selected ? '▸ ' : '  '}</Text>
                <Text bold={selected}>{opt.label}</Text>
                {opt.hint && <Text color="gray">  · {opt.hint}</Text>}
              </Box>
            );
          })}
        </Box>
      )}

      {step.kind === 'sl-confirm' && (
        <Box flexDirection="column">
          <Text>Show the active account in Claude Code's status bar?</Text>
          <Box>
            <Text>› </Text>
            <ConfirmInput
              defaultChoice="confirm"
              onConfirm={onConfirmStatusLine}
              onCancel={onCancelStatusLine}
            />
          </Box>
        </Box>
      )}

      {step.kind === 'sl-pick-variant' && (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          <Text bold>Which style?</Text>
          {VARIANT_OPTS.map((opt, i) => {
            const selected = i === step.cursor;
            return (
              <Box key={opt.value}>
                <Text color={selected ? ORANGE : undefined}>{selected ? '▸ ' : '  '}</Text>
                <Text bold={selected}>{opt.label}</Text>
                {opt.hint && <Text color="gray">  · {opt.hint}</Text>}
              </Box>
            );
          })}
        </Box>
      )}

      {step.kind === 'summary' && (
        <Box flexDirection="column" borderStyle="round" borderColor={ORANGE} paddingX={1}>
          <Text bold color={ORANGE}>Summary</Text>
          {step.result.binPath && <Text color="gray">Real claude: {step.result.binPath}</Text>}
          {step.result.patchedConfigs.length > 0 ? (
            <Text color="gray">
              Patched: {step.result.patchedConfigs.map((c) => c.replace(process.env.HOME || '~', '~')).join(', ')}
            </Text>
          ) : (
            <Text color="gray">Shell config: nothing changed</Text>
          )}
          {step.result.statusLineInstalled && (
            <Text color="gray">Status bar: account badge installed</Text>
          )}
          {step.result.patchedConfigs.length > 0 && (
            <Box marginTop={1}>
              <Text color="yellow">Open a new terminal so the PATH update takes effect.</Text>
            </Box>
          )}
          <Text color="gray">(enter or esc to finish)</Text>
        </Box>
      )}

      {step.kind === 'cancelled' && (
        <StatusMessage variant="info">Setup cancelled. (enter or esc to close)</StatusMessage>
      )}
    </Box>
  );
}
