import dotenv from 'dotenv';
import chalk from 'chalk';
import readline from 'readline';
import path from 'path';
import fs from 'fs';
import axios from 'axios';

// Load .env from process.cwd() first
dotenv.config();

// Fallback to the CLI installation folder if variables are not set
if (!process.env.JULES_API_KEY || !process.env.GITHUB_TOKEN) {
  dotenv.config({ path: path.join(__dirname, '../.env') });
}

export const config = {
  JULES_API_KEY: process.env.JULES_API_KEY,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  JULES_API_URL: process.env.JULES_API_URL || 'https://jules.googleapis.com/v1alpha',
};

export function validateEnv() {
  if (!config.JULES_API_KEY) {
    console.error(chalk.red('✗ ') + chalk.white('JULES_API_KEY is not set in .env'));
    process.exit(1);
  }
  if (!config.GITHUB_TOKEN) {
    console.error(chalk.red('✗ ') + chalk.white('GITHUB_TOKEN is not set in .env'));
    process.exit(1);
  }
}

// ── Logger — Claude Code style ────────────────────────────────────────────────
export const logger = {
  info:    (msg: string) => console.log(chalk.dim('  ' + msg)),
  success: (msg: string) => console.log(chalk.green('✓ ') + chalk.white(msg)),
  warn:    (msg: string) => console.log(chalk.yellow('⚠ ') + chalk.yellow(msg)),
  error:   (msg: string) => console.error(chalk.red('✗ ') + chalk.white(msg)),
  step:    (msg: string) => console.log(chalk.cyan('⎿ ') + chalk.dim(msg)),
  tool:    (icon: string, msg: string) => console.log(chalk.dim(`  ${icon} ${msg}`)),
};

export async function downloadFile(url: string, destPath: string) {
  const writer = fs.createWriteStream(destPath);
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream'
  });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

const SETTINGS_FILE = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.jules_settings.json');

export function loadSettings() {
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch (e) {
      return {};
    }
  }
  return {};
}

export function saveSettings(settings: any) {
  try {
    const current = loadSettings();
    const updated = { ...current, ...settings };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2));
  } catch (e) {
    logger.warn('Failed to save settings.');
  }
}

