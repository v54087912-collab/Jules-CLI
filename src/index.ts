#!/usr/bin/env node
import { Command } from 'commander';
import ora from 'ora';
import path from 'path';
import readline from 'readline';
import chalk from 'chalk';
import { parsePatch, formatPatch } from 'diff';
import { validateEnv, logger, printBanner, askUser, shellState, closeAskUser, downloadFile, loadSettings, saveSettings } from './utils';
import { initGit, syncLocalChanges, getRemoteUrl, setRemote, getCurrentBranch, isGitRepo, syncBranchAndPull } from './git';
import { createShadowRepo, createJulesSession, getSessionStatus, getSessionActivities, sendJulesMessage, approveJulesPlan, listJulesSessions, deleteJulesSession } from './api';
import { applyChanges, CodeChange } from './patcher';
import fs from 'fs';
import { bridgePathsInText, restoreExternalMappedFiles } from './bridge';

function getWorkspaceRoot(): string {
  if (process.env.JULES_WORKSPACE) return path.resolve(process.env.JULES_WORKSPACE);
  
  const cwd = path.resolve(process.cwd());
  const parts = cwd.split(path.sep);
  
  // Check if we are already inside a "Jules-Workspace" folder
  const wsIndex = parts.lastIndexOf('Jules-Workspace');
  if (wsIndex !== -1) {
    return parts.slice(0, wsIndex + 1).join(path.sep);
  }
  
  // Look for "Jules-Workspace" in current or parent directories
  let curr = cwd;
  while (curr !== path.parse(curr).root) {
    const candidate = path.join(curr, 'Jules-Workspace');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  
  return path.resolve('/storage/emulated/0/Jules-Workspace');
}

function wrapText(text: string, maxWidth: number, indent: string = ''): string {
  const paragraphs = text.split('\n');
  const result: string[] = [];

  for (const paragraph of paragraphs) {
    const words = paragraph.split(' ');
    let currentLine = '';
    const wrappedParagraphLines: string[] = [];

    for (const word of words) {
      if (currentLine.length + (currentLine ? 1 : 0) + word.length > maxWidth) {
        if (currentLine) {
          wrappedParagraphLines.push(currentLine);
          currentLine = word;
        } else {
          wrappedParagraphLines.push(word);
          currentLine = '';
        }
      } else {
        currentLine = currentLine ? `${currentLine} ${word}` : word;
      }
    }
    if (currentLine) {
      wrappedParagraphLines.push(currentLine);
    }
    
    if (wrappedParagraphLines.length === 0) {
      result.push('');
    } else {
      result.push(...wrappedParagraphLines);
    }
  }

  return result.map((line, idx) => (idx === 0 ? line : `${indent}${line}`)).join('\n');
}

const settings = loadSettings();
let currentMode: 'fast' | 'plan' = 'fast';

const isLongPaste = (text: string): boolean => {
  if (text.includes('\n') || text.includes('\r')) {
    return true;
  }
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  return wordCount > 15 || text.length > 100;
};

function getWorkspaceStatus(): { isValid: boolean; error?: string; projectName?: string; isOutside?: boolean; wsRoot?: string } {
  const cwd = path.resolve(process.cwd());
  const wsRoot = getWorkspaceRoot();
  
  if (cwd === wsRoot) {
    return {
      isValid: false,
      error: `You are in the root of Jules-Workspace (${wsRoot}).\nPlease run commands inside a project subdirectory (e.g., ${path.join(wsRoot, 'your-project')}).`,
      wsRoot
    };
  }
  
  const relative = path.relative(wsRoot, cwd);
  const isSubdir = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  
  if (!isSubdir) {
    return {
      isValid: false,
      isOutside: true,
      error: `You are outside the Jules-Workspace folder (${cwd}).`,
      wsRoot
    };
  }
  
  const parts = relative.split(path.sep);
  const projectName = parts[0];
  
  return {
    isValid: true,
    projectName,
    wsRoot
  };
}

async function enforceWorkspace(): Promise<string> {
  const status = getWorkspaceStatus();
  if (!status.isValid) {
    if (status.isOutside) {
      const cwd = process.cwd();
      const wsName = 'Jules-Workspace';
      
      logger.info(`No Jules-Workspace found. Automatically creating '${wsName}' in current directory...`);
      const newWs = path.join(cwd, wsName);
      
      try {
        if (!fs.existsSync(newWs)) {
          fs.mkdirSync(newWs, { recursive: true });
          logger.success(`Created: ${newWs}`);
        }
        
        const answer = await askUser(chalk.hex('#2ec4b6')('\nSetup a "default-project" and start Jules now? (y/n): '));
        
        if (answer.trim().toLowerCase() === 'y') {
          const projectDir = path.join(newWs, 'default-project');
          if (!fs.existsSync(projectDir)) {
            fs.mkdirSync(projectDir, { recursive: true });
          }
          process.chdir(projectDir);
          logger.success('Automatically entered: Jules-Workspace/default-project');
          return 'default-project';
        }

        console.log('');
        console.log(chalk.bold.green('✓ Workspace Created!'));
        console.log(chalk.white('\nTo start a project manually, run:'));
        console.log(chalk.cyan(`  mkdir -p ${wsName}/my-project && cd ${wsName}/my-project`));
        console.log(chalk.white('\nThen run ') + chalk.bold('jules-local') + chalk.white(' again.\n'));
        
        process.exit(0);
      } catch (err: any) {
        logger.error(`Failed to create workspace: ${err.message}`);
        process.exit(1);
      }
    }
    logger.error(status.error || 'Workspace enforcement failed.');
    process.exit(1);
  }
  return status.projectName!;
}

function sanitizeUrlForDisplay(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\.git$/, '');
  } catch (e) {
    return url.replace(/[^@]+@/, '').replace(/\.git$/, '');
  }
}

function printShadowRepoWarning(authenticatedUrl: string) {
  const cleanRepoUrl = sanitizeUrlForDisplay(authenticatedUrl);
  console.log('\n' + '='.repeat(60));
  console.log(chalk.bold.yellow('⚠️  ACTION REQUIRED: Install Google Jules GitHub App'));
  console.log('='.repeat(60));
  console.log(chalk.white('A new private shadow repository has been created for your project:'));
  console.log(chalk.bold.cyan(`   ${cleanRepoUrl}`));
  console.log(chalk.white('\nTo allow Jules to edit your code, you MUST install the'));
  console.log(chalk.white('Google Jules GitHub App and grant access to this repository.'));
  console.log(chalk.white('\n1. Open: ') + chalk.bold.underline.cyan('https://jules.google.com/settings'));
  console.log(chalk.white('2. Click on "Connect GitHub" or install the App.'));
  console.log(chalk.white('3. Ensure the repository above is selected/authorized.'));
  console.log('='.repeat(60) + '\n');
}

async function ensureGitAndRemoteLinked() {
  const status = getWorkspaceStatus();
  if (!status.isValid || !status.projectName) {
    return;
  }
  
  const gitRepo = await isGitRepo();
  const remoteUrl = await getRemoteUrl();
  
  if (!gitRepo || !remoteUrl) {
    logger.info(`Auto-initializing project workspace for "${status.projectName}"...`);
    
    if (!gitRepo) {
      await initGit();
    }
    
    if (!remoteUrl) {
      validateEnv();
      const repoName = `jules-shadow-${status.projectName}`;
      
      const spinner = ora({
        text: chalk.gray(`Creating GitHub shadow repository: ${repoName}...`),
        color: 'magenta'
      }).start();
      
      try {
        const authenticatedUrl = await createShadowRepo(repoName);
        await setRemote(authenticatedUrl);
        spinner.succeed(`Linked to shadow repository: ${repoName}`);
        
        printShadowRepoWarning(authenticatedUrl);
        
        logger.info('Performing initial sync...');
        await syncLocalChanges();
      } catch (error: any) {
        spinner.fail(`Failed to auto-link repository: ${error.message}`);
        throw error;
      }
    }
  }
}

const program = new Command();

async function handleInit() {
  await enforceWorkspace();
  validateEnv();
  try {
    await initGit();
    const repoName = `jules-shadow-${path.basename(process.cwd())}`;
    const authenticatedUrl = await createShadowRepo(repoName);
    await setRemote(authenticatedUrl);
    logger.success(`Linked to shadow repo (with auth): ${repoName}`);
    printShadowRepoWarning(authenticatedUrl);
  } catch (error: any) {
    logger.error(`Init failed: ${error.message}`);
  }
}

async function handleSync() {
  await enforceWorkspace();
  validateEnv();
  try {
    await ensureGitAndRemoteLinked();
    await syncLocalChanges();
  } catch (error: any) {
    logger.error(`Sync failed: ${error.message}`);
  }
}

