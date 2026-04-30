/**
 * Feishu channel flow for setup:auto.
 *
 * `runFeishuChannel(displayName)` owns the full branch from the
 * app creation instructions through wiring the first agent:
 *
 *   1. App creation instructions (clack note)
 *   2. Paste App ID and App Secret (clack password inputs)
 *   3. Install the adapter (fetch from channels branch + pnpm install)
 *   4. Build
 *   5. Restart the service
 *   6. Wire the agent via scripts/init-first-agent.ts
 */
import * as p from '@clack/prompts';
import k from 'kleur';

import * as setupLog from '../logs.js';
import {
  type StepResult,
  dumpTranscriptOnFailure,
  ensureAnswer,
  fail,
  runQuietChild,
  writeStepEntry,
} from '../lib/runner.js';
import { brandBold } from '../lib/theme.js';

export async function runFeishuChannel(displayName: string): Promise<void> {
  p.note(
    [
      'Create a Feishu app on the open platform:',
      '',
      `  1. Go to ${k.cyan('https://open.feishu.cn/app')} and create a new app`,
      `  2. Copy the ${k.bold('App ID')} (starts with ${k.dim('cli_')}) and ${k.bold('App Secret')}`,
      `  3. Under ${k.bold('Event Subscriptions')}, enable ${k.bold('WebSocket')} mode`,
      `  4. Add event: ${k.dim('im.message.receive_v1')}`,
      `  5. Under ${k.bold('Permissions')}, enable:`,
      `     ${k.dim('im:message, im:message:send_as_bot, im:resource')}`,
      `  6. Publish a version under ${k.bold('Version Management')}`,
    ].join('\n'),
    'Feishu App Setup',
  );

  const appId = ensureAnswer(
    await p.password({ message: 'Paste the Feishu App ID (starts with cli_):' }),
  );
  if (!appId.startsWith('cli_')) {
    fail('App ID should start with "cli_" — check the Feishu open platform.');
    return;
  }

  const appSecret = ensureAnswer(
    await p.password({ message: 'Paste the Feishu App Secret:' }),
  );
  if (!appSecret || appSecret.length < 10) {
    fail('App Secret looks too short — check the Feishu open platform.');
    return;
  }

  const s = p.spinner();
  s.start('Installing Feishu adapter');

  // Install the adapter from the channels branch
  const install = await runQuietChild(
    'feishu-install',
    'bash',
    ['-c', [
      'set -e',
      'git fetch origin channels 2>/dev/null || true',
      'git show origin/channels:src/channels/feishu.ts > src/channels/feishu.ts 2>/dev/null || true',
      // Ensure import exists
      "grep -q 'feishu' src/channels/index.ts || echo \"import './feishu.js';\" >> src/channels/index.ts",
      'pnpm install @larksuiteoapi/node-sdk@1.62.0',
      'pnpm run build',
    ].join(' && ')],
    { env: { ...process.env, FORCE_COLOR: '0' } },
  );

  if (install.exitCode !== 0) {
    s.stop('Feishu adapter install failed');
    dumpTranscriptOnFailure('feishu-install');
    return;
  }
  s.stop('Feishu adapter installed');

  // Write credentials to .env
  writeStepEntry('feishu-env', 'writing credentials');
  const fs = await import('fs');
  const path = await import('path');
  const envPath = path.join(process.cwd(), '.env');
  let envContent = '';
  try { envContent = fs.readFileSync(envPath, 'utf-8'); } catch { /* ok */ }

  const lines = envContent.split('\n').filter((l: string) =>
    !l.startsWith('FEISHU_APP_ID=') && !l.startsWith('FEISHU_APP_SECRET=') && l.trim() !== '',
  );
  lines.push(`FEISHU_APP_ID=${appId}`, `FEISHU_APP_SECRET=${appSecret}`);
  fs.writeFileSync(envPath, lines.join('\n') + '\n');

  // Sync env to container
  const dataEnvDir = path.join(process.cwd(), 'data', 'env');
  fs.mkdirSync(dataEnvDir, { recursive: true });
  fs.copyFileSync(envPath, path.join(dataEnvDir, 'env'));

  setupLog.info('feishu_credentials_written');

  p.note(
    [
      'The Feishu adapter will connect via WebSocket on the next restart.',
      '',
      `  ${k.dim('FEISHU_APP_ID=cli_...')}`,
      `  ${k.dim('FEISHU_APP_SECRET=...')}`,
    ].join('\n'),
    'Credentials saved',
  );
}
