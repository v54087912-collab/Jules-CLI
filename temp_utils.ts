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

// ── Banner ──────────────────────────────────────────────────────────────────
export async function printBanner(
  project: string = 'default-project', 
  branch: string = 'main', 
  mode: string = 'FAST', 
  shadowUrl: string | null = null,
  sessionId: string | null = null,
  sessionUrl: string | null = null
) {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const purple = chalk.hex('#7C3AED');
  const boldPurple = chalk.hex('#7C3AED').bold;
  
  const octopusBase = [
    '     ▄████████▄',
    '    ███▀    ▀███',
    '   ███  ●  ●  ███',
    '   ███        ███',
    '  ▄███  █  █  ███▄',
    ' █████  █  █  █████'
  ];

  const octopus = octopusBase.map(line => {
    return purple(line).replace(/●/g, chalk.bold.white('●'));
  });

  const tentaclesBase = [
    ' ▀███▀  ▀  ▀  ▀███▀ ', // Frame 1: tentacles flat
    ' ▄███▄  ▄  ▄  ▄███▄ ', // Frame 2: tentacles raised
    ' ▀███▄  ▄  ▀  ▀███▄ '  // Frame 3: wave left→right
  ];

  const titleLines = [
    chalk.bold.white('     ██╗██╗   ██╗██╗     ███████╗███████╗     ██████╗██╗     ██╗'),
    chalk.bold.white('     ██║██║   ██║██║     ██╔════╝██╔════╝    ██╔════╝██║     ██║'),
    chalk.bold.white('     ██║██║   ██║██║     █████╗  ███████╗    ██║     ██║     ██║'),
    chalk.bold.white('██   ██║██║   ██║██║     ██╔══╝  ╚════██║    ██║     ██║     ██║'),
    chalk.bold.white('╚█████╔╝╚██████╔╝███████╗███████╗███████║    ╚██████╗███████╗██║'),
    chalk.bold.white(' ╚════╝  ╚═════╝ ╚══════╝╚══════╝╚══════╝     ╚═════╝╚══════╝╚═╝'),
    '',
    '     ' + boldPurple('JULES  CLI') + chalk.dim('  —  research preview  ') + chalk.cyan('Developer: Rev_X')
  ];

  const isWide = cols >= 80;
  const headerHeight = isWide ? 11 : 18;

  let finalSessionId = sessionId;
  if ((!finalSessionId || finalSessionId === '(none)') && sessionUrl) {
    const parts = sessionUrl.split('/').filter(Boolean);
    if (parts.length > 0) {
      finalSessionId = parts[parts.length - 1];
    }
  }

  const drawHeader = (frame: number) => {
    const tentacle = purple(tentaclesBase[frame]);
    
    if (isWide) {
      // Move to top
      process.stdout.write('\u001b[H\n');
      for (let i = 0; i < 6; i++) {
        process.stdout.write(octopus[i] + '  ' + (i < titleLines.length ? titleLines[i] : '') + '\u001b[K\n');
      }
      process.stdout.write(tentacle + '  ' + (6 < titleLines.length ? titleLines[6] : '') + '\u001b[K\n');
      process.stdout.write(' '.repeat(20) + (7 < titleLines.length ? titleLines[7] : '') + '\u001b[K\n');
    } else {
      // Move to top
      process.stdout.write('\u001b[H\n');
      octopus.forEach(line => process.stdout.write(line + '\u001b[K\n'));
      process.stdout.write(tentacle + '\u001b[K\n\n');
      titleLines.forEach(line => process.stdout.write(line + '\u001b[K\n'));
    }
  };

  const printInfoArea = () => {
    process.stdout.write(chalk.dim('\n  ' + '─'.repeat(Math.min(cols - 4, 60))) + '\u001b[K\n');
    const printInfo = (label: string, value: string, icon: string) => {
      process.stdout.write(`  ${icon} ${chalk.cyan(label.padEnd(11))} : ${chalk.white(value)}\u001b[K\n`);
    };
    printInfo('Project', project, '📁');
    printInfo('Branch', branch, '🌿');
    printInfo('Mode', mode.toUpperCase(), '⚡');
    
    if (shadowUrl) {
      // Mask GitHub token: https://TOKEN@github.com -> https://*** @github.com
      let displayUrl = shadowUrl.replace(/([^:]+:\/\/)?([^@]+)@/, '$1*** @');
      if (displayUrl.length > cols - 25) displayUrl = '...' + displayUrl.slice(-(cols - 30));
      printInfo('Shadow', displayUrl, '🔗');
    } else {
      printInfo('Shadow', '(none)', '🔗');
    }

    printInfo('Session ID', finalSessionId || '(none)', '🆔');
    
    if (sessionUrl) {
      const sessionLabel = chalk.cyan('Session URL'.padEnd(11));
      process.stdout.write(`  🌐 ${sessionLabel} : ${chalk.yellow(sessionUrl)}\u001b[K\n`);
    } else {
      printInfo('Session URL', '(none)', '🌐');
    }
    
    process.stdout.write(chalk.dim('  ' + '─'.repeat(Math.min(cols - 4, 60))) + '\u001b[K\n');
    process.stdout.write(chalk.dim(`  /help for commands · /exit to quit\n`) + '\u001b[K\n');
  };

  // Initial setup
  if (process.stdout.isTTY && rows > headerHeight + 5) {
    process.stdout.write('\u001b[H\u001b[2J'); // Clear screen
    
    // Set scroll region
    let infoHeight = 6;
    if (shadowUrl) infoHeight++;
    if (finalSessionId) infoHeight++;
    if (sessionUrl) infoHeight++;

    let totalHeaderHeight = headerHeight + infoHeight + 2;
    if (totalHeaderHeight >= rows - 2) {
      totalHeaderHeight = rows - 3;
    }
    
    process.stdout.write(`\u001b[${totalHeaderHeight + 1};r`); // Scroll region
    process.stdout.write(`\u001b[${totalHeaderHeight + 1};1H`); // Move to start of scroll region
    
    drawHeader(0);
    printInfoArea();

    // Start infinite animation
    if (shellState.octopusInterval) clearInterval(shellState.octopusInterval);
    shellState.octopusInterval = setInterval(() => {
      shellState.animationFrame = (shellState.animationFrame + 1) % 3;
      
      // Save cursor
      process.stdout.write('\u001b[s');
      
      // Draw tentacles frame
      const tentacleLine = isWide ? 8 : 8; // Row where tentacles are (1-indexed)
      // Actually octopus rows are 2-7, tentacles is row 8
      process.stdout.write(`\u001b[${tentacleLine};1H`);
      process.stdout.write(purple(tentaclesBase[shellState.animationFrame]));
      
      // Restore cursor
      process.stdout.write('\u001b[u');
    }, 150);
  } else {
    // Fallback for non-TTY or small screens: just print once
    console.log('\n');
    octopus.forEach(line => console.log(line));
    console.log(purple(tentaclesBase[0]));
    console.log('');
    titleLines.forEach(line => console.log(line));
    
    console.log(chalk.dim('\n  ' + '─'.repeat(Math.min(cols - 4, 60))));
    const printInfo = (label: string, value: string, icon: string) => {
      console.log(`  ${icon} ${chalk.cyan(label.padEnd(11))} : ${chalk.white(value)}`);
    };
    printInfo('Project', project, '📁');
    printInfo('Branch', branch, '🌿');
    printInfo('Mode', mode.toUpperCase(), '⚡');
    
    if (shadowUrl) {
      let displayUrl = shadowUrl.replace(/([^:]+:\/\/)?([^@]+)@/, '$1*** @');
      console.log(`  🔗 ${chalk.cyan('Shadow'.padEnd(11))} : ${chalk.white(displayUrl)}`);
    } else {
      console.log(`  🔗 ${chalk.cyan('Shadow'.padEnd(11))} : ${chalk.white('(none)')}`);
    }

    console.log(`  🆔 ${chalk.cyan('Session ID'.padEnd(11))} : ${chalk.white(finalSessionId || '(none)')}`);
    
    if (sessionUrl) {
      console.log(`  🌐 ${chalk.cyan('Session URL'.padEnd(11))} : ${chalk.yellow(sessionUrl)}`);
    } else {
      console.log(`  🌐 ${chalk.cyan('Session URL'.padEnd(11))} : ${chalk.white('(none)')}`);
    }
    
    console.log(chalk.dim('  ' + '─'.repeat(Math.min(cols - 4, 60))));
  }
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