async function promptJulesReply(cleanHeader: string): Promise<string> {
  const oldLineHandler = shellState.shellLineHandler;
  const oldKeypressHandler = shellState.keypressHandler;
  
  let tempRl: readline.Interface | null = null;
  let resolveReply: ((value: string) => void) | null = null;
  let lineHandlerRef: ((line: string) => void) | null = null;
  let rl = shellState.activeRl;
  if (!rl) {
    tempRl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.bold.white('> '),
      completer: (line: string) => [[], line]
    });
    rl = tempRl;
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
  } else {
    if (oldLineHandler) {
      rl.off('line', oldLineHandler);
    }
    if (oldKeypressHandler) {
      process.stdin.removeListener('keypress', oldKeypressHandler);
    }
    rl.resume();
  }

  console.log(chalk.bold.white('\n' + cleanHeader));
  const cols = process.stdout.columns || 80;
  console.log(chalk.dim('─'.repeat(Math.max(0, cols - 1))));

  let accumulatedLines: string[] = [];
  let altEnterPressed = false;
  let activeBottomLines = 0;
  let activeMatches: string[] = [];
  let cyclingIndex = -1;
  let originalLine = '';
  let isPasting = false;
  let pasteBuffer = '';
  let oldTtyWrite: any = null;
  let replyPastedBlocks: string[] = [];
  let replyPasteCount = 0;

  process.stdout.write('\u001b[?2004h');
  const disableReplyBracketedPaste = () => {
    process.stdout.write('\u001b[?2004l');
  };
  process.on('exit', disableReplyBracketedPaste);

  const handleReplyTabKey = (reverse = false) => {
    if (activeMatches.length === 0) return;

    if (cyclingIndex === -1) {
      originalLine = rl!.line;
    }

    const total = activeMatches.length;
    if (reverse) {
      cyclingIndex = cyclingIndex - 1;
      if (cyclingIndex < -1) {
        cyclingIndex = total - 1;
      }
    } else {
      cyclingIndex = cyclingIndex + 1;
      if (cyclingIndex >= total) {
        cyclingIndex = -1;
      }
    }

    if (cyclingIndex === -1) {
      (rl as any).line = originalLine;
    } else {
      (rl as any).line = activeMatches[cyclingIndex];
    }
    (rl as any).cursor = (rl as any).line.length;
    (rl as any)._refreshLine();

    drawReplyBottomArea();
  };

  const clearReplyBottomArea = () => {
    if (activeBottomLines > 0) {
      const col = 2 + rl!.cursor;
      for (let i = 1; i <= activeBottomLines; i++) {
        process.stdout.write('\n\r\u001b[2K');
      }
      process.stdout.write(`\u001b[${activeBottomLines}A`);
      process.stdout.write('\r' + (col > 0 ? `\u001b[${col}C` : ''));
      activeBottomLines = 0;
    }
  };

  const drawReplyBottomArea = () => {
    clearReplyBottomArea();

    const separator = chalk.dim('─'.repeat(Math.max(0, cols - 1)));
    const left = '/shot for shortcuts';
    const right = '/session';
    const spaceCount = Math.max(2, cols - left.length - right.length - 10);
    const footer = chalk.dim('  ' + left + ' '.repeat(spaceCount) + right);

    const lines = [separator];

    if (activeMatches.length > 0) {
      const prefix = '  ⎿ ';
      const styledMatches = activeMatches.map((m, idx) => 
        idx === cyclingIndex ? chalk.bold.white(m) : chalk.dim(m)
      );

      const itemSeparator = '  ';
      let plainText = prefix;
      let keepCount = 0;

      for (let i = 0; i < activeMatches.length; i++) {
        const item = activeMatches[i];
        const nextLength = plainText.length + (i > 0 ? itemSeparator.length : 0) + item.length;
        if (nextLength > cols - 8) {
          break;
        }
        plainText += (i > 0 ? itemSeparator : '') + item;
        keepCount++;
      }

      if (keepCount === 0 && activeMatches.length > 0) {
        keepCount = 1;
      }

      const displayMatches = styledMatches.slice(0, keepCount);
      let formattedText = chalk.dim(prefix) + displayMatches.join(chalk.dim(itemSeparator));
      if (keepCount < activeMatches.length) {
        formattedText += chalk.dim('  …');
      }

      lines.push(formattedText);
    }

    lines.push(footer);

    const col = 2 + rl!.cursor;
    for (const line of lines) {
      process.stdout.write(`\n\r\u001b[2K${line}`);
    }

    const linesCount = lines.length;
    process.stdout.write(`\u001b[${linesCount}A`);
    process.stdout.write('\r' + (col > 0 ? `\u001b[${col}C` : ''));

    activeBottomLines = linesCount;
  };

  const clearReplyBottomAreaOnEnter = () => {
    if (activeBottomLines === 0) return;
    process.stdout.write('\r\u001b[2K');
    for (let i = 1; i < activeBottomLines; i++) {
      process.stdout.write('\n\r\u001b[2K');
    }
    if (activeBottomLines > 1) {
      process.stdout.write(`\u001b[${activeBottomLines - 1}A`);
    }
    process.stdout.write('\r');
    activeBottomLines = 0;
    activeMatches = [];
    cyclingIndex = -1;
  };

  rl.setPrompt(chalk.bold.white('> '));
  rl.prompt();
  drawReplyBottomArea();

  const keypressHandler = (char: any, key: any) => {
    const seq = key?.sequence || char || '';
    const isEnd = key && key.name === 'end';
    
    if (isEnd) {
      clearReplyBottomAreaOnEnter();
      disableReplyBracketedPaste();
      process.off('exit', disableReplyBracketedPaste);
      process.stdin.removeListener('keypress', keypressHandler);
      rl.off('SIGINT', sigintHandler);
      if (lineHandlerRef) {
        rl!.off('line', lineHandlerRef);
      }
      if (tempRl) {
        tempRl.close();
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
      } else {
        if (oldLineHandler) {
          rl!.on('line', oldLineHandler);
        }
        if (oldKeypressHandler) {
          process.stdin.prependListener('keypress', oldKeypressHandler);
        }
      }
      if (resolveReply) {
        resolveReply('/untrack');
      }
      return;
    }
    
    if (seq === '\u001b[200~') {
      isPasting = true;
      pasteBuffer = '';
      oldTtyWrite = (rl as any)._ttyWrite;
      (rl as any)._ttyWrite = (s: any, k: any) => {
        // Intercept and do nothing
      };
      if (key) { key.name = undefined; key.sequence = ''; }
      return;
    }
    
    if (seq === '\u001b[201~') {
      isPasting = false;
      if (oldTtyWrite) {
        (rl as any)._ttyWrite = oldTtyWrite;
        oldTtyWrite = null;
      }
      
      clearReplyBottomArea();
      
      const line = rl!.line;
      const pos = rl!.cursor;
      const before = line.substring(0, pos);
      const after = line.substring(pos);
      
      if (isLongPaste(pasteBuffer)) {
        const wordCount = pasteBuffer.trim().split(/\s+/).filter(Boolean).length;
        replyPasteCount++;
        replyPastedBlocks.push(pasteBuffer);
        const placeholder = `[pasted text #${replyPasteCount} [${wordCount} words]]`;
        
        const newLine = before + placeholder + after;
        (rl as any).line = newLine;
        (rl as any).cursor = pos + placeholder.length;
      } else {
        const newLine = before + pasteBuffer + after;
        (rl as any).line = newLine;
        (rl as any).cursor = pos + pasteBuffer.length;
      }
      (rl as any)._refreshLine();
      drawReplyBottomArea();
      
      if (key) { key.name = undefined; key.sequence = ''; }
      return;
    }
    
    if (isPasting) {
      if (char) {
        pasteBuffer += char;
      }
      if (key) { key.name = undefined; key.sequence = ''; }
      return;
    }

    const isEscape = (key && key.name === 'escape') || char === '\u001b' || char === '\x1b';
    if (isEscape) {
      accumulatedLines = [];
      altEnterPressed = false;
      replyPastedBlocks = [];
      replyPasteCount = 0;
      rl!.setPrompt(chalk.bold.white('> '));
      (rl as any).line = '';
      (rl as any).cursor = 0;
      (rl as any)._refreshLine();
      activeMatches = [];
      cyclingIndex = -1;
      drawReplyBottomArea();
      return;
    }

    let isCycling = false;
    if (key) {
      if (key.name === 'tab') {
        isCycling = true;
        const reverse = !!(key.shift || key.meta);
        handleReplyTabKey(reverse);
        key.name = undefined;
        return;
      }
      if (key.name === 'down') {
        if (activeMatches.length > 0) {
          isCycling = true;
          handleReplyTabKey(false);
          key.name = undefined;
          return;
        }
      }
      if (key.name === 'up') {
        if (activeMatches.length > 0) {
          isCycling = true;
          handleReplyTabKey(true);
          key.name = undefined;
          return;
        }
      }
      // Handle backspace for multi-line support
      if (key.name === 'backspace' && rl!.line === '' && accumulatedLines.length > 0) {
        const lastLine = accumulatedLines.pop() || '';
        (rl as any).line = lastLine;
        (rl as any).cursor = lastLine.length;
        
        // Move cursor up and clear line
        process.stdout.write('\x1b[1A\x1b[2K'); 
        
        // Set prompt based on if there are still accumulated lines
        if (accumulatedLines.length > 0) {
          rl!.setPrompt('  ');
        } else {
          rl!.setPrompt(chalk.bold.white('> '));
        }
        
        (rl as any)._refreshLine();
        return;
      }

      if ((key.meta || key.shift || key.ctrl || char === '\u001b\r' || char === '\u001b\n') && (key.name === 'return' || key.name === 'enter' || char === '\u001b\r' || char === '\u001b\n')) {
        altEnterPressed = true;
        rl!.setPrompt('  ');
        // Manually trigger line event for Alt+Enter as readline might not emit it
        if (key.meta || char === '\u001b\r' || char === '\u001b\n') {
          const currentLine = rl!.line;
          (rl as any).line = '';
          (rl as any).cursor = 0;
          process.stdout.write('\n');
          rl!.emit('line', currentLine);
          return;
        }
      }
    }

    isCycling = false;

    process.nextTick(() => {
      if (!isCycling) {
        cyclingIndex = -1;
        originalLine = rl!.line;
      }

      const line = rl!.line;
      let newMatches: string[] = [];
      if (line.startsWith('/')) {
        newMatches = ['/session', '/usage', '/plan', '/fast', '/clear', '/help', '/docs', '/shot', '/exit'].filter(c => c.startsWith(line));
        if (newMatches.length > 0 && line === newMatches[0]) {
          newMatches = [];
        }
      }

      activeMatches = newMatches;
      drawReplyBottomArea();
    });
  };

  const sigintHandler = () => {
    process.exit(0);
  };

  process.stdin.resume();
  process.stdin.prependListener('keypress', keypressHandler);
  rl.on('SIGINT', sigintHandler);

  return new Promise<string>((resolve) => {
    resolveReply = resolve;
    const lineHandler = async (line: string) => {
      clearReplyBottomAreaOnEnter();
      
      const endsWithBackslash = line.endsWith('\\');
      if (altEnterPressed || endsWithBackslash) {
        const lineToPush = endsWithBackslash ? line.slice(0, -1) : line;
        accumulatedLines.push(lineToPush);
        altEnterPressed = false;
        rl!.setPrompt('  ');
        rl!.prompt();
        drawReplyBottomArea();
      } else {
        const cmd = line.trim().toLowerCase();
        const baseCmd = cmd.split(' ')[0];
        if (['/init', '/sync', '/edit', '/restore'].includes(baseCmd)) {
          logger.error(`Command ${baseCmd} is not available during an active session.`);
          rl!.prompt();
          drawReplyBottomArea();
          return;
        }

        if (baseCmd === '/session') {
          const args = line.trim().split(' ').slice(1);
          const subcommand = args[0]?.toLowerCase();
          if (subcommand === 'untrack' || subcommand === 'clear' || subcommand === 'reset') {
            if (resolveReply) {
              resolveReply('/untrack');
            }
            return;
          }
          if (subcommand === 'ls' || subcommand === 'list') {
            try {
              rl!.pause();
              await handleSessionCommand(['list']);
            } finally {
              rl!.resume();
              rl!.prompt();
              drawReplyBottomArea();
            }
            return;
          }
          logger.error(`Subcommand /session ${subcommand || ''} is not available during an active session. Use /session untrack first.`);
          rl!.prompt();
          drawReplyBottomArea();
          return;
        }

        if (cmd === '/clear') {
          console.clear();
          console.log(chalk.bold.white('\n' + cleanHeader));
          console.log(chalk.dim('─'.repeat(Math.max(0, cols - 1))));
          rl!.prompt();
          drawReplyBottomArea();
          return;
        }
        if (cmd === '/shot') {
          try {
            rl!.pause();
            await handleShortcutsCommand();
          } finally {
            rl!.resume();
            rl!.prompt();
            drawReplyBottomArea();
          }
          return;
        }
        if (cmd === '/docs') {
          try {
            rl!.pause();
            await handleDocs();
          } finally {
            rl!.resume();
            rl!.prompt();
            drawReplyBottomArea();
          }
          return;
        }
        if (cmd === '/usage') {
          try {
            rl!.pause();
            await handleUsageCommand();
          } finally {
            rl!.resume();
            rl!.prompt();
            drawReplyBottomArea();
          }
          return;
        }
        if (cmd === '/help') {
          console.log('');
          console.log(chalk.bold.white('  Commands inside Reply Mode:'));
          console.log(`    ${chalk.bold.cyan('/clear'.padEnd(28))} ${chalk.dim('Clear terminal')}`);
          console.log(`    ${chalk.bold.cyan('/docs'.padEnd(28))} ${chalk.dim('Show documentation manual')}`);
          console.log(`    ${chalk.bold.cyan('/shot'.padEnd(28))} ${chalk.dim('Show keyboard shortcuts manual')}`);
          console.log(`    ${chalk.bold.cyan('/usage'.padEnd(28))} ${chalk.dim("Show today's stats & summary")}`);
          console.log(`    ${chalk.bold.cyan('/plan'.padEnd(28))} ${chalk.dim('Switch to manual plan approval')}`);
          console.log(`    ${chalk.bold.cyan('/fast'.padEnd(28))} ${chalk.dim('Switch to automatic plan approval')}`);
          console.log(`    ${chalk.bold.cyan('/exit'.padEnd(28))} ${chalk.dim('Quit session')}`);
          console.log('');
          console.log(chalk.bold.white('  Project Information:'));
          console.log(`    ${chalk.bold.cyan('Open Source'.padEnd(28))} ${chalk.dim('Jules CLI is an Open Source project')}`);
          console.log(`    ${chalk.bold.cyan('GitHub'.padEnd(28))} ${chalk.dim('https://github.com/v54087912-collab/Jules-CLI.git')}`);
          console.log('');
          console.log(chalk.bold.white('  Support & Links:'));
          console.log(`    ${chalk.bold.cyan('Developer'.padEnd(28))} ${chalk.dim('https://t.me/R3V_X')}`);
          console.log(`    ${chalk.bold.cyan('Community'.padEnd(28))} ${chalk.dim('https://t.me/allinformation0173')}`);
          console.log(`    ${chalk.bold.cyan('Instagram'.padEnd(28))} ${chalk.dim('https://www.instagram.com/opeditzxx/')}`);
          console.log('');
          rl!.prompt();
          drawReplyBottomArea();
          return;
        }
        if (cmd === '/plan') {
          currentMode = 'plan';
          logger.success('Switched to PLAN mode (Manual plan approval required).');
          rl!.prompt();
          drawReplyBottomArea();
          return;
        }
        if (cmd === '/fast') {
          currentMode = 'fast';
          logger.success('Switched to FAST mode (Automatic plan approval enabled).');
          rl!.prompt();
          drawReplyBottomArea();
          return;
        }

        accumulatedLines.push(line);
        
        process.stdin.removeListener('keypress', keypressHandler);
        rl.off('SIGINT', sigintHandler);
        rl!.off('line', lineHandler);
        
        disableReplyBracketedPaste();
        process.off('exit', disableReplyBracketedPaste);

        if (tempRl) {
          tempRl.close();
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
          }
        } else {
          if (oldLineHandler) {
            rl!.on('line', oldLineHandler);
          }
          if (oldKeypressHandler) {
            process.stdin.prependListener('keypress', oldKeypressHandler);
          }
        }
        
        const fullLine = accumulatedLines.join('\n');
        let substitutedLine = fullLine;
        for (let i = 0; i < replyPastedBlocks.length; i++) {
          const placeholderPattern = `[pasted text #${i + 1} [`;
          const idx = substitutedLine.indexOf(placeholderPattern);
          if (idx !== -1) {
            const endIdx = substitutedLine.indexOf(']]', idx + placeholderPattern.length);
            if (endIdx !== -1) {
              const fullPlaceholder = substitutedLine.substring(idx, endIdx + 2);
              substitutedLine = substitutedLine.replace(fullPlaceholder, replyPastedBlocks[i]);
            }
          }
        }
        replyPastedBlocks = [];
        replyPasteCount = 0;
        
        resolve(substitutedLine);
      }
    };
    lineHandlerRef = lineHandler;

    rl!.on('line', lineHandler);
  });
}

