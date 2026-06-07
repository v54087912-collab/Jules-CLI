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

// ── Banner — Claude Code style ────────────────────────────────────────────────
export function printBanner() {
  const cols = process.stdout.columns || 80;
  const cwd = process.cwd();
  
  const welcome = '✻ Welcome to Jules CLI research preview!';
  const helpHint = '/help for help';

  const welcomeLength = welcome.length;
  const helpHintLength = helpHint.length;
  const rawCwdLength = `cwd: ${cwd}`.length;

  const innerWidth = Math.max(welcomeLength, helpHintLength, rawCwdLength) + 2;
  const width = Math.min(cols - 2, Math.max(50, innerWidth));

  let displayCwd = cwd;
  const maxCwdLength = width - 8;
  if (cwd.length > maxCwdLength) {
    displayCwd = '...' + cwd.substring(cwd.length - maxCwdLength + 3);
  }
  const cwdLine = `cwd: ${displayCwd}`;

  const padLine = (text: string) => {
    // Keep '✻ Welcome' in normal dim text, but make sure styling length doesn't throw off spacing
    const cleanText = text.replace(/\x1b\[[0-9;]*m/g, '');
    const spacesCount = Math.max(0, width - cleanText.length - 2);
    return chalk.dim('│ ') + chalk.dim(text) + ' '.repeat(spacesCount) + chalk.dim(' │');
  };

  const top = chalk.dim('╭' + '─'.repeat(width) + '╮');
  const bottom = chalk.dim('╰' + '─'.repeat(width) + '╯');

  console.log('');
  console.log(top);
  console.log(padLine(welcome));
  console.log(padLine(''));
  console.log(padLine(helpHint));
  console.log(padLine(''));
  console.log(padLine(cwdLine));
  console.log(bottom);

  console.log(chalk.bold.white('\nTips for getting started:'));
  console.log(chalk.white('1. Run ') + chalk.bold.cyan('/init') + chalk.white(' to link this directory to a shadow repository'));
  console.log(chalk.white('2. Type your coding instruction and press ') + chalk.bold('Enter') + chalk.white(' to edit files\n'));
}

export const shellState = {
  activeRl: null as readline.Interface | null,
  shellLineHandler: null as ((line: string) => Promise<void>) | null,
  keypressHandler: null as ((char: any, key: any) => void) | null,
  trackedSessionId: null as string | null,
  diffPending: false,
  isBottomAreaRendered: false,
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
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
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