// ── Banner — Modern Jules CLI style ──────────────────────────────────────────
export async function printBanner(
  project: string = 'default-project',
  branch: string = 'main',
  mode: string = 'FAST',
  shadowUrl: string | null = null,
  sessionId: string | null = null,
  sessionUrl: string | null = null
) {
  const cols = process.stdout.columns || 80;
  const purple = chalk.hex('#7C3AED');
  const boldPurple = purple.bold;

  const octopusBase = [
    '     ▄████████▄',
    '    ███▀    ▀███',
    '   ███  ●  ●  ███',
    '   ███        ███',
    '  ▄███  █  █  ███▄',
    ' █████  █  █  █████'
  ];

  const frames = [
    ' ▀███▀  ▀  ▀  ▀███▀', // Frame 1: Standard
    ' ▀███▀  ▄  ▄  ▀███▀', // Frame 2: Down/Flat
    ' ▀███▀  ■  ■  ▀███▀'  // Frame 3: Pulse/Mid
  ];

  const titleLines = [
    '      _ _   _   _ _      _____ ____       ____ _     ___ ',
    '     | | | | | | | |    | ____/ ___|     / ___| |   |_ _|',
    '  _  | | | | | | | |    |  _| \\___ \\    | |   | |    | | ',
    ' | |_| | | |_| | | |___ | |___ ___) |   | |___| |___ | | ',
    '  \\___/|_|  \\___/|_____||_____|____/     \\____|_____|___|'
  ];

  const center = (text: string, width: number) => {
    const space = Math.max(0, Math.floor((cols - width) / 2));
    return ' '.repeat(space) + text;
  };

  let finalSessionId = sessionId;
  if ((!finalSessionId || finalSessionId === '(none)') && sessionUrl) {
    const parts = sessionUrl.split('/').filter(Boolean);
    if (parts.length > 0) {
      finalSessionId = parts[parts.length - 1];
    }
  }

  const draw = (frameIndex: number, isFinal: boolean = false) => {
    // Clear screen and move to top
    process.stdout.write('\u001b[H\u001b[J');

    // 1. Center Octopus
    octopusBase.forEach(line => {
      console.log(center(purple(line).replace(/●/g, chalk.bold.white('●')), 19));
    });
    console.log(center(purple(frames[frameIndex]), 19));

    if (isFinal) {
      console.log('');
      // 2. Center Title (Standard font)
      titleLines.forEach(line => {
        console.log(center(chalk.bold.white(line), 58));
      });

      // 3. Center Badge line
      const badge = chalk.bgHex('#7C3AED').bold.white(' JULES  C L I ');
      const subtitle = chalk.dim('  —  research preview Developer: Rev');
      const badgeLineLength = 14 + subtitle.replace(/\x1b\[[0-9;]*m/g, '').length;
      console.log('\n' + center(badge + subtitle, badgeLineLength));

      // 4. Info Section
      const divider = chalk.dim('  ' + '─'.repeat(Math.min(cols - 4, 50)));
      console.log('\n' + divider);
      
      const printInfo = (label: string, value: string, icon: string, isUrl: boolean = false) => {
        const paddedLabel = label.padEnd(11);
        const labelText = chalk.cyan(paddedLabel);
        const valueText = isUrl ? chalk.yellow.underline(value) : chalk.white(value);
        console.log(`  ${icon} ${labelText} : ${valueText}`);
      };

      printInfo('Project', project, '📁');
      printInfo('Branch', branch, '🌿');
      printInfo('Mode', mode.toUpperCase(), '⚡');
      
      if (shadowUrl) {
        // Mask GitHub token: https://TOKEN@github.com -> https://*** @github.com
        let displayUrl = shadowUrl.replace(/([^:]+:\/\/)?([^@]+)@/, '$1*** @');
        if (displayUrl.length > 45) {
          displayUrl = displayUrl.substring(0, 42) + '...';
        }
        printInfo('Shadow', displayUrl, '🔗');
      } else {
        printInfo('Shadow', '(none)', '🔗');
      }

      printInfo('Session ID', finalSessionId || '(none)', '🆔');
      
      // Print Session URL on same line, no wrapping
      const sessionLabel = chalk.cyan('🌐 Session URL : ');
      const sessionVal = sessionUrl ? chalk.yellow(sessionUrl) : chalk.white('(none)');
      console.log(`  ${sessionLabel}${sessionVal}`);

      console.log(divider);
      console.log(chalk.dim('  /help for commands · /exit to quit\n'));
    }
  };

  // Animation logic: 3 loops of 3 frames
  for (let loop = 0; loop < 3; loop++) {
    for (let frame = 0; frame < 3; frame++) {
      draw(frame);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }

  // Final static frame
  draw(0, true);
}



export const shellState = {
  activeRl: null as readline.Interface | null,
  shellLineHandler: null as ((line: string) => Promise<void>) | null,
  keypressHandler: null as ((char: any, key: any) => void) | null,
  trackedSessionId: null as string | null,
  trackedSessionUrl: null as string | null,
  diffPending: false,
  isBottomAreaRendered: false,
  octopusInterval: null as NodeJS.Timeout | null,
  animationFrame: 0,
  isRestarting: false,
};

export function askUser(query: string): Promise<string> {
  process.stdin.resume();

  if (shellState.activeRl && shellState.shellLineHandler) {
    shellState.activeRl.off('line', shellState.shellLineHandler);
    if (shellState.keypressHandler) {
      process.stdin.removeListener('keypress', shellState.keypressHandler);
    }
    shellState.activeRl.resume();
    return new Promise(resolve => {
      shellState.activeRl!.question(query, (ans) => {
        shellState.activeRl!.pause();
        shellState.activeRl!.on('line', shellState.shellLineHandler!);
        if (shellState.keypressHandler) {
          process.stdin.on('keypress', shellState.keypressHandler);
        }
        resolve(ans);
      });
    });
  } else {
    let rl;
    try {
      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: process.stdin.isTTY
      });
    } catch (e) {
      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
      });
    }
    return new Promise(resolve => {
      rl.question(query, (ans) => {
        rl.close();
        resolve(ans);
      });
    });
  }
}

export function closeAskUser() {
  // No-op as we now close interfaces per-call in non-shell mode
}