export async function trackJulesSession(sessionId: string, repoUrl?: string) {
  const spinnerVerbs = [
    'Pondering',
    'Crunching',
    'Thinking',
    'Analyzing',
    'Refactoring',
    'Reasoning',
    'Designing',
    'Exploring',
    'Puzzling',
    'Deciphering'
  ];

  let taskCancelled = false;
  let taskUntracked = false;
  
  const performUntrack = () => {
    if (spinner && spinner.isSpinning) spinner.stop();
    clearInterval(verbInterval);
    logger.info('Untracking session locally (it will continue running in the cloud)...');
    if (shellState.trackedSessionId === sessionId) {
      shellState.trackedSessionId = null;
      saveSettings({ trackedSessionId: null });
    }
    completed = true;
  };
  const sessionKeypressHandler = (char: any, key: any) => {
    const isEscape = (key && key.name === 'escape') || char === '\u001b' || char === '\x1b';
    const isCtrlC = (key && key.ctrl && key.name === 'c') || char === '\u0003';
    const isEnd = key && key.name === 'end';
    
    if (isEscape || isCtrlC) {
      taskCancelled = true;
      // Immediate feedback
      if (spinner && spinner.isSpinning) {
        spinner.stop();
        spinner.text = chalk.yellow('⚠ Cancelling task...');
        spinner.start();
      }
    } else if (isEnd) {
      taskUntracked = true;
      // Immediate feedback
      if (spinner && spinner.isSpinning) {
        spinner.stop();
        spinner.text = chalk.yellow('⚠ Untracking session...');
        spinner.start();
      }
    }
  };

  console.log(chalk.dim('\n── Synced with Jules Web Session ──'));
  console.log(chalk.dim(`Session: ${sessionId}`));
  console.log(chalk.dim('────────────────────────────────────\n'));

  // Synchronize local workspace with remote branch before starting live tracking
  try {
    const status = await getSessionStatus(sessionId);
    let headBranch: string | undefined;
    if (status.outputs && Array.isArray(status.outputs)) {
      for (const out of status.outputs) {
        if (out.pullRequest?.headRef) {
          headBranch = out.pullRequest.headRef;
        }
      }
    }
    await syncBranchAndPull(headBranch);
  } catch (e) {
    // Ignore sync errors, proceed to tracking loop
  }

  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume(); // Ensure stream is flowing
  process.stdin.prependListener('keypress', sessionKeypressHandler);

  // Helper: detect if text is internal markdown evaluation garbage
  const isJunkDescription = (d: string) =>
    d.startsWith('###') ||
    d.includes('Final Rating') ||
    d.includes('Merge Assessment') ||
    (d.includes('\n') && d.includes('###'));

  const formatSpinnerText = (verb: string) => chalk.bold.cyan('Status: Working') + chalk.dim(' • ') + chalk.white(verb);

  const activityLog: { step: string, timestamp: string, status: 'active' | 'done' }[] = [];
  const updateActivityTracker = (newStep: string) => {
    if (!newStep || isJunkDescription(newStep)) return;
    
    // Deduplicate consecutive identical steps
    if (activityLog.length > 0 && activityLog[activityLog.length - 1].step === newStep) return;

    // Globally deduplicate 'All plan steps completed' - it's too repetitive
    if (newStep === 'All plan steps completed' && activityLog.some(l => l.step === newStep)) return;
    
    if (activityLog.length > 0) activityLog[activityLog.length - 1].status = 'done';
    
    const now = new Date();
    const timestamp = String(now.getHours()).padStart(2, '0') + ':' + 
                      String(now.getMinutes()).padStart(2, '0') + ':' + 
                      String(now.getSeconds()).padStart(2, '0');
    activityLog.push({ step: newStep, timestamp, status: 'active' });
  };

  let currentVerb = spinnerVerbs[0];
  updateActivityTracker(currentVerb);

  const spinner = ora({
    text: formatSpinnerText(currentVerb),
    spinner: 'dots',
    color: 'yellow'
  }).start();

  // Verb rotator interval — only rotates random verbs when no real Jules
  // step has set currentVerb. Once live status sync sets currentVerb to a
  // real step name, stop rotating and just keep refreshing that text.
  const verbInterval = setInterval(() => {
    if (spinner.isSpinning) {
      const isStillRandom = (spinnerVerbs as readonly string[]).includes(currentVerb);
      if (isStillRandom && !lastStatusDescription) {
        // No real status yet — keep rotating random verbs
        currentVerb = spinnerVerbs[Math.floor(Math.random() * spinnerVerbs.length)];
        updateActivityTracker(currentVerb);
      }
      // Otherwise keep currentVerb as-is (real Jules step name)
      spinner.text = formatSpinnerText(currentVerb);
    }
  }, 2000);

  let completed = false;
  const seenActivities = new Set<string>();
  const repliedActivities = new Set<string>();
  const approvedPlans = new Set<string>();
  const downloadedMedia = new Set<string>();
  const printedAgentMessages = new Set<string>();

  let isOffline = false;
  let lastStatusDescription = '';

  // Helper for printing tool executions in Claude Code style
  const printToolUse = (text: string) => {
    const clean = text.replace(/[`']/g, '');
    if (clean.toLowerCase().includes('running command') || clean.toLowerCase().includes('executing')) {
      const match = clean.match(/(?:running command|executing)\s*[:\-]?\s*(.+)/i);
      const cmd = match ? match[1].trim() : clean;
      console.log(chalk.dim('  ⎿  ') + chalk.bold.cyan('Bash: ') + chalk.dim(cmd));
    } else if (clean.toLowerCase().includes('reading file') || clean.toLowerCase().includes('read file')) {
      const match = clean.match(/(?:reading file|read file)\s*[:\-]?\s*(.+)/i);
      const file = match ? match[1].trim() : clean;
      console.log(chalk.dim('  ⎿  ') + chalk.bold.yellow('Reading: ') + chalk.dim(file));
    } else if (clean.toLowerCase().includes('writing file') || clean.toLowerCase().includes('write file') || clean.toLowerCase().includes('saving file') || clean.toLowerCase().includes('save file') || clean.toLowerCase().includes('created file') || clean.toLowerCase().includes('creating file')) {
      const match = clean.match(/(?:writing file|write file|saving file|save file|created file|creating file)\s*[:\-]?\s*(.+)/i);
      const file = match ? match[1].trim() : clean;
      console.log(chalk.dim('  ⎿  ') + chalk.bold.green('Writing: ') + chalk.dim(file));
    } else if (clean.toLowerCase().includes('applying changes') || clean.toLowerCase().includes('applying patch')) {
      console.log(chalk.dim('  ⎿  ') + chalk.bold.green('Patching: ') + chalk.dim(clean));
    } else {
      console.log(chalk.dim('  ⎿  ') + chalk.bold.magenta('Jules: ') + chalk.dim(clean));
    }
  };

  let initialized = false;

  try {
    while (!completed) {
      if (taskCancelled) {
        if (spinner.isSpinning) spinner.stop();
        clearInterval(verbInterval);
        logger.info('Aborting Jules task...');
        try {
          await deleteJulesSession(sessionId);
        } catch (e) {}
        logger.info('Task cancelled.');
        completed = true;
        break;
      }
      if (taskUntracked) {
        performUntrack();
        break;
      }

      try {
        const status = await getSessionStatus(sessionId);
        
        // --- Bug 3: Detect Interrupt/Question ---
        const isInterrupt = status.requires_user_input === true || 
                          ['question', 'interrupt', 'user_input_required'].includes(status.type?.toLowerCase());

        if (isInterrupt) {
          if (spinner.isSpinning) spinner.stop();
          console.log('\n' + chalk.bold.white('── Jules needs your input ──────────'));
          const promptMsg = status.question_text || status.prompt_message || status.description || 'Jules is waiting for your input';
          console.log(chalk.yellow(`⚠ ${promptMsg}`));

          if (status.options && Array.isArray(status.options)) {
            console.log('\nOptions:');
            status.options.forEach((opt: any, idx: number) => {
              const label = typeof opt === 'string' ? opt : opt.label || opt.text || 'Option ' + (idx + 1);
              console.log(`  ${idx + 1}. ${label}`);
            });
          }

          process.stdin.removeListener('keypress', sessionKeypressHandler);
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(wasRaw);
          }

          const userReply = await promptJulesReply('Your response (or type /exit):');

          if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
          }
          process.stdin.resume();
          process.stdin.prependListener('keypress', sessionKeypressHandler);

          if (userReply.trim().toLowerCase() === '/exit') {
            completed = true;
            break;
          }
          if (userReply.trim().toLowerCase() === '/untrack') {
            performUntrack();
            break;
          }

          const msgSpinner = ora({ text: chalk.dim('Sending response…'), spinner: 'dots', color: 'white' }).start();
          const bridgedReply = bridgePathsInText(userReply);
          await sendJulesMessage(sessionId, bridgedReply);
          msgSpinner.stop();
          
          console.log(chalk.bold.green('🧑 You: ') + chalk.white(userReply.trim()));
          console.log(chalk.dim('────────────────────────────────────\n'));
          
          spinner.start(formatSpinnerText(currentVerb));
          continue; // Poll again immediately
        }

        if (status.description && status.description !== lastStatusDescription) {
          lastStatusDescription = status.description;
          if (spinner.isSpinning) spinner.stop();
          logger.info(status.description);
          spinner.start(chalk.bold.white(`∴ ${currentVerb}…`));
        }
        
        if (taskCancelled) {
          if (spinner.isSpinning) spinner.stop();
          clearInterval(verbInterval);
          logger.info('Aborting Jules task...');
          try {
            await deleteJulesSession(sessionId);
          } catch (e) {}
          logger.info('Task cancelled.');
          completed = true;
          break;
        }
        if (taskUntracked) {
          performUntrack();
          break;
        }

        if (isOffline) {
          isOffline = false;
          logger.success('Back online! Resuming sync...');
          spinner.start(chalk.bold.white(`∴ ${currentVerb}…`));
        }

        let activities: any[] = [];
        try {
          activities = await getSessionActivities(sessionId);
          if (!initialized) {
            const agentMsgs = activities.filter((a: any) => a.agentMessaged?.agentMessage);
            if (agentMsgs.length > 0) {
              for (let i = 0; i < agentMsgs.length - 1; i++) {
                if (agentMsgs[i].id) {
                  printedAgentMessages.add(agentMsgs[i].id);
                  repliedActivities.add(agentMsgs[i].id);
                }
              }
              const isWaitingForInput = status.requires_user_input === true || 
                                        ['inactive', 'question', 'interrupt', 'user_input_required'].includes(status.state?.toLowerCase() || status.type?.toLowerCase() || '');
              const lastMsg = agentMsgs[agentMsgs.length - 1];
              if (!isWaitingForInput) {
                if (lastMsg.id) {
                  printedAgentMessages.add(lastMsg.id);
                  repliedActivities.add(lastMsg.id);
                }
              }
            }
            for (const act of activities) {
              if (act.name) seenActivities.add(act.name);
              if (act.id) seenActivities.add(act.id);
            }
            initialized = true;
          }
        } catch (actError: any) {
          if (actError.response?.status !== 404) {
            // Ignore network errors in activities fetch
          }
        }

        if (taskCancelled) {
          if (spinner.isSpinning) spinner.stop();
          clearInterval(verbInterval);
          logger.info('Aborting Jules task...');
          try {
            await deleteJulesSession(sessionId);
          } catch (e) {}
          logger.info('Task cancelled.');
          completed = true;
          break;
        }
        if (taskUntracked) {
          performUntrack();
          break;
        }

        // Check if there are any unreplied agent messages
        const unrepliedActivity = activities.find((a: any) => a.agentMessaged?.agentMessage && !repliedActivities.has(a.id));
        if (unrepliedActivity) {
          if (spinner.isSpinning) spinner.stop();
          
          if (!printedAgentMessages.has(unrepliedActivity.id)) {
            printedAgentMessages.add(unrepliedActivity.id);
            console.log('\n');
            const cols = process.stdout.columns || 80;
            const wrapWidth = Math.max(20, cols - 10);
            const wrappedMsg = wrapText(unrepliedActivity.agentMessaged.agentMessage, wrapWidth, '          ');
            console.log(chalk.bold.white('💬 Jules: ') + chalk.white(wrappedMsg));
          }
          
          // Remove our session cancel keypress listener while user is replying
          process.stdin.removeListener('keypress', sessionKeypressHandler);
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(wasRaw);
          }

          const userReply = await promptJulesReply('Reply (or type /exit):');

          if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
          }
          process.stdin.resume();
          process.stdin.prependListener('keypress', sessionKeypressHandler);

          if (userReply.trim().toLowerCase() === '/exit') {
            completed = true;
            break;
          }
          if (userReply.trim().toLowerCase() === '/untrack') {
            performUntrack();
            break;
          }

          const msgSpinner = ora({ text: chalk.dim('Sending message…'), spinner: 'dots', color: 'white' }).start();
          const bridgedReply = bridgePathsInText(userReply);
          await syncLocalChanges();
          
          await sendJulesMessage(sessionId, bridgedReply);
          msgSpinner.stop();
          logger.success('Message sent successfully.');

          repliedActivities.add(unrepliedActivity.id);
          spinner.start(chalk.bold.white(`∴ ${currentVerb}…`));
          continue; // Poll again immediately
        }

        for (const activity of activities) {
          // --- Test Project Media Handling ---
          const promptText = status.prompt || '';
          if (promptText.toLowerCase().includes('test project')) {
            const testDir = path.join(process.cwd(), 'Test');
            if (!fs.existsSync(testDir)) {
              fs.mkdirSync(testDir, { recursive: true });
              if (spinner.isSpinning) spinner.stop();
              logger.info('Detected "Test Project" command. Created "Test" folder for media.');
              spinner.start(chalk.bold.white(`∴ ${currentVerb}…`));
            }

            // 1. Scan agentMessage for Markdown media links
            if (activity.agentMessaged?.agentMessage) {
              const msg = activity.agentMessaged.agentMessage;
              const mediaRegex = /!?\[.*?\]\((https?:\/\/.*?)\)/g;
              let match;
              while ((match = mediaRegex.exec(msg)) !== null) {
                const url = match[1];
                if (!downloadedMedia.has(url)) {
                  try {
                    const urlObj = new URL(url);
                    const ext = path.extname(urlObj.pathname).toLowerCase() || '.png';
                    const mediaExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.mp4', '.mov', '.webm'];
                    if (mediaExtensions.includes(ext)) {
                      const fileName = `media_${Date.now()}_${Math.floor(Math.random() * 1000)}${ext}`;
                      const dest = path.join(testDir, fileName);
                      downloadedMedia.add(url);
                      if (spinner.isSpinning) spinner.stop();
                      logger.info(`Downloading media: ${url}`);
                      spinner.start(chalk.bold.white(`∴ ${currentVerb}…`));
                      downloadFile(url, dest).catch(e => logger.warn(`Failed to save media: ${e.message}`));
                    }
                  } catch (e) {}
                }
              }
            }

            // 2. Scan artifacts for media URLs
            if (activity.artifacts && Array.isArray(activity.artifacts)) {
              for (const art of activity.artifacts) {
                const url = art.url || art.mediaUrl || art.uri;
                if (url && typeof url === 'string' && url.startsWith('http') && !downloadedMedia.has(url)) {
                  try {
                    const urlObj = new URL(url);
                    const ext = path.extname(urlObj.pathname).toLowerCase() || '.png';
                    const mediaExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.mp4', '.mov', '.webm'];
                    if (mediaExtensions.includes(ext)) {
                      const fileName = `artifact_${Date.now()}_${Math.floor(Math.random() * 1000)}${ext}`;
                      const dest = path.join(testDir, fileName);
                      downloadedMedia.add(url);
                      if (spinner.isSpinning) spinner.stop();
                      logger.info(`Downloading artifact media: ${url}`);
                      spinner.start(chalk.bold.white(`∴ ${currentVerb}…`));
                      downloadFile(url, dest).catch(e => logger.warn(`Failed to save artifact media: ${e.message}`));
                    }
                  } catch (e) {}
                }
              }
            }
          }
          // --- End Test Project Media Handling ---

          if (!seenActivities.has(activity.name)) {
            // Plan Approval Block
            if (activity.planGenerated?.plan && !approvedPlans.has(activity.name)) {
              approvedPlans.add(activity.name);
              
              if (spinner.isSpinning) spinner.stop();
              
              console.log('');
              console.log(chalk.bold.white('Planned changes:'));
              activity.planGenerated.plan.steps.forEach((s: any) => {
                console.log(`  ${chalk.cyan('◇')} ${chalk.bold.white(s.title || s.description)}`);
                if (s.title && s.description) {
                  console.log(`    ${chalk.dim(s.description)}`);
                }
              });
              console.log('');

              const isAlreadyApproved = activities.some((a: any) => 
                a.progressUpdated || 
                a.description?.toLowerCase().includes('step') || 
                a.planApproved
              );

              if (!isAlreadyApproved) {
                let approvePlan = true;
                if (currentMode === 'plan') {
                  // Temporarily remove keypress cancel listener during prompt
                  process.stdin.removeListener('keypress', sessionKeypressHandler);
                  if (process.stdin.isTTY) {
                    process.stdin.setRawMode(wasRaw);
                  }
                  
                  const approve = await askUser(chalk.bold.white('Approve plan? (y/n): '));

                  if (process.stdin.isTTY) {
                    process.stdin.setRawMode(true);
                  }
                  process.stdin.resume();
                  process.stdin.prependListener('keypress', sessionKeypressHandler);

                  if (approve.trim().toLowerCase() !== 'y') {
                    approvePlan = false;
                  }
                } else {
                  logger.success('Plan approved automatically (Fast Mode).');
                }

                if (!approvePlan) {
                  logger.warn('Plan rejected. Cancelling session.');
                  completed = true;
                  break;
                }

                const approveSpinner = ora({ text: chalk.dim('Approving plan…'), spinner: 'dots', color: 'white' }).start();
                try {
                  await approveJulesPlan(sessionId);
                  approveSpinner.stop();
                } catch (e: any) {
                  approveSpinner.stop();
                }
              }
              
              spinner.start(chalk.bold.white(`∴ ${currentVerb}…`));
            }

            // Print agent messages in the activities feed too, if not already handled
            if (activity.agentMessaged?.agentMessage && !printedAgentMessages.has(activity.id)) {
              if (spinner.isSpinning) spinner.stop();
              const cols = process.stdout.columns || 80;
              const wrapWidth = Math.max(20, cols - 10);
              const wrappedMsg = wrapText(activity.agentMessaged.agentMessage, wrapWidth, '          ');
              console.log('\n' + chalk.bold.white('💬 Jules: ') + chalk.white(wrappedMsg));
              printedAgentMessages.add(activity.id);
              spinner.start(chalk.bold.white(`∴ ${currentVerb}…`));
            }

            if (activity.planApproved) {
              if (spinner.isSpinning) spinner.stop();
              logger.success('Plan approved 🎉');
              spinner.start(chalk.bold.white(`∴ ${currentVerb}…`));
            }

            // Detect step progress & print tool use
            if (activity.progressUpdated?.title || activity.progressUpdated?.description || activity.description) {
              const title = activity.progressUpdated?.title || '';
              const description = activity.progressUpdated?.description || activity.description || '';
              const text = title + (title && description ? ': ' : '') + description;
              if (spinner.isSpinning) spinner.stop();
              printToolUse(text);
              spinner.start(chalk.bold.white(`∴ ${currentVerb}…`));
            }
            
            seenActivities.add(activity.name);
          }
        }

        if (status.state === 'COMPLETED') {
          if (spinner.isSpinning) spinner.stop();
          clearInterval(verbInterval);
          console.log('');
          logger.success('Jules completed the task!');
          
          const finalActivity = activities.find((a: any) => 
            a.artifacts?.some((art: any) => art.changeSet || art.codeChanges)
          );

          if (finalActivity) {
            const artifact = finalActivity.artifacts.find((art: any) => art.changeSet || art.codeChanges);
            let changes: CodeChange[] = [];
            
            if (artifact.codeChanges) {
              changes = artifact.codeChanges.files;
            } else if (artifact.changeSet) {
              const gitPatch = artifact.changeSet.gitPatch;
              if (gitPatch && gitPatch.unidiffPatch) {
                 const patches = parsePatch(gitPatch.unidiffPatch);
                 changes = patches.map(p => {
                   let filePath = p.newFileName || p.oldFileName || 'unknown';
                   filePath = filePath.replace(/^[ab]\//, '');
                   return {
                     path: filePath,
                     diff: formatPatch(p)
                   };
                 });
              }
            }

            if (changes.length > 0) {
              logger.info(`Applying ${changes.length} file changes...`);
              const applied = await applyChanges(changes);
              if (applied) {
                restoreExternalMappedFiles();
              }
            } else {
              logger.warn('No valid code changes found in the artifact.');
            }
          } else {
            logger.warn('No code changes found in the completed session.');
          }

          // Untrack finished session
          if (shellState.trackedSessionId === sessionId) {
            shellState.trackedSessionId = null;
            saveSettings({ trackedSessionId: null });
          }
          completed = true;
        } else if (status.state === 'FAILED') {
          if (spinner.isSpinning) spinner.stop();
          clearInterval(verbInterval);
          logger.error('Jules session failed.');

          // Untrack failed session
          if (shellState.trackedSessionId === sessionId) {
            shellState.trackedSessionId = null;
            saveSettings({ trackedSessionId: null });
          }
          completed = true;
        } else if (status.state?.toUpperCase() === 'INACTIVE') {
          if (spinner.isSpinning) spinner.stop();
          console.log('\n' + chalk.bold.yellow('⏸ Session is inactive - chat to resume'));
          
          process.stdin.removeListener('keypress', sessionKeypressHandler);
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(wasRaw);
          }

          const userReply = await promptJulesReply('Chat to resume (or type /exit):');

          if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
          }
          process.stdin.resume();
          process.stdin.prependListener('keypress', sessionKeypressHandler);

          if (userReply.trim().toLowerCase() === '/exit') {
            completed = true;
            break;
          }
          if (userReply.trim().toLowerCase() === '/untrack') {
            performUntrack();
            break;
          }

          const msgSpinner = ora({ text: chalk.dim('Sending message to resume…'), spinner: 'dots', color: 'white' }).start();
          const bridgedReply = bridgePathsInText(userReply);
          await syncLocalChanges();
          
          await sendJulesMessage(sessionId, bridgedReply);
          msgSpinner.stop();
          logger.success('Message sent successfully. Resuming session...');
          
          spinner.start(chalk.bold.white(`∴ ${currentVerb}…`));
          continue; // Poll again immediately
        } else {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (pollError: any) {
        const isNetworkError = !pollError.response && (
          pollError.code === 'ENOTFOUND' || 
          pollError.code === 'ECONNREFUSED' || 
          pollError.code === 'ETIMEDOUT' ||
          pollError.message.includes('Network Error')
        );

        if (isNetworkError) {
          if (!isOffline) {
            isOffline = true;
            spinner.text = chalk.yellow('⚠ OFFLINE: Waiting for internet connection...');
          }
          await new Promise(resolve => setTimeout(resolve, 5000));
          continue;
        }

        if (spinner.isSpinning) spinner.stop();
        if (pollError.response?.status === 404) {
           clearInterval(verbInterval);
           if (repoUrl) {
             logger.error(`Jules could not find the repository/session.`);
             logger.info(`Ensure that the Google Jules GitHub App is installed and has access to your repository:`);
             logger.info(`  ${sanitizeUrlForDisplay(repoUrl)}`);
           } else {
             logger.error('Session not found (404). Stopping.');
           }
           throw pollError; 
        }
        logger.error(`Polling error: ${pollError.message}`);
        spinner.start(chalk.bold.white(`∴ ${currentVerb}…`));
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  } finally {
    process.stdin.removeListener('keypress', sessionKeypressHandler);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(wasRaw);
    }
  }
}

async function handleEdit(instruction: string) {
  await enforceWorkspace();
  validateEnv();
  let repoUrl = '';
  let spinner: any = null;
  try {
    await ensureGitAndRemoteLinked();
    // 1. Bridge paths in instruction
    const bridgedInstruction = bridgePathsInText(instruction);

    // 2. Sync
    await syncLocalChanges();

    const rawRemoteUrl = await getRemoteUrl();
    if (!rawRemoteUrl) {
      throw new Error('Could not find remote URL. Please ensure your project is linked to a shadow repository.');
    }

    // Clean auth token from URL before passing to Jules API
    repoUrl = rawRemoteUrl.replace(/https:\/\/[^@]+@/, 'https://');

    let sessionId = shellState.trackedSessionId;
    
    if (sessionId) {
      // Validate that the tracked session is still active/resumable
      try {
        const status = await getSessionStatus(sessionId);
        const state = (status.state || '').toUpperCase();
        // Comprehensive list of terminal states to be safe
        const terminalStates = ['COMPLETED', 'FAILED', 'CANCELLED', 'ERROR', 'SUCCESS', 'SUCCEEDED', 'FINISHED'];
        
        if (terminalStates.includes(state)) {
          logger.warn(`Tracked session ${chalk.dim(sessionId)} is already ${state}.`);
          logger.info('Starting a new session for your new instruction.');
          sessionId = null;
          shellState.trackedSessionId = null;
          saveSettings({ trackedSessionId: null });
        }
      } catch (err: any) {
        if (err.response?.status === 404) {
          logger.warn(`Tracked session ${chalk.dim(sessionId)} no longer exists.`);
          sessionId = null;
          shellState.trackedSessionId = null;
          saveSettings({ trackedSessionId: null });
        }
        // For other network errors, we'll try to continue and let sendJulesMessage handle it
      }
    }

    if (sessionId) {
      logger.info(`Continuing tracked session: ${chalk.dim(sessionId)}`);
      logger.info(`(To start a new session instead, run "/session untrack")`);
      
      spinner = ora({
        text: chalk.dim('Sending instruction to Jules…'),
        spinner: 'dots',
        color: 'white'
      }).start();
      
      try {
        await sendJulesMessage(sessionId, bridgedInstruction);
      } catch (err: any) {
        spinner.stop();
        throw err;
      }
      spinner.stop();
      logger.success(`Instruction sent to session · ${chalk.dim(sessionId)}`);
    } else {
      // 4. Create Jules Session
      const branch = await getCurrentBranch();
      const match = repoUrl.match(/github\.com[\/:](.+?)\/(.+?)(\.git)?$/);
      if (match) {
        const [, owner, repo] = match;
        logger.info(`Creating session for:`);
        logger.info(`  sources/github/${owner}/${repo}`);
        logger.info(`  (branch: ${branch})`);
      }

      spinner = ora({
        text: chalk.dim('Starting Jules session…'),
        spinner: 'dots',
        color: 'white'
      }).start();

      let session;
      let retries = 3;
      while (retries >= 0) {
        try {
          session = await createJulesSession(bridgedInstruction, repoUrl, branch);
          break;
        } catch (err: any) {
          if (err.response?.status === 404 && retries > 0) {
            retries--;
            spinner.text = chalk.yellow(`⚠ Waiting for GitHub app sync... Retrying in 3s (${retries} retries left)`);
            await new Promise(resolve => setTimeout(resolve, 3000));
            spinner.text = chalk.dim('Starting Jules session…');
            continue;
          }
          throw err;
        }
      }

      if (!session) {
        throw new Error('Failed to create Jules session after retries.');
      }

      sessionId = session.id || session.name.split('/').pop();
      spinner.stop();
      logger.success(`Session started · ${chalk.dim(sessionId)}`);
      
      // Auto-track new session
      shellState.trackedSessionId = sessionId;
      saveSettings({ trackedSessionId: sessionId });
    }

    // 5. Polling Loop
    await trackJulesSession(sessionId!, repoUrl);
  } catch (error: any) {
    if (spinner && spinner.isSpinning) {
      spinner.stop();
    }
    if (error.response?.status === 404) {
      logger.error(`Edit failed: Jules could not find the repository.`);
      logger.info(`Ensure that the Google Jules GitHub App is installed and has access to your repository:`);
      logger.info(`  ${sanitizeUrlForDisplay(repoUrl)}`);
      logger.info(`You can check connected sources at https://jules.google.com/settings`);
    } else {
      logger.error(`Edit failed: ${error.message}`);
      if (error.response?.data) {
        console.error(JSON.stringify(error.response.data, null, 2));
      }
    }
  } finally {
    closeAskUser();
  }
}


async function handleUsageCommand() {
  const spinner = ora({ text: chalk.dim('Fetching session data…'), spinner: 'dots', color: 'white' }).start();

  try {
    const allSessions: any[] = await listJulesSessions();
    spinner.stop();

    const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const todaySessions   = allSessions.filter(s => (s.createTime || '').startsWith(todayStr));
    const todayCompleted  = todaySessions.filter(s => s.state === 'COMPLETED');
    const todayRunning    = todaySessions.filter(s => s.state === 'RUNNING' || s.state === 'PENDING' || s.state === 'IN_PROGRESS');
    const todayFailed     = todaySessions.filter(s => s.state === 'FAILED' || s.state === 'CANCELLED' || s.state === 'ERROR');

    const totalCompleted  = allSessions.filter(s => s.state === 'COMPLETED');
    const totalRunning    = allSessions.filter(s => s.state === 'RUNNING' || s.state === 'PENDING' || s.state === 'IN_PROGRESS');
    const totalFailed     = allSessions.filter(s => s.state === 'FAILED' || s.state === 'CANCELLED' || s.state === 'ERROR');

    const stateBadge = (state: string) => {
      switch ((state || '').toUpperCase()) {
        case 'COMPLETED':   return chalk.green('✓ COMPLETED');
        case 'RUNNING':     return chalk.yellow('⠋ RUNNING  ');
        case 'PENDING':     return chalk.yellow('○ PENDING  ');
        case 'IN_PROGRESS': return chalk.yellow('⠋ RUNNING  ');
        case 'AWAITING_USER_FEEDBACK': return chalk.yellow('💬 FEEDBACK ');
        case 'FAILED':      return chalk.red('✗ FAILED   ');
        case 'CANCELLED':   return chalk.dim('○ CANCELLED');
        case 'ERROR':       return chalk.red('✗ ERROR    ');
        default:            return chalk.dim(`○ ${state || 'UNKNOWN'}`);
      }
    };

    const timeAgo = (iso: string) => {
      const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
      if (diff < 60)   return `${diff}s ago`;
      if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
      if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
      return `${Math.floor(diff / 86400)}d ago`;
    };

    console.log('');
    console.log(chalk.bold.white('📊 JULES USAGE STATS'));
    console.log(chalk.dim('─'.repeat(45)));
    
    console.log(`${chalk.bold.cyan('  TODAY')} (${todayStr})`);
    console.log(`  ${chalk.green('✓ Completed')}  ${chalk.bold(String(todayCompleted.length))}`);
    console.log(`  ${chalk.yellow('⟳ Running')}    ${chalk.bold(String(todayRunning.length))}`);
    console.log(`  ${chalk.red('✖ Failed')}     ${chalk.bold(String(todayFailed.length))}`);
    console.log(`  Total today: ${chalk.bold(String(todaySessions.length))}`);
    
    console.log(chalk.dim('  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─'));
    
    console.log(`${chalk.bold.cyan('  ALL TIME')}`);
    console.log(`  ${chalk.green('✓ Completed')}  ${chalk.bold(String(totalCompleted.length))}`);
    console.log(`  ${chalk.yellow('⟳ Running')}    ${chalk.bold(String(totalRunning.length))}`);
    console.log(`  ${chalk.red('✖ Failed')}     ${chalk.bold(String(totalFailed.length))}`);
    console.log(`  Total sessions: ${chalk.bold(String(allSessions.length))}`);
    console.log(chalk.dim('─'.repeat(45)));

    if (todaySessions.length === 0) {
      console.log(chalk.gray('  No sessions today yet.\n'));
    } else {
      console.log(`\n${chalk.bold.white('  Today\'s Sessions:')}`);
      todaySessions.forEach((s) => {
        const badge  = stateBadge(s.state);
        const time   = s.createTime ? timeAgo(s.createTime) : '?';
        const title  = s.title || s.prompt || 'Untitled';
        const id     = (s.id || s.name?.split('/').pop() || '?').slice(0, 18);
        console.log(`  ${badge} ${chalk.white(title)}`);
        console.log(`             ${chalk.dim(id + '  ·  ' + time)}`);
      });
      console.log('');
    }

  } catch (err: any) {
    spinner.stop();
    logger.error(`Failed to fetch usage: ${err.response?.data?.error?.message || err.message}`);
  }
}

async function handleDocs() {
  console.log('');
  console.log(chalk.bold.white('📚 JULES CLI - DOCUMENTATION'));
  console.log(chalk.dim('─'.repeat(60)));
  
  console.log(`\n${chalk.bold.cyan('1. WORKSPACE MANAGEMENT')}`);
  console.log(chalk.white('   Jules operates inside a "Jules-Workspace" folder. If not found,'));
  console.log(chalk.white('   it is created in your current directory. Use it to keep projects isolated.'));
  
  console.log(`\n${chalk.bold.cyan('2. AI EDITING (DIRECT CHAT)')}`);
  console.log(chalk.white('   Just type your instruction (e.g., "Add a login page") and press Enter.'));
  console.log(chalk.white('   Jules will sync your code to a shadow repo, edit it, and apply patches locally.'));
  
  console.log(`\n${chalk.bold.cyan('3. TEST PROJECT & MEDIA')}`);
  console.log(chalk.white('   If your prompt contains "test project", a "Test/" folder is created.'));
  console.log(chalk.white('   Screenshots and videos sent by Jules are automatically downloaded there.'));
  
  console.log(`\n${chalk.bold.cyan('4. SMART OFFLINE MODE')}`);
  console.log(chalk.white('   If internet drops, the CLI waits and retries automatically.'));
  console.log(chalk.white('   Jules continues working in the cloud; sync resumes once you are back online.'));
  
  console.log(`\n${chalk.bold.cyan('5. SESSION BEHAVIOR (NEW VS SAME)')}`);
  console.log(chalk.white('   • Every prompt typed at the "jules >" shell starts a brand NEW session.'));
  console.log(chalk.white('   • Interactive replies (during active tasks) run on the SAME active session.'));
  console.log(chalk.white('   • Sequential tasks flow naturally because changes from completed sessions'));
  console.log(chalk.white('     are saved locally and synced automatically when a new session starts.'));
  console.log(chalk.white('   • Shift/Resume Session: You can resume a session if its temporary branch is'));
  console.log(chalk.white('     still on GitHub. Use "/session ls" to list and "/session track [ID]" to shift.'));

  console.log(`\n${chalk.bold.cyan('6. KEY COMMANDS')}`);
  console.log(chalk.white('   • /init                  : Link local project to Jules shadow repository'));
  console.log(chalk.white('   • /sync                  : Manually push local changes to the cloud'));
  console.log(chalk.white('   • /session [ls|rm|track] : List, delete, or track/resume active sessions'));
  console.log(chalk.white('   • /restore               : Recover files from automatic backups (.bak)'));
  console.log(chalk.white('   • /docs                  : Show this documentation manual'));
  
  console.log(`\n${chalk.bold.cyan('7. CLOUD PERSISTENCE')}`);
  console.log(chalk.white('   Your sessions and shadow repositories are stored in the cloud.'));
  console.log(chalk.white('   Access them anytime at https://jules.google.com'));

  console.log(`\n${chalk.bold.cyan('8. PROJECT INFORMATION')}`);
  console.log(chalk.white('   • Open Source : Jules CLI is an Open Source project'));
  console.log(chalk.white('   • GitHub      : https://github.com/v54087912-collab/Jules-CLI.git'));
  
  console.log(`\n${chalk.bold.cyan('9. CONTACT & COMMUNITY')}`);
  console.log(chalk.white('   • Developer   : https://t.me/R3V_X'));
  console.log(chalk.white('   • Community   : https://t.me/allinformation0173'));
  console.log(chalk.white('   • Instagram   : https://www.instagram.com/opeditzxx/'));

  console.log('\n' + chalk.dim('─'.repeat(60)));
  console.log(chalk.italic.dim('   Happy Coding with Jules!'));
  console.log('');
}

async function handleShortcutsCommand() {
  console.log('');
  console.log(chalk.bold.white('⌨️  JULES CLI - KEYBOARD SHORTCUTS'));
  console.log(chalk.dim('─'.repeat(60)));

  const printGroup = (title: string, items: { keys: string; desc: string }[]) => {
    console.log(`\n${chalk.bold.cyan(title)}`);
    for (const item of items) {
      console.log(`  ${chalk.bold.yellow(item.keys.padEnd(20))} ${chalk.white(item.desc)}`);
    }
  };

  printGroup('Navigation', [
    { keys: 'Ctrl + A',     desc: 'Go to start of line' },
    { keys: 'Ctrl + E',     desc: 'Go to end of line' },
    { keys: 'Ctrl + B',     desc: 'Move back one character' },
    { keys: 'Ctrl + F',     desc: 'Move forward one character' },
    { keys: 'Alt + B',      desc: 'Move back one word' },
    { keys: 'Alt + F',      desc: 'Move forward one word' },
    { keys: 'Ctrl + X, X',  desc: 'Toggle cursor between start and current position' },
  ]);

  printGroup('Editing', [
    { keys: 'Ctrl + U',     desc: 'Delete from cursor to start of line' },
    { keys: 'Ctrl + K',     desc: 'Delete from cursor to end of line' },
    { keys: 'Ctrl + W',     desc: 'Delete previous word' },
    { keys: 'Alt + D',      desc: 'Delete next word' },
    { keys: 'Ctrl + D',     desc: 'Delete character under cursor' },
    { keys: 'Ctrl + H',     desc: 'Delete character before cursor (Backspace)' },
    { keys: 'Ctrl + Y',     desc: 'Paste last deleted/cut text (yank)' },
    { keys: 'Alt + Y',      desc: 'Cycle through yank history' },
    { keys: 'Ctrl + T',     desc: 'Swap current and previous character' },
    { keys: 'Alt + T',      desc: 'Swap current and previous word' },
    { keys: 'Alt + U',      desc: 'Change word to UPPERCASE' },
    { keys: 'Alt + L',      desc: 'Change word to lowercase' },
    { keys: 'Alt + C',      desc: 'Capitalize first letter of word' },
    { keys: 'Alt + .',      desc: 'Yank last argument from previous command' },
    { keys: 'Alt + R',      desc: 'Restore original line' },
    { keys: 'Alt + #',      desc: 'Comment line and insert into history' },
    { keys: 'Ctrl + X, E',  desc: 'Open current line in external editor' },
  ]);

  printGroup('History & Search', [
    { keys: 'Ctrl + R',     desc: 'Reverse search history (interactive)' },
    { keys: '!!',           desc: 'Expand to last command' },
    { keys: '!$',           desc: 'Expand to last argument of last command' },
    { keys: '!foo',         desc: 'Expand to last command starting with "foo"' },
    { keys: '^old^new',     desc: 'Replace "old" with "new" in last command and run' },
    { keys: ':p',           desc: 'Preview command expansion without running (e.g., !!:p)' },
  ]);

  printGroup('Active Session Control', [
    { keys: 'ESC / Ctrl + C', desc: 'Cancel and delete the active cloud task' },
    { keys: 'End',            desc: 'Untrack/stop monitoring session locally (continues in cloud)' },
  ]);

  printGroup('Control & Terminal', [
    { keys: 'Ctrl + Z',     desc: 'Suspend CLI process (SIGTSTP)' },
    { keys: 'Ctrl + \\',    desc: 'Terminate CLI process (SIGQUIT)' },
    { keys: 'Ctrl + C',     desc: 'Cancel current input or exit search mode' },
    { keys: 'Tab',          desc: 'Cycle autocomplete suggestions' },
    { keys: 'Shift+Tab/Meta+Tab', desc: 'Cycle autocomplete suggestions in reverse' },
  ]);

  console.log('\n' + chalk.dim('─'.repeat(60)));
  console.log('');
}

async function handleRestore() {
  await enforceWorkspace();
  try {
    const files = fs.readdirSync(process.cwd());
    const bakFiles = files.filter(f => f.endsWith('.bak'));
    
    if (bakFiles.length === 0) {
      logger.info('No backup (.bak) files found to restore.');
      return;
    }
    
    const restoreSpinner = ora({ text: chalk.dim('Restoring files…'), spinner: 'dots', color: 'white' }).start();
    
    let restoredCount = 0;
    for (let i = 0; i < bakFiles.length; i++) {
      const file = bakFiles[i];
      const originalFile = file.slice(0, -4);
      restoreSpinner.text = chalk.dim(`Restoring ${originalFile}…`);
      
      fs.copyFileSync(file, originalFile);
      fs.unlinkSync(file);
      restoredCount++;
    }
    
    restoreSpinner.stop();
    logger.success(`Successfully restored ${restoredCount} backup files.`);
  } catch (error: any) {
    logger.error(`Restore failed: ${error.message}`);
  }
}

async function handleSessionCommand(args: string[]) {
  await enforceWorkspace();
  validateEnv();
  const subcommand = args[0];
  
  if (subcommand === 'list' || subcommand === 'ls') {
    const listSpinner = ora({
      text: chalk.dim('Fetching sessions…'),
      spinner: 'dots',
      color: 'white'
    }).start();
    
    try {
      const sessions = await listJulesSessions();
      listSpinner.stop();
      
      if (sessions.length === 0) {
        logger.info('No active or past sessions found.');
        return;
      }
      
      console.log('');
      console.log(chalk.bold.white('  Sessions') + chalk.dim(` (${sessions.length} total)`));
      console.log(chalk.dim('  ' + '─'.repeat(60)));

      for (const session of sessions) {
        const id = session.id || session.name.split('/').pop();
        const state = session.state || 'UNKNOWN';
        const prompt = (session.prompt || 'No prompt').substring(0, 52);
        const createTime = session.createTime
          ? new Date(session.createTime).toLocaleString()
          : 'N/A';

        const stateIcon =
          state === 'COMPLETED'            ? chalk.green('✓') :
          state === 'FAILED'               ? chalk.red('✗') :
          state === 'AWAITING_USER_FEEDBACK' ? chalk.yellow('◆') :
          state === 'RUNNING'              ? chalk.cyan('⠋') :
                                             chalk.dim('○');

        console.log(
          `  ${stateIcon} ${chalk.white(prompt)}${prompt.length >= 52 ? chalk.dim('…') : ''}` +
          `\n    ${chalk.dim(id + '  ·  ' + createTime)}`
        );
      }
      console.log(chalk.dim('  ' + '─'.repeat(60)));
      console.log('');
    } catch (error: any) {
      listSpinner.fail(`Failed to fetch sessions: ${error.message}`);
    }
  } else if (subcommand === 'delete' || subcommand === 'rm') {
    const sessionId = args[1];
    if (!sessionId) {
      logger.error('Error: Please specify a sessionId. Usage: /session delete [sessionId]');
      return;
    }
    
    const deleteSpinner = ora({
      text: chalk.dim(`Deleting session ${sessionId}…`),
      spinner: 'dots',
      color: 'white'
    }).start();
    
    try {
      await deleteJulesSession(sessionId);
      deleteSpinner.stop();
      logger.success(`Session deleted.`);
    } catch (error: any) {
      deleteSpinner.stop();
      logger.error(`Failed to delete: ${error.message}`);
    }
  } else if (subcommand === 'track' || subcommand === 'watch') {
    const sessionId = args[1];
    if (!sessionId) {
      logger.error('Error: Please specify a sessionId. Usage: /session track [sessionId]');
      return;
    }
    const validateSpinner = ora({ text: chalk.dim(`Validating session ${sessionId}…`), spinner: 'dots', color: 'white' }).start();
    try {
      const status = await getSessionStatus(sessionId);
      validateSpinner.stop();
      
      shellState.trackedSessionId = sessionId;
      saveSettings({ trackedSessionId: sessionId });
      logger.success(`Now tracking session: ${sessionId}`);
      const repoUrl = (await getRemoteUrl()) || undefined;
      await trackJulesSession(sessionId, repoUrl);
    } catch (error: any) {
      validateSpinner.stop();
      if (error.response?.status === 404) {
        logger.error(`⚠ Session not found: ${sessionId}`);
      } else {
        logger.error(`Failed to track session: ${error.message}`);
      }
    } finally {
      closeAskUser();
    }
  } else if (subcommand === 'untrack' || subcommand === 'clear' || subcommand === 'reset') {
    shellState.trackedSessionId = null;
    saveSettings({ trackedSessionId: null });
    logger.success('Stopped tracking session.');
  } else {
    logger.error('Usage: /session [list|delete|track|untrack] [sessionId]');
  }
}

const HISTORY_FILE = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.jules_history');

function appendHistory(line: string) {
  try {
    fs.appendFileSync(HISTORY_FILE, line + '\n');
  } catch (e) {}
}

function expandHistory(line: string, history: string[]): { expanded: string; changed: boolean } {
  if (history.length === 0) return { expanded: line, changed: false };
  
  const lastCmd = history[0];
  const lastArgs = lastCmd.split(/\s+/).slice(1);
  const lastArg = lastArgs[lastArgs.length - 1] || '';
  const allLastArgs = lastArgs.join(' ');

  let expanded = line;
  let changed = false;

  // Handle ^old^new
  if (line.startsWith('^')) {
    const parts = line.split('^');
    if (parts.length >= 3) {
      const oldStr = parts[1];
      const newStr = parts[2];
      expanded = lastCmd.replace(oldStr, newStr);
      return { expanded, changed: true };
    }
  }

  // Replace !!
  if (expanded.includes('!!')) {
    expanded = expanded.replace(/!!/g, lastCmd);
    changed = true;
  }

  // Replace !$
  if (expanded.includes('!$')) {
    expanded = expanded.replace(/!\$/g, lastArg);
    changed = true;
  }

  // Replace !*
  if (expanded.includes('!*')) {
    expanded = expanded.replace(/!\*/g, allLastArgs);
    changed = true;
  }

  // Replace !<text>
  const bangMatch = expanded.match(/!([a-zA-Z0-9_\-\/]+)/);
  if (bangMatch) {
    const search = bangMatch[1];
    const matchedCmd = history.find(h => h.startsWith(search) || h.startsWith('/' + search));
    if (matchedCmd) {
      expanded = expanded.replace(bangMatch[0], matchedCmd);
      changed = true;
    }
  }

  return { expanded, changed };
}

async function startShell() {
  await enforceWorkspace();
  await ensureGitAndRemoteLinked();
  printBanner();

  const commandsList = ['/init', '/sync', '/edit', '/restore', '/session', '/usage', '/plan', '/fast', '/clear', '/help', '/docs', '/shot', '/exit'];

  const PROMPT_STR = '> ';
  const PROMPT_LEN = PROMPT_STR.length;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.bold.white(PROMPT_STR),
    completer: (line: string) => {
      // Disable default readline tab completion to avoid double-printing
      return [[], line];
    }
  });
  
  shellState.activeRl = rl;

  // Load history from file
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
      (rl as any).history = lines.reverse();
    } catch (e) {}
  }

  let cachedBranch = 'main';
  try {
    cachedBranch = await getCurrentBranch() || 'main';
  } catch (e) {}

  let activeBottomLines = 0;
  let cyclingIndex = -1;
  let originalLine = '';
  let activeMatches: string[] = [];
  let lastActiveMatches: string[] = [];
  let lastCyclingIndex = -1;
  let isCycling = false;
  let accumulatedLines: string[] = [];
  let altEnterPressed = false;

  let isPasting = false;
  let pasteBuffer = '';
  let oldTtyWrite: any = null;
  let shellPastedBlocks: string[] = [];
  let shellPasteCount = 0;

  const disableShellBracketedPaste = () => {
    process.stdout.write('\u001b[?2004l');
  };
  process.on('exit', disableShellBracketedPaste);

  const arraysEqual = (a: string[], b: string[]) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  };

  const clearBottomArea = () => {
    if (activeBottomLines === 0) return;
    const col = PROMPT_LEN + rl.cursor;
    for (let i = 0; i < activeBottomLines; i++) {
      readline.moveCursor(process.stdout, 0, 1);
      readline.clearLine(process.stdout, 0);
    }
    readline.moveCursor(process.stdout, 0, -activeBottomLines);
    readline.cursorTo(process.stdout, col);
    activeBottomLines = 0;
  };

  const clearBottomAreaOnEnter = () => {
    if (activeBottomLines === 0) return;
    readline.clearLine(process.stdout, 0);
    for (let i = 1; i < activeBottomLines; i++) {
      readline.moveCursor(process.stdout, 0, 1);
      readline.clearLine(process.stdout, 0);
    }
    if (activeBottomLines > 1) {
      readline.moveCursor(process.stdout, 0, -(activeBottomLines - 1));
    }
    activeBottomLines = 0;
  };

  const drawBottomArea = (matches: string[] = []) => {
    const rows = process.stdout.rows || 24;
    if (rows < 15) {
      clearBottomArea();
      shellState.isBottomAreaRendered = false;
      return;
    }
    shellState.isBottomAreaRendered = true;
    clearBottomArea();

    const cols = process.stdout.columns || 80;
    const lines: string[] = [];
    lines.push(chalk.dim('─'.repeat(Math.max(0, cols - 1))));

    if (matches.length > 0) {
      const prefix = '  ⎿ ';
      const styledMatches = matches.map((m, idx) => 
        idx === cyclingIndex ? chalk.bold.white(m) : chalk.dim(m)
      );

      const itemSeparator = '  ';
      let plainText = prefix;
      let keepCount = 0;

      for (let i = 0; i < matches.length; i++) {
        const item = matches[i];
        const nextLength = plainText.length + (i > 0 ? itemSeparator.length : 0) + item.length;
        if (nextLength > cols - 8) {
          break;
        }
        plainText += (i > 0 ? itemSeparator : '') + item;
        keepCount++;
      }

      if (keepCount === 0 && matches.length > 0) {
        keepCount = 1;
      }

      const displayMatches = styledMatches.slice(0, keepCount);
      let formattedText = chalk.dim(prefix) + displayMatches.join(chalk.dim(itemSeparator));
      if (keepCount < matches.length) {
        formattedText += chalk.dim('  …');
      }

      lines.push(formattedText);
    }

    const left = '/shot for shortcuts';
    const right = '/session';
    const spaceCount = Math.max(2, cols - left.length - right.length - 10);
    const footer = chalk.dim('  ' + left + ' '.repeat(spaceCount) + right);
    lines.push(footer);

    const fullCwd = process.cwd();
    const mode = currentMode.toUpperCase();

    // Truncate path to avoid wrapping
    const infoPrefix = `  ⬢ jules-cli · ${mode} · `;
    const infoSuffix = ` [${cachedBranch}]`;
    const available = cols - infoPrefix.length - infoSuffix.length - 5;
    let pathPart = fullCwd;
    if (pathPart.length > available && available > 10) {
      pathPart = '...' + pathPart.slice(-(available - 3));
    }

    const statusLine = chalk.dim(`  ⬢ jules-cli `) + chalk.bold.cyan(`· ${mode} · `) + chalk.dim(`${pathPart}${infoSuffix}`);
    lines.push(statusLine);
    lines.push(chalk.dim('─'.repeat(Math.max(0, cols - 1))));

    const col = PROMPT_LEN + rl.cursor;
    for (const line of lines) {
      process.stdout.write(`\n\r\u001b[2K${line}`);
    }

    activeBottomLines = lines.length;
    readline.moveCursor(process.stdout, 0, -activeBottomLines);
    readline.cursorTo(process.stdout, col);
  };

  const showPrompt = () => {
    const cols = process.stdout.columns || 80;
    process.stdout.write('\n' + chalk.dim('─'.repeat(Math.max(0, cols - 1))) + '\n');

    rl.prompt();

    activeMatches = [];
    cyclingIndex = -1;
    lastCyclingIndex = -1;
    drawBottomArea([]);
    shellState.isBottomAreaRendered = true;

    // Refresh branch in background
    getCurrentBranch().then(br => {
      if (br) {
        cachedBranch = br;
        if (shellState.isBottomAreaRendered) {
          drawBottomArea(activeMatches);
        }
      }
    }).catch(() => {});
  };

  const handleTabKey = (reverse = false) => {
    if (activeMatches.length === 0) return;

    if (cyclingIndex === -1) {
      originalLine = rl.line;
    }

    const total = activeMatches.length;
    if (reverse) {
      cyclingIndex = cyclingIndex - 1;
      if (cyclingIndex < -1) {
        cyclingIndex = total - 1;
      }
    } else {
      cyclingIndex = cyclingIndex + 1;
      if (cyclingIndex >= total) {
        cyclingIndex = -1;
      }
    }

    if (cyclingIndex === -1) {
      (rl as any).line = originalLine;
    } else {
      (rl as any).line = activeMatches[cyclingIndex];
    }
    (rl as any).cursor = (rl as any).line.length;
    (rl as any)._refreshLine();

    drawBottomArea(activeMatches);
  };

  let searchMode = false;
  let searchQuery = '';
  let searchResultIndex = -1;
  let ctrlXPrefix = false;
  let lastSavedCursor = 0;

  const updateSearchDisplay = () => {
    const history = (rl as any).history || [];
    let match = '';
    
    if (searchQuery) {
      const startIdx = searchResultIndex >= 0 ? searchResultIndex : 0;
      let foundIdx = -1;
      for (let i = startIdx; i < history.length; i++) {
        if (history[i].includes(searchQuery)) {
          foundIdx = i;
          break;
        }
      }
      if (foundIdx !== -1) {
        searchResultIndex = foundIdx;
        match = history[foundIdx];
      } else {
        for (let i = 0; i < history.length; i++) {
          if (history[i].includes(searchQuery)) {
            foundIdx = i;
            break;
          }
        }
        if (foundIdx !== -1) {
          searchResultIndex = foundIdx;
          match = history[foundIdx];
        }
      }
    }
    
    process.stdout.write('\r\u001b[2K');
    const promptStr = `(reverse-i-search)'${searchQuery}': ${match || ''}`;
    process.stdout.write(promptStr);
    
    (rl as any).line = match || '';
    (rl as any).cursor = match ? match.indexOf(searchQuery) : 0;
  };

  const exitSearchMode = (keepResult = true) => {
    searchMode = false;
    searchQuery = '';
    searchResultIndex = -1;
    
    process.stdout.write('\r\u001b[2K');
    showPrompt();
    (rl as any)._refreshLine();
  };

  const modifyWordAtCursor = (modifier: (word: string) => string) => {
    const line = rl.line;
    const pos = rl.cursor;
    if (pos === 0) return;
    
    let start = pos - 1;
    while (start >= 0 && /\w/.test(line[start])) {
      start--;
    }
    start++;
    
    let end = pos;
    while (end < line.length && /\w/.test(line[end])) {
      end++;
    }
    
    const word = line.substring(start, end);
    if (word) {
      const modified = modifier(word);
      const newLine = line.substring(0, start) + modified + line.substring(end);
      (rl as any).line = newLine;
      (rl as any).cursor = end;
      (rl as any)._refreshLine();
    }
  };

  const swapWordsAtCursor = () => {
    const line = rl.line;
    const pos = rl.cursor;
    
    const words = line.split(/(\s+)/);
    let charCount = 0;
    let wordIdx = -1;
    for (let i = 0; i < words.length; i++) {
      charCount += words[i].length;
      if (pos <= charCount) {
        wordIdx = i;
        break;
      }
    }
    
    if (wordIdx !== -1) {
      let prevWordIdx = wordIdx - 1;
      while (prevWordIdx >= 0 && /^\s*$/.test(words[prevWordIdx])) {
        prevWordIdx--;
      }
      
      if (prevWordIdx >= 0) {
        const temp = words[wordIdx];
        words[wordIdx] = words[prevWordIdx];
        words[prevWordIdx] = temp;
        
        const newLine = words.join('');
        (rl as any).line = newLine;
        (rl as any).cursor = charCount;
        (rl as any)._refreshLine();
      }
    }
  };

  const toggleCursorPosition = () => {
    const current = rl.cursor;
    if (current === 0) {
      (rl as any).cursor = lastSavedCursor;
    } else {
      lastSavedCursor = current;
      (rl as any).cursor = 0;
    }
    (rl as any)._refreshLine();
  };

  const openLineInEditor = () => {
    const editor = process.env.EDITOR || process.env.VISUAL || 'nano';
    const tempFile = path.join(
      process.env.TMPDIR || process.env.TEMP || '/tmp',
      `jules_edit_${Date.now()}.sh`
    );
    
    fs.writeFileSync(tempFile, rl.line);
    
    rl.pause();
    disableShellBracketedPaste();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    
    const { spawn } = require('child_process');
    const child = spawn(editor, [tempFile], { stdio: 'inherit' });
    
    child.on('exit', () => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdout.write('\u001b[?2004h');
      rl.resume();
      
      if (fs.existsSync(tempFile)) {
        const edited = fs.readFileSync(tempFile, 'utf8').trim();
        (rl as any).line = edited;
        (rl as any).cursor = edited.length;
        fs.unlinkSync(tempFile);
      }
      
      (rl as any)._refreshLine();
    });
  };

  const handleKeypress = (char: any, key: any) => {
    const seq = key?.sequence || char || '';
    
    if (seq === '\u001b[200~') {
      isPasting = true;
      pasteBuffer = '';
      oldTtyWrite = (rl as any)._ttyWrite;
      (rl as any)._ttyWrite = (s: any, k: any) => {
        // Intercept and do nothing
      };
      if (key) { key.name = undefined; key.sequence = ''; }
      return;
    }
    
    if (seq === '\u001b[201~') {
      isPasting = false;
      if (oldTtyWrite) {
        (rl as any)._ttyWrite = oldTtyWrite;
        oldTtyWrite = null;
      }
      
      clearBottomArea();
      
      const line = rl.line;
      const pos = rl.cursor;
      const before = line.substring(0, pos);
      const after = line.substring(pos);
      
      if (isLongPaste(pasteBuffer)) {
        const wordCount = pasteBuffer.trim().split(/\s+/).filter(Boolean).length;
        shellPasteCount++;
        shellPastedBlocks.push(pasteBuffer);
        const placeholder = `[pasted text #${shellPasteCount} [${wordCount} words]]`;
        
        const newLine = before + placeholder + after;
        (rl as any).line = newLine;
        (rl as any).cursor = pos + placeholder.length;
      } else {
        const newLine = before + pasteBuffer + after;
        (rl as any).line = newLine;
        (rl as any).cursor = pos + pasteBuffer.length;
      }
      (rl as any)._refreshLine();
      drawBottomArea(activeMatches);
      
      if (key) { key.name = undefined; key.sequence = ''; }
      return;
    }
    
    if (isPasting) {
      if (char) {
        pasteBuffer += char;
      }
      if (key) { key.name = undefined; key.sequence = ''; }
      return;
    }

    if (searchMode) {
      if (key) {
        if (key.name === 'escape' || (key.ctrl && key.name === 'g') || (key.ctrl && key.name === 'c')) {
          exitSearchMode(false);
          return;
        }
        if (key.name === 'return' || key.name === 'enter') {
          exitSearchMode(true);
          return;
        }
        if (key.name === 'backspace') {
          searchQuery = searchQuery.slice(0, -1);
          searchResultIndex = -1;
          updateSearchDisplay();
          return;
        }
        if (key.ctrl && key.name === 'r') {
          searchResultIndex++;
          updateSearchDisplay();
          return;
        }
      }
      
      if (char && char.length === 1 && !key.ctrl && !key.meta) {
        searchQuery += char;
        searchResultIndex = -1;
        updateSearchDisplay();
        return;
      }
      return;
    }

    const isEscape = (key && key.name === 'escape') || char === '\u001b' || char === '\x1b';
    if (isEscape) {
      accumulatedLines = [];
      altEnterPressed = false;
      shellPastedBlocks = [];
      shellPasteCount = 0;
      rl.setPrompt(chalk.bold.white(PROMPT_STR));
      (rl as any).line = '';
      (rl as any).cursor = 0;
      (rl as any)._refreshLine();
      activeMatches = [];
      cyclingIndex = -1;
      lastCyclingIndex = -1;
      drawBottomArea([]);
      return;
    }

    if (key) {

      // Ctrl + Z (Suspend)
      if (key.ctrl && key.name === 'z') {
        disableShellBracketedPaste();
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.kill(process.pid, 'SIGTSTP');
        process.once('SIGCONT', () => {
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
          }
          process.stdout.write('\u001b[?2004h');
          (rl as any)._refreshLine();
          drawBottomArea(activeMatches);
        });
        return;
      }

      // Ctrl + \ (SIGQUIT)
      if (key.ctrl && key.name === 'backslash') {
        process.kill(process.pid, 'SIGQUIT');
        return;
      }

      // Ctrl + R (Reverse History Search)
      if (key.ctrl && key.name === 'r') {
        searchMode = true;
        searchQuery = '';
        searchResultIndex = -1;
        updateSearchDisplay();
        return;
      }

      // Alt + . or Esc + . (Yank last argument)
      if ((key.meta && char === '.') || (key.name === 'escape' && char === '.')) {
        const history = (rl as any).history || [];
        if (history.length > 0) {
          const lastCmd = history[0];
          const parts = lastCmd.split(/\s+/);
          const lastArg = parts[parts.length - 1] || '';
          const line = rl.line;
          const pos = rl.cursor;
          const newLine = line.substring(0, pos) + lastArg + line.substring(pos);
          (rl as any).line = newLine;
          (rl as any).cursor = pos + lastArg.length;
          (rl as any)._refreshLine();
        }
        return;
      }

      // Alt + U (Uppercase Word)
      if (key.meta && (char === 'u' || char === 'U')) {
        modifyWordAtCursor((w) => w.toUpperCase());
        return;
      }

      // Alt + L (Lowercase Word)
      if (key.meta && (char === 'l' || char === 'L')) {
        modifyWordAtCursor((w) => w.toLowerCase());
        return;
      }

      // Alt + C (Capitalize Word)
      if (key.meta && (char === 'c' || char === 'C')) {
        modifyWordAtCursor((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
        return;
      }

      // Alt + R (Restore original line)
      if (key.meta && (char === 'r' || char === 'R')) {
        (rl as any).line = originalLine;
        (rl as any).cursor = originalLine.length;
        (rl as any)._refreshLine();
        return;
      }

      // Alt + # (Comment line and insert to history)
      if (key.meta && char === '#') {
        const line = rl.line;
        if (line) {
          const commented = '#' + line;
          (rl as any).history.unshift(commented);
          appendHistory(commented);
          (rl as any).line = '';
          (rl as any).cursor = 0;
          (rl as any)._refreshLine();
        }
        return;
      }

      // Alt + T (Swap words)
      if (key.meta && (char === 't' || char === 'T')) {
        swapWordsAtCursor();
        return;
      }

      // Ctrl + X prefixed commands
      if (key.ctrl && key.name === 'x') {
        ctrlXPrefix = true;
        return;
      }

      if (ctrlXPrefix) {
        ctrlXPrefix = false;
        
        // Ctrl + X, Ctrl + E (edit in editor)
        if (key.ctrl && key.name === 'e') {
          openLineInEditor();
          return;
        }
        
        // Ctrl + X, Ctrl + X (toggle cursor)
        if (key.ctrl && key.name === 'x') {
          toggleCursorPosition();
          return;
        }
      }

      if (key.name === 'tab') {
        isCycling = true;
        const reverse = !!(key.shift || key.meta);
        handleTabKey(reverse);
        return;
      }

      // Handle backspace for multi-line support
      if (key.name === 'backspace' && rl.line === '' && accumulatedLines.length > 0) {
        const lastLine = accumulatedLines.pop() || '';
        (rl as any).line = lastLine;
        (rl as any).cursor = lastLine.length;
        
        // Move cursor up and clear line
        process.stdout.write('\x1b[1A\x1b[2K'); 
        
        // Set prompt based on if there are still accumulated lines
        if (accumulatedLines.length > 0) {
          rl.setPrompt('  ');
        } else {
          rl.setPrompt(chalk.bold.white(PROMPT_STR));
        }
        
        (rl as any)._refreshLine();
        return;
      }

      if (key.name === 'down') {
        if (activeMatches.length > 0) {
          isCycling = true;
          handleTabKey(false);
          key.name = undefined; // Prevent readline history navigation when cycling suggestions
          return;
        }
      }
      if (key.name === 'up') {
        if (activeMatches.length > 0) {
          isCycling = true;
          handleTabKey(true);
          key.name = undefined; // Prevent readline history navigation when cycling suggestions
          return;
        }
      }
      if (key.name === 'return' || key.name === 'enter' || char === '\u001b\r' || char === '\u001b\n') {
        if (key.meta || key.shift || key.ctrl || char === '\u001b\r' || char === '\u001b\n') {
          altEnterPressed = true;
          rl.setPrompt('  ');
          // Manually trigger line event for Alt+Enter as readline might not emit it
          const currentLine = rl.line;
          (rl as any).line = '';
          (rl as any).cursor = 0;
          process.stdout.write('\n');
          rl.emit('line', currentLine);
        }
        return;
      }
    }

    isCycling = false;

    process.nextTick(() => {
      if (!isCycling) {
        cyclingIndex = -1;
        originalLine = rl.line;
      }

      const line = rl.line;
      let newMatches: string[] = [];
      if (line.startsWith('/')) {
        newMatches = commandsList.filter(c => c.startsWith(line));
        if (newMatches.length > 0 && line === newMatches[0]) {
          newMatches = [];
        }
      }

      activeMatches = newMatches;
      lastCyclingIndex = cyclingIndex;
      drawBottomArea(activeMatches);
      shellState.isBottomAreaRendered = true;
    });
  };

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  shellState.keypressHandler = handleKeypress;
  process.stdin.prependListener('keypress', handleKeypress);

  console.log(chalk.dim('  Type /help for commands · /exit to quit'));
  process.stdout.write('\u001b[?2004h');
  showPrompt();

  shellState.shellLineHandler = async (line) => {
    const endsWithBackslash = line.endsWith('\\');
    if (altEnterPressed || endsWithBackslash) {
      const lineToPush = endsWithBackslash ? line.slice(0, -1) : line;
      accumulatedLines.push(lineToPush);
      altEnterPressed = false;
      rl.setPrompt('  ');
      rl.prompt();
      drawBottomArea([]);
      shellState.isBottomAreaRendered = true;
      return;
    }

    accumulatedLines.push(line);
    const fullLine = accumulatedLines.join('\n');
    accumulatedLines = [];
    rl.setPrompt(chalk.bold.white(PROMPT_STR));

    if (shellState.keypressHandler) {
      process.stdin.removeListener('keypress', shellState.keypressHandler);
    }
    disableShellBracketedPaste();
    
    clearBottomAreaOnEnter();
    shellState.isBottomAreaRendered = false;
    
    let substitutedLine = fullLine;
    for (let i = 0; i < shellPastedBlocks.length; i++) {
      const placeholderPattern = `[pasted text #${i + 1} [`;
      const idx = substitutedLine.indexOf(placeholderPattern);
      if (idx !== -1) {
        const endIdx = substitutedLine.indexOf(']]', idx + placeholderPattern.length);
        if (endIdx !== -1) {
          const fullPlaceholder = substitutedLine.substring(idx, endIdx + 2);
          substitutedLine = substitutedLine.replace(fullPlaceholder, shellPastedBlocks[i]);
        }
      }
    }
    shellPastedBlocks = [];
    shellPasteCount = 0;

    const input = substitutedLine.trim();
    if (!input) {
      if (shellState.keypressHandler) {
        process.stdin.prependListener('keypress', shellState.keypressHandler);
      }
      process.stdout.write('\u001b[?2004h');
      showPrompt();
      return;
    }

    // ── History Expansion ─────────────────────────────────────────
    const history = (rl as any).history || [];
    const { expanded, changed } = expandHistory(input, history);
    
    let finalInput = expanded;
    let printOnly = false;
    if (expanded.endsWith(':p')) {
      finalInput = expanded.substring(0, expanded.length - 2).trim();
      printOnly = true;
    }
    
    if (changed) {
      console.log(chalk.bold.cyan(finalInput));
      if (history.length > 0 && history[0] === input) {
        history.shift();
      }
      (rl as any).history.unshift(finalInput);
    }
    
    appendHistory(finalInput);
    
    if (printOnly) {
      if (shellState.keypressHandler) {
        process.stdin.prependListener('keypress', shellState.keypressHandler);
      }
      showPrompt();
      return;
    }

    // Print a subtle divider before processing
    process.stdout.write(chalk.dim('\n'));

    try {
      const [command, ...args] = finalInput.split(' ');

      if (!command.startsWith('/')) {
        // Direct chat mode: treat the whole line as an instruction
        try {
          rl.pause();
          await handleEdit(finalInput);
        } finally {
          rl.resume();
          if (shellState.keypressHandler) {
            process.stdin.prependListener('keypress', shellState.keypressHandler);
          }
          process.stdout.write('\u001b[?2004h');
        }
        showPrompt();
        return;
      }

      switch (command) {
        case '/init':
          try {
            rl.pause();
            await handleInit();
          } finally {
            rl.resume();
          }
          break;
        case '/sync':
          try {
            rl.pause();
            await handleSync();
          } finally {
            rl.resume();
          }
          break;
        case '/edit':
          if (args.length === 0) {
            logger.error('Usage: /edit [instruction]');
          } else {
            try {
              rl.pause();
              await handleEdit(args.join(' '));
            } finally {
              rl.resume();
            }
          }
          break;
        case '/restore':
          try {
            rl.pause();
            await handleRestore();
          } finally {
            rl.resume();
          }
          break;
        case '/session':
          try {
            rl.pause();
            await handleSessionCommand(args);
          } finally {
            rl.resume();
          }
          break;
        case '/plan':
          currentMode = 'plan';
          logger.success('Switched to PLAN mode (Manual plan approval required).');
          break;
        case '/fast':
          currentMode = 'fast';
          logger.success('Switched to FAST mode (Automatic plan approval enabled).');
          break;
        case '/docs':
          await handleDocs();
          break;
        case '/shot':
          await handleShortcutsCommand();
          break;
        case '/usage':
          try {
            rl.pause();
            await handleUsageCommand();
          } finally {
            rl.resume();
          }
          break;

        case '/help':
          console.log('');
          console.log(chalk.bold.white('  Commands:'));
          const cmd = (c: string, desc: string) => {
            console.log(`    ${chalk.bold.cyan(c.padEnd(28))} ${chalk.dim(desc)}`);
          };

          cmd('/init',                   'Initialize git & link shadow repo');
          cmd('/sync',                   'Push local changes to GitHub');
          cmd('/edit [prompt]',          'Ask Jules AI to edit your code');
          cmd('/restore',                'Restore files from .bak backups');
          cmd('/session [ls|rm|track]',  'List, delete or track sessions');
          cmd('/usage',                  "Today's stats & all-time summary");
          cmd('/plan',                   'Switch to manual plan mode');
          cmd('/fast',                   'Switch to auto plan mode (default)');
          cmd('/docs',                   'Full documentation');
          cmd('/shot',                   'Show keyboard shortcuts manual');
          cmd('/clear',                  'Clear terminal');
          cmd('/help',                   'Show this menu');
          cmd('/exit',                   'Quit');
          console.log('');
          console.log(chalk.dim('  Or just type your instruction and press Enter'));
          console.log('');
          console.log(chalk.bold.white('  Project Information:'));
          console.log(`    ${chalk.bold.cyan('Open Source'.padEnd(28))} ${chalk.dim('Jules CLI is an Open Source project')}`);
          console.log(`    ${chalk.bold.cyan('GitHub'.padEnd(28))} ${chalk.dim('https://github.com/v54087912-collab/Jules-CLI.git')}`);
          console.log('');
          console.log(chalk.bold.white('  Support & Links:'));
          console.log(`    ${chalk.bold.cyan('Developer'.padEnd(28))} ${chalk.dim('https://t.me/R3V_X')}`);
          console.log(`    ${chalk.bold.cyan('Community'.padEnd(28))} ${chalk.dim('https://t.me/allinformation0173')}`);
          console.log(`    ${chalk.bold.cyan('Instagram'.padEnd(28))} ${chalk.dim('https://www.instagram.com/opeditzxx/')}`);
          console.log('');
          break;
        case '/clear':
          console.clear();
          break;
        case '/exit':
        case '/quit':
          console.log(chalk.yellow('Goodbye!'));
          process.exit(0);
          break;
        default:
          logger.error(`Unknown command: ${command}. Type /help for assistance.`);
          break;
      }
    } catch (execError: any) {
      logger.error(`Command failed: ${execError.message}`);
    }
    if (shellState.keypressHandler) {
      process.stdin.prependListener('keypress', shellState.keypressHandler);
    }
    process.stdout.write('\u001b[?2004h');
    showPrompt();
  };

  rl.on('line', shellState.shellLineHandler);
  
  const resizeHandler = () => {
    activeBottomLines = 0; // Force reset because terminal viewport has reflowed
    drawBottomArea(activeMatches);
  };
  process.stdout.on('resize', resizeHandler);

  rl.on('close', () => {
    disableShellBracketedPaste();
    process.off('exit', disableShellBracketedPaste);
    process.stdout.off('resize', resizeHandler);
    if (shellState.keypressHandler) {
      process.stdin.removeListener('keypress', shellState.keypressHandler);
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    clearBottomArea();
    console.log(chalk.yellow('\nGoodbye!'));
    process.exit(0);
  });
}

program
  .name('jules-local')
  .description('Bridge between local files and Google Jules API')
  .version('1.0.0');

program
  .command('init')
  .description('Initialize local git and link to a private shadow GitHub repo')
  .action(handleInit);

program
  .command('sync')
  .description('Push local changes to the shadow repository')
  .action(handleSync);

program
  .command('edit <instruction>')
  .description('Trigger Jules API with a prompt and apply changes locally')
  .option('--plan', 'Manual plan approval required')
  .option('--fast', 'Automatic plan approval (default)')
  .action(async (instruction, options) => {
    if (options.plan) {
      currentMode = 'plan';
    } else if (options.fast) {
      currentMode = 'fast';
    }
    await handleEdit(instruction);
  });

program
  .command('shell')
  .description('Enter interactive shell mode')
  .option('--plan', 'Start shell in manual plan approval mode')
  .option('--fast', 'Start shell in automatic plan approval mode (default)')
  .action(async (options) => {
    if (options.plan) {
      currentMode = 'plan';
    } else if (options.fast) {
      currentMode = 'fast';
    }
    try {
      await startShell();
    } catch (error: any) {
      logger.error(`Shell start failed: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('restore')
  .description('Restore local workspace from the latest backups (.bak)')
  .action(handleRestore);

program
  .command('docs')
  .description('Show full documentation manual')
  .action(handleDocs);

program
  .command('shot')
  .description('Show keyboard shortcuts manual')
  .action(handleShortcutsCommand);

program
  .command('usage')
  .description("Show today's session count and all-time summary")
  .action(handleUsageCommand);

program
  .command('session <action> [sessionId]')
  .description('Manage Jules sessions: list (ls), delete (rm), track <sessionId>')
  .action(async (action, sessionId) => {
    await handleSessionCommand([action, sessionId]);
  });

// If no arguments, start shell
if (require.main === module) {
  if (process.argv.length <= 2) {
    startShell().catch(error => {
      logger.error(`Shell failed: ${error.message}`);
      process.exit(1);
    });
  } else {
    program.parse(process.argv);
  }
}
