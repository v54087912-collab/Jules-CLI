#!/usr/bin/env node
import { Command } from 'commander';
import ora from 'ora';
import path from 'path';
import readline from 'readline';
import chalk from 'chalk';
import { parsePatch, formatPatch } from 'diff';
import { validateEnv, logger, printBanner, askUser, shellState, closeAskUser, downloadFile, loadSettings, saveSettings, config, cancellableSleep } from './utils';
import { initGit, syncLocalChanges, getRemoteUrl, setRemote, getCurrentBranch, isGitRepo, syncBranchAndPull } from './git';
import { createShadowRepo, createJulesSession, getSessionStatus, getSessionActivities, sendJulesMessage, approveJulesPlan, listJulesSessions, deleteJulesSession, listUserRepos, createNewRepo } from './api';
import { applyChanges, CodeChange } from './patcher';
import fs from 'fs';
import { bridgePathsInText, restoreExternalMappedFiles } from './bridge';
import { execSync } from 'child_process';
import dotenv from 'dotenv';

// Ignore SIGHUP to prevent Termux from killing the process on minimize
process.on('SIGHUP', () => {});

const SYNC_STATE_FILE = '.jules-sync-state.json';

let activePollingTimer: ReturnType<typeof setInterval> | null = null;
const activeIntervals = new Set<NodeJS.Timeout>();
let activeSpinner: any | null = null;
let activePromptReject: (() => void) | null = null;

function clearAllIntervals() {
  for (const timer of activeIntervals) {
    clearInterval(timer);
  }
  activeIntervals.clear();
  if (activeSpinner) {
    if (activeSpinner.isSpinning) activeSpinner.stop();
    activeSpinner = null;
  }
  activePollingTimer = null;
  shellState.activePollTimer = null;
}

function saveSyncState(commitHash: string, sessionId: string, appliedFiles: string[], skipped: boolean = false) {
  try {
    const syncState = {
      lastSyncedCommit: commitHash,
      lastSyncedAt: new Date().toISOString(),
      appliedFiles,
      sessionId,
      skipped
    };
    fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(syncState, null, 2));
    if (skipped) {
      console.log(chalk.yellow('⚠ Changes skipped. Run /sync to apply later.'));
    } else {
      console.log(chalk.green('✓ Files applied and sync state saved.'));
    }
  } catch (e: any) {
    logger.error(`Failed to save sync state: ${e.message}`);
  }
}

function shouldApplyChanges(sessionId: string): boolean {
  // Read local sync state
  let lastSyncedCommit: string | null = null;
  let lastSyncedAt: string | null = null;
  let lastSessionId: string | null = null;
  try {
    if (fs.existsSync(SYNC_STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(SYNC_STATE_FILE, 'utf8'));
      lastSyncedCommit = state.lastSyncedCommit;
      lastSyncedAt = state.lastSyncedAt;
      lastSessionId = state.sessionId;
    } else {
      // No sync state file = first time = apply changes
      return true;
    }
  } catch {
    return true;
  }

  // Get current remote commit
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    // Fetch latest to ensure we see Jules' commits
    execSync(`git fetch origin ${branch}`, { stdio: 'ignore' });
    const remoteCommit = execSync(`git rev-parse origin/${branch}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    
    // Only show diff if remote has NEW commits or it's a different session
    if (remoteCommit === lastSyncedCommit && sessionId === lastSessionId) {
      console.log(chalk.green('✓ Local files are already up to date.'));
      if (lastSyncedAt) {
        console.log(chalk.gray(`  Last synced: ${lastSyncedAt}`));
      }
      return false; // skip diff prompt
    }

    if (remoteCommit !== lastSyncedCommit) {
      console.log(chalk.yellow('\n📦 New changes detected from Jules session!'));
      if (lastSyncedCommit) {
        console.log(chalk.gray(`  Previous: ${lastSyncedCommit.slice(0, 7)}`));
      }
      console.log(chalk.gray(`  New:      ${remoteCommit.slice(0, 7)}`));
      console.log('');
    }
  } catch (e) {
    // If git command fails, assume we should show changes
    return true;
  }

  return true; // new changes exist or could not verify
}

function ensureEnvFields() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;

  const envContent = fs.readFileSync(envPath, 'utf8');
  let toAppend = '';

  if (!envContent.includes('GITHUB_USER=')) {
    toAppend += '\nGITHUB_USER=';
  }
  if (!envContent.includes('GITHUB_EMAIL=')) {
    toAppend += '\nGITHUB_EMAIL=';
  }

  if (toAppend) {
    fs.appendFileSync(envPath, toAppend);
    console.log(chalk.yellow('⚠ New .env fields added. Please fill them:'));
    console.log(chalk.cyan('  GITHUB_USER=your_github_username'));
    console.log(chalk.cyan('  GITHUB_EMAIL=your@email.com'));
    console.log(chalk.yellow('  Then restart Jules CLI.'));
    process.exit(0);
  }
}

function setupGitIdentity() {
  const name = process.env.GITHUB_USER;
  const email = process.env.GITHUB_EMAIL;
  
  if (!name || !email) {
    throw new Error('GITHUB_USER or GITHUB_EMAIL missing in .env');
  }

  try {
    execSync(`git config user.name "${name}"`);
    execSync(`git config user.email "${email}"`);
    console.log(chalk.gray(`  Git identity: ${name} <${email}>`));
  } catch (err) {
    console.log(chalk.yellow(`⚠ Could not set local git identity. Trying global...`));
    try {
      execSync(`git config --global user.name "${name}"`);
      execSync(`git config --global user.email "${email}"`);
      console.log(chalk.yellow(`⚠ Set global git identity: ${name} <${email}>`));
    } catch (e) {}
  }
}

function getAuthRemoteUrl(): string {
  const token = process.env.GITHUB_TOKEN;
  const user = process.env.GITHUB_USER;
  const repo = process.env.SHADOW_REPO || 'jules-shadow-default-project';
  
  if (!token || !user) {
    throw new Error('GITHUB_TOKEN or GITHUB_USER missing in .env');
  }

  return `https://${token}@github.com/${user}/${repo}.git`;
}

function setupAuthRemote() {
  const url = getAuthRemoteUrl();
  try {
    execSync(`git remote set-url origin "${url}"`);
  } catch {
    try {
      execSync(`git remote add origin "${url}"`);
    } catch (e) {}
  }
  
  const masked = url.replace(/https:\/\/([^@]+)@/, 'https://***@');
  console.log(chalk.gray('  Remote: ' + masked));
}

function detectNewProjects(): string[] {
  const workspacePath = getWorkspaceRoot();
  if (!fs.existsSync(workspacePath)) return [];

  const newProjects: string[] = [];

  function scanDir(dir: string, depth: number = 0) {
    if (depth > 2) return; // Limit depth to prevent infinite loops or deep scans

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name.startsWith('jules-shadow-') || entry.name === 'node_modules') continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(workspacePath, fullPath);
      
      const markerPath = path.join(fullPath, '.jules-repo-created');

      // New project = no marker file OR no git remote
      let hasRemote = false;
      try {
        if (fs.existsSync(path.join(fullPath, '.git'))) {
          const remote = execSync('git remote -v', { cwd: fullPath, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
          if (remote.includes('origin')) {
            hasRemote = true;
          }
        }
      } catch (e) {}

      // Specifically handle default-project as a container, not a project itself
      if (entry.name === 'default-project') {
        scanDir(fullPath, depth + 1);
        continue;
      }

      if (!fs.existsSync(markerPath) && !hasRemote) {
        // Only add if it's a project (has files) and not the workspace root itself
        const files = fs.readdirSync(fullPath).filter(f => !f.startsWith('.'));
        if (files.length > 0) {
          newProjects.push(relativePath);
        }
        
        // If it has subdirectories but no marker/remote, maybe scan deeper too?
        // But usually a project is a flat folder. For now, let's just add it.
      } else if (!hasRemote) {
        // Check if we should scan deeper for other potential project containers
        // but only if it's not already a project
        const subFiles = fs.readdirSync(fullPath);
        if (!subFiles.includes('.git') && !subFiles.includes('.jules-repo-created')) {
           scanDir(fullPath, depth + 1);
        }
      }
    }
  }

  scanDir(workspacePath);
  return [...new Set(newProjects)]; // Deduplicate
}

async function handleNewProjects(): Promise<string | null> {
  const newProjects = detectNewProjects();
  
  if (newProjects.length === 0) return null;
  
  let createdProjectPath: string | null = null;
  
  for (const projectName of newProjects) {
    console.log(chalk.yellow('\n📁 New project detected in Jules-Workspace:'));
    console.log(chalk.white(`  Folder: ${projectName}`));
    console.log(chalk.cyan('\nCreate a Private GitHub repo for this project?'));
    console.log('  1. Yes — Create repo now');
    console.log('  2. No  — Skip for now');
    
    const choice = await askUser('Option [1-2]: ');
    
    if (shellState.escCancelled) {
      shellState.escCancelled = false;
      console.log(chalk.gray('  Cancelled.'));
      return null;
    }
    
    if (choice.trim() === '1') {
      createdProjectPath = await collectRepoDetailsAndCreate(projectName);
    } else if (choice.trim() === '2') {
      // Mark as skipped so we don't ask again
      const workspacePath = getWorkspaceRoot();
      const markerPath = path.join(workspacePath, projectName, '.jules-repo-created');
      try {
        fs.writeFileSync(
          markerPath,
          JSON.stringify({
            skipped: true,
            skippedAt: new Date().toISOString()
          }, null, 2)
        );
        console.log(chalk.gray('  Skipped.'));
      } catch (e) {}
    }
  }
  return createdProjectPath;
}

async function collectRepoDetailsAndCreate(folderName: string): Promise<string | null> {
  console.log(chalk.cyan('\n🔧 GitHub Private Repo Setup'));
  console.log('─'.repeat(40));
  
  // Repo name (default = folder name)
  const defaultName = folderName
    .toLowerCase()
    .replace(/\s+/g, '-');
  
  const repoNameInput = await askUser(`Repo name [${defaultName}]: `);
  if (shellState.escCancelled) { shellState.escCancelled = false; return null; }
  const repoName = repoNameInput.trim() || defaultName;
  
  // Repo description
  const description = await askUser('Description (optional): ');
  if (shellState.escCancelled) { shellState.escCancelled = false; return null; }
  
  // Confirm
  console.log('');
  console.log(chalk.cyan('📋 Confirm details:'));
  console.log(chalk.white(`  Name        : ${repoName}`));
  console.log(chalk.white(`  Description : ${description || '(none)'}`));
  console.log(chalk.white(`  Visibility  : Private 🔒`));
  console.log(chalk.white(`  Owner       : ${process.env.GITHUB_USER}`));
  console.log('');
  
  const confirm = await askUser('Create this repo? (y/n): ');
  if (shellState.escCancelled) { shellState.escCancelled = false; return null; }
  
  if (confirm.trim().toLowerCase() !== 'y') {
    console.log(chalk.gray('  Cancelled.'));
    return null;
  }
  
  return await createPrivateGitHubRepo(repoName, description, folderName);
}

async function createPrivateGitHubRepo(repoName: string, description: string, folderName: string): Promise<string | null> {
  const token = process.env.GITHUB_TOKEN;
  const user  = process.env.GITHUB_USER;
  
  if (!token || !user) {
    console.log(chalk.red('❌ GITHUB_TOKEN or GITHUB_USER missing in .env'));
    return null;
  }
  
  console.log(chalk.cyan('\n⏳ Creating private GitHub repo...'));
  
  try {
    const response = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'jules-cli-bot'
      },
      body: JSON.stringify({
        name: repoName,
        description: description || '',
        private: true,
        auto_init: false
      })
    });
    
    const data = await response.json() as any;
    
    if (response.ok) {
      const repoUrl = data.html_url;
      const authenticatedCloneUrl = data.clone_url.replace('https://', `https://${token}@`);
      
      console.log(chalk.green('\n✅ Private repo created successfully!'));
      console.log('─'.repeat(40));
      console.log(chalk.cyan('  Repo URL : ') + chalk.yellow(repoUrl));

      const workspacePath = getWorkspaceRoot();
      const projectPath = path.join(workspacePath, folderName);
      const originalCwd = process.cwd();

      // Initialize git and push
      try {
        process.chdir(projectPath);
        execSync('git init', { stdio: 'ignore' });
        
        // Setup git identity
        try {
          setupGitIdentity();
        } catch (e) {}

        try {
          execSync(`git remote add origin "${authenticatedCloneUrl}"`, { stdio: 'ignore' });
        } catch (e) {
          execSync(`git remote set-url origin "${authenticatedCloneUrl}"`, { stdio: 'ignore' });
        }
        
        // Initial commit and push if there are files
        execSync('git add .', { stdio: 'ignore' });
        
        // Add marker to .gitignore
        const gitignorePath = path.join(projectPath, '.gitignore');
        let gitignore = '';
        if (fs.existsSync(gitignorePath)) {
          gitignore = fs.readFileSync(gitignorePath, 'utf8');
        }
        if (!gitignore.includes('.jules-repo-created')) {
          fs.appendFileSync(gitignorePath, '\n.jules-repo-created\n');
        }

        try {
          execSync('git commit -m "Initial commit from Jules CLI"', { stdio: 'ignore' });
          execSync('git branch -M main', { stdio: 'ignore' });
          execSync('git push -u origin main', { stdio: 'ignore' });
          console.log(chalk.green('  ✓ Local files pushed to GitHub.'));
        } catch (e) {
          console.log(chalk.yellow('  ⚠ No files to commit yet. Repo created empty.'));
        }

        // Create marker file
        fs.writeFileSync(
          path.join(projectPath, '.jules-repo-created'),
          JSON.stringify({
            repoName,
            repoUrl,
            authenticatedUrl: authenticatedCloneUrl.replace(token, '***'),
            createdAt: new Date().toISOString(),
            owner: user
          }, null, 2)
        );

        console.log('\n' + chalk.bold.green('✅ Private repo created successfully!'));
        console.log(chalk.dim('─'.repeat(40)));
        console.log(`  Repo URL : ${chalk.yellow(repoUrl)}`);
        console.log(`  Clone    : ${chalk.yellow(repoUrl + '.git')}`);
        console.log(chalk.dim('─'.repeat(40)));

        return projectPath;

      } catch (gitErr: any) {
        console.log(chalk.red(`  ❌ Git setup failed: ${gitErr.message}`));
        return null;
      } finally {
        process.chdir(originalCwd);
      }
    } else {
      console.log(chalk.red(`\n❌ GitHub API Error: ${data.message || response.statusText}`));
      return null;
    }
  } catch (error: any) {
    console.log(chalk.red(`\n❌ Error creating repository: ${error.message}`));
    return null;
  }
}

function handleEscapePress() {
  if (shellState.escCancelled) return;
  shellState.escCancelled = true;
  shellState.sessionAborted = true;

  // Abort any pending API calls IMMEDIATELY
  shellState.abortController.abort();

  let cancelledAny = false;

  // 1. Cancel active spinners/intervals
  if (activeIntervals.size > 0 || (activeSpinner && activeSpinner.isSpinning)) {
    clearAllIntervals();
    process.stdout.write(chalk.yellow('\n\n⛔ Task cancelled by user (ESC).\n'));
    cancelledAny = true;
  }

  // 2. Reject any active pending promise-based prompts
  if (activePromptReject) {
    activePromptReject();
    activePromptReject = null;
    cancelledAny = true;
  }

  // 3. Handle Readline buffer and state
  if (shellState.activeRl) {
    // Clear the current line buffer
    (shellState.activeRl as any).line = '';
    (shellState.activeRl as any).cursor = 0;
    if (!(shellState.activeRl as any).closed) {
      (shellState.activeRl as any)._refreshLine();
    }

    if (shellState.shellLineHandler) {
      // In Shell mode: force a newline to break any active .question() 
      // and let the shell loop take back control.
      shellState.activeRl.write('\n');
      cancelledAny = true;
    } else {
      // One-off command mode: just close and exit gracefully
      if (!(shellState.activeRl as any).closed) {
        shellState.activeRl.close();
      }
      shellState.activeRl = null;
      process.stdout.write(chalk.yellow('\n⚠ Input cancelled.\n'));
      cancelledAny = true;
    }
  }

  if (!cancelledAny) {
    // If nothing was active, just ensure we show a fresh prompt
    process.stdout.write('\n');
    if (shellState.shellLineHandler && shellState.showPrompt) {
      shellState.showPrompt();
    }
  }
}

// Enable raw keypress detection
if (!shellState.keypressEventsEmitted) {
  readline.emitKeypressEvents(process.stdin);
  shellState.keypressEventsEmitted = true;
}
if (process.stdin.isTTY) {
  try {
    process.stdin.setRawMode(true);
  } catch (e) {}
}

process.stdin.on('keypress', (char, key) => {
  const isEscape = (key && key.name === 'escape' && (key.sequence === '\u001b' || key.sequence === '\x1b')) ||
                   (!key && (char === '\u001b' || char === '\x1b'));
  if (isEscape) {
    handleEscapePress();
  }
  // Standard Ctrl+C handling
  if (key && key.ctrl && key.name === 'c') {
    process.exit(0);
  }
});

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

// Ensure fresh start state on every restart
if (shellState.activePollTimer) {
  clearInterval(shellState.activePollTimer);
}
shellState.activePollTimer = null;
shellState.activeRl = null;
shellState.escCancelled = false;
shellState.trackedSessionId = null;
shellState.trackedSessionUrl = null;

let currentMode: 'fast' | 'plan' = 'fast';

const isLongPaste = (text: string): boolean => {
  const lineCount = text.split(/\r\n|\r|\n/).length;
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  // Only trigger placeholder for truly large blocks (e.g., > 10 lines or > 200 words)
  return lineCount > 10 || wordCount > 200 || text.length > 2000;
};

function getWorkspaceStatus(): { isValid: boolean; error?: string; projectName?: string; isOutside?: boolean; wsRoot?: string } {
  const cwd = path.resolve(process.cwd());
  const wsRoot = getWorkspaceRoot();

  if (cwd === wsRoot) {
    const settings = loadSettings();
    let projectName = settings.lastProject;

    if (!projectName || !fs.existsSync(path.join(wsRoot, projectName))) {
      projectName = 'default-project';
    }

    const projectPath = path.join(wsRoot, projectName);
    if (!fs.existsSync(projectPath)) {
      fs.mkdirSync(projectPath, { recursive: true });
    }

    process.chdir(projectPath);
    return {
      isValid: true,
      projectName,
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

  // Save as last project
  saveSettings({ lastProject: projectName });

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
  if (shellState.escCancelled) return;
  await enforceWorkspace();
  if (shellState.escCancelled) return;
  validateEnv();
  try {
    await initGit();
    if (shellState.escCancelled) return;
    const repoName = `jules-shadow-${path.basename(process.cwd())}`;
    const authenticatedUrl = await createShadowRepo(repoName);
    if (shellState.escCancelled) return;
    await setRemote(authenticatedUrl);
    logger.success(`Linked to shadow repo (with auth): ${repoName}`);
    printShadowRepoWarning(authenticatedUrl);
  } catch (error: any) {
    if (shellState.escCancelled) {
      process.stdout.write('\n' + chalk.yellow('⚠ Operation cancelled.\n'));
      return;
    }
    logger.error(`Init failed: ${error.message}`);
  }
}

async function handleNewRepo() {
  if (shellState.escCancelled) return;
  validateEnv();
  
  const githubUser = process.env.GITHUB_USER;
  const githubToken = process.env.GITHUB_TOKEN;

  console.log(chalk.bold.white('\n  🆕 Create a New Private GitHub Repo'));
  console.log(chalk.dim('  All values from .env — nothing hardcoded\n'));

  let repoName = '';
  while (true) {
    const rawName = await askUser(chalk.hex('#2ec4b6')('  Repo Name: '));
    if (shellState.escCancelled) {
      process.stdout.write('\n' + chalk.yellow('  ⚠ Repo creation cancelled.\n'));
      return;
    }
    
    repoName = rawName.trim().replace(/\s+/g, '-');
    if (rawName.trim() !== repoName && repoName !== '') {
      logger.warn(`Name changed to: ${repoName}`);
    }

    if (!repoName) {
      logger.error('Repo name cannot be empty.');
      continue;
    }

    if (!/^[a-zA-Z0-9._-]+$/.test(repoName)) {
      logger.error('Invalid name. letters, numbers, "-", "_" only.');
      continue;
    }

    if (repoName.length > 100) {
      logger.error('Name too long (max 100 chars).');
      continue;
    }
    break;
  }

  const repoDesc = await askUser(chalk.hex('#2ec4b6')('  Repo Description (optional): '));
  if (shellState.escCancelled) {
    process.stdout.write('\n' + chalk.yellow('  ⚠ Repo creation cancelled.\n'));
    return;
  }

  console.log(chalk.dim('  ' + '─'.repeat(40)));
  console.log(chalk.bold.white('  📋 Confirm New Repo Details:'));
  console.log(`    ${chalk.cyan('Name'.padEnd(12))} : ${chalk.white(repoName)}`);
  console.log(`    ${chalk.cyan('Description'.padEnd(12))} : ${chalk.white(repoDesc || '(none)')}`);
  console.log(`    ${chalk.cyan('Visibility'.padEnd(12))} : ${chalk.white('Private 🔒')}`);
  console.log(`    ${chalk.cyan('Owner'.padEnd(12))} : ${chalk.white(githubUser || '(none)')}`);
  console.log(chalk.dim('  ' + '─'.repeat(40)));

  const confirm = await askUser(chalk.hex('#ff9f1c')('  Confirm? (y/n): '));
  if (shellState.escCancelled || confirm.toLowerCase() !== 'y') {
    process.stdout.write('\n' + chalk.yellow('  ⚠ Repo creation cancelled.\n'));
    return;
  }

  const spinner = ora({ text: chalk.dim('⏳ Creating repo...'), color: 'magenta' }).start();
  try {
    const repo = await createNewRepo(repoName, repoDesc);
    spinner.succeed('Private repo created successfully!');
    
    console.log(chalk.dim('  ' + '─'.repeat(40)));
    console.log(`    ${chalk.cyan('Repo URL'.padEnd(10))} : ${chalk.yellow(repo.html_url)}`);
    console.log(`    ${chalk.cyan('Clone'.padEnd(10))} : ${chalk.yellow(repo.clone_url)}`);
    console.log(`    ${chalk.cyan('SSH'.padEnd(10))} : ${chalk.yellow(repo.ssh_url)}`);
    console.log(chalk.dim('  ' + '─'.repeat(40)));
    console.log(chalk.dim('  💡 Tip: Use /init to link this repo to Jules workspace.\n'));

    // Post-creation menu
    console.log(chalk.bold.white('  What would you like to do next?'));
    console.log(`    ${chalk.cyan('1.')} Clone repo to Jules-Workspace`);
    console.log(`    ${chalk.cyan('2.')} Open repo URL`);
    console.log(`    ${chalk.cyan('3.')} Return to prompt`);
    
    const nextAction = await askUser(chalk.hex('#2ec4b6')('\n  Choice: '));
    if (nextAction === '1') {
      const wsRoot = getWorkspaceRoot();
      const destPath = path.join(wsRoot, repoName);
      if (fs.existsSync(destPath)) {
        logger.error(`Destination path already exists: ${destPath}`);
      } else {
        const cloneSpinner = ora({ text: chalk.dim(`Cloning to ${destPath}...`), color: 'magenta' }).start();
        try {
          const authCloneUrl = repo.clone_url.replace('https://', `https://${githubToken}@`);
          execSync(`git clone ${authCloneUrl} "${destPath}"`, { stdio: 'ignore' });
          fs.writeFileSync(path.join(destPath, '.jules-repo-created'), '');
          cloneSpinner.succeed(`Cloned to Jules-Workspace/${repoName}`);
        } catch (cloneErr: any) {
          cloneSpinner.fail(`Failed to clone: ${cloneErr.message}`);
        }
      }
    } else if (nextAction === '2') {
      console.log(`  🌐 Open: ${chalk.cyan(repo.html_url)}`);
    }
  } catch (err: any) {
    spinner.fail(err.message);
  }
}

async function handleSync() {
  if (shellState.escCancelled) return;
  await enforceWorkspace();
  if (shellState.escCancelled) return;
  
  try {
    // 1. Validate env first
    validateEnv();
    
    // 2. Setup identity from .env
    setupGitIdentity();
    
    // 3. Setup authenticated remote from .env
    setupAuthRemote();
    
    // 4. Get current branch
    let branch = 'main';
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch (e) {
      // Empty repo, check if master exists or default to main
      try {
        branch = execSync('git symbolic-ref --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      } catch (e2) {
        branch = 'main';
      }
    }
    
    // 5. Set upstream if missing
    try {
      execSync('git rev-parse --abbrev-ref --symbolic-full-name @{u}', { stdio: 'ignore' });
    } catch {
      try {
        execSync(`git branch --set-upstream-to=origin/${branch} ${branch}`, { stdio: 'ignore' });
        console.log(chalk.yellow(`⚠ Upstream set: origin/${branch}`));
      } catch (e) {
        // Skip if origin branch doesn't exist yet
      }
    }
    
    // 6. Pull
    try {
      execSync(`git pull origin ${branch}`, { stdio: 'ignore' });
    } catch (e) {
      // Ignore pull errors (e.g. if remote branch doesn't exist yet)
    }
    
    // 7. Stage
    execSync('git add -A', { stdio: 'ignore' });
    
    // 8. Commit if changes exist
    try {
      execSync('git diff --cached --quiet --exit-code', { stdio: 'ignore' });
      console.log(chalk.green('✓ Already up to date. Nothing to commit.'));
    } catch {
      const timestamp = new Date().toISOString();
      execSync(`git commit -m "Jules CLI sync: ${timestamp}"`, { stdio: 'ignore' });
      
      try {
        // Try push with -u if upstream might be missing
        execSync(`git push -u origin ${branch}`, { stdio: 'ignore' });
      } catch (e) {
        execSync(`git push origin ${branch}`, { stdio: 'ignore' });
      }
      console.log(chalk.green('✓ Sync complete!'));
    }

    // Check for new projects to create repos for
    await handleNewProjects();

  } catch (err: any) {
    console.log(chalk.red('❌ Sync failed: ' + err.message));
    
    // Show helpful hint if identity error
    if (err.message.includes('identity') || err.message.includes('email')) {
      console.log(chalk.yellow('  Fix: Set GITHUB_USER and GITHUB_EMAIL in .env'));
      console.log(chalk.gray(`  Path: ${path.join(process.cwd(), '.env')}`));
    }
  }
}

async function previewLargePaste(text: string): Promise<boolean> {
  const lines = text.split('\n');
  const pageSize = 15;
  let currentIndex = 0;

  console.log(chalk.bold.yellow('\n📋 LARGE PASTE DETECTED - Please Review:'));
  const divider = chalk.dim('─'.repeat(process.stdout.columns || 50));

  while (currentIndex < lines.length) {
    console.log(divider);
    const end = Math.min(currentIndex + pageSize, lines.length);
    for (let i = currentIndex; i < end; i++) {
      console.log(chalk.gray(`  ${lines[i]}`));
    }
    console.log(divider);
    
    if (end < lines.length) {
      console.log(chalk.dim(`  Showing lines ${currentIndex + 1}-${end} of ${lines.length}.`));
      const ans = await askUser(chalk.cyan(`Proceed? (y=yes, n=no, [Enter]=next page, a=show all): `));
      if (shellState.escCancelled) {
        shellState.escCancelled = false;
        return false;
      }
      const choice = ans.trim().toLowerCase();
      if (choice === 'y') {
        return true;
      } else if (choice === 'n') {
        return false;
      } else if (choice === 'a') {
        console.log(divider);
        for (let i = end; i < lines.length; i++) {
          console.log(chalk.gray(`  ${lines[i]}`));
        }
        console.log(divider);
        break;
      } else {
        currentIndex += pageSize;
      }
    } else {
      console.log(chalk.dim(`  Showing all ${lines.length} lines.`));
      break;
    }
  }

  const confirm = await askUser(chalk.cyan('Proceed with this input? (y/n): '));
  if (shellState.escCancelled) {
    shellState.escCancelled = false;
    return false;
  }
  return confirm.trim().toLowerCase() === 'y';
}

async function promptJulesReply(cleanHeader: string, sessionId?: string): Promise<string> {
  shellState.sessionAborted = false;
  shellState.escCancelled = false;
  const localSignal = shellState.abortController.signal;
  const oldLineHandler = shellState.shellLineHandler;
  const oldKeypressHandler = shellState.keypressHandler;
  
  let tempRl: readline.Interface | null = null;
  let rl = shellState.activeRl;
  if (!rl) {
    tempRl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.bold.white('> '),
      completer: (line: string) => [[], line]
    });
    rl = tempRl;
    if (!shellState.keypressEventsEmitted) {
      readline.emitKeypressEvents(process.stdin);
      shellState.keypressEventsEmitted = true;
    }
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(true); } catch (e) {}
    }
  } else {
    if (oldLineHandler) {
      rl.off('line', oldLineHandler);
    }
    if (oldKeypressHandler) {
      process.stdin.removeListener('keypress', oldKeypressHandler);
    }
    if (!(rl as any).closed) rl.resume();
  }

  let liveStatus = '';
  
  if (sessionId) {
    const timer = setInterval(async () => {
      if (shellState.escCancelled || localSignal.aborted || shellState.sessionAborted) {
        clearInterval(timer);
        activeIntervals.delete(timer);
        if (activePollingTimer === timer) activePollingTimer = null;
        return;
      }
      try {
        const status = await getSessionStatus(sessionId, localSignal);
        const newStatus = status.description || status.state || status.status || '';
        if (newStatus && newStatus !== liveStatus) {
          liveStatus = newStatus;
          drawReplyBottomArea();
        }
      } catch (e) {}
    }, 8000);
    activeIntervals.add(timer);
    activePollingTimer = timer;
    shellState.activePollTimer = activePollingTimer;
  }

  console.log(chalk.bold.white('\n' + cleanHeader));
  const cols = process.stdout.columns || 80;
  console.log(chalk.dim('─'.repeat(Math.max(0, cols - 2))));

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

    const cols = process.stdout.columns || 80;
    const separator = chalk.dim('─'.repeat(Math.max(0, cols - 2)));
    const left = '/shot for shortcuts';
    const right = '/session';
    
    const lines = [separator];

    if (liveStatus) {
      lines.push(chalk.dim('  ⎿  ') + chalk.bold.cyan('Jules is working: ') + chalk.dim(liveStatus));
    }

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

    if (cols > 40) {
      const spaceCount = Math.max(2, cols - left.length - right.length - 10);
      const footer = chalk.dim('  ' + left + ' '.repeat(spaceCount) + right);
      lines.push(footer);
    } else if (cols > 20) {
      const footer = chalk.dim('  ' + right);
      lines.push(footer);
    }

    const currentPrompt = (rl as any)._prompt || '';
    const cleanPrompt = currentPrompt.replace(/\u001b\[[0-9;]*m/g, '');
    const actualPromptLen = cleanPrompt.length;
    const col = actualPromptLen + rl!.cursor;
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
  if (!(rl as any).closed) rl.prompt();
  drawReplyBottomArea();

  const keypressHandler = (char: any, key: any) => {
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

    const isEscape = (key && key.name === 'escape' && (key.sequence === '\u001b' || key.sequence === '\x1b')) ||
                     (!key && (char === '\u001b' || char === '\x1b'));
    if (isEscape) {
      handleEscapePress();
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
        newMatches = ['/init', '/sync', '/edit', '/restore', '/session', '/usage', '/plan', '/fast', '/clear', '/help', '/docs', '/shot', '/exit'].filter(c => c.startsWith(line));
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
  process.stdin.removeListener('keypress', keypressHandler);
  process.stdin.prependListener('keypress', keypressHandler);
  rl.on('SIGINT', sigintHandler);

  return new Promise<string>((resolve) => {
    const lineHandler = async (line: string) => {
      if (shellState.escCancelled || localSignal.aborted || shellState.sessionAborted) {
        if (activePollingTimer) clearInterval(activePollingTimer!);
        
        process.stdin.removeListener('keypress', keypressHandler);
        rl!.off('SIGINT', sigintHandler);
        rl!.off('line', lineHandler);
        
        disableReplyBracketedPaste();
        process.off('exit', disableReplyBracketedPaste);

        if (tempRl) {
          tempRl.close();
          if (process.stdin.isTTY) {
            try { process.stdin.setRawMode(false); } catch (e) {}
          }
        } else {
          if (oldLineHandler) {
            rl!.off('line', oldLineHandler);
            rl!.on('line', oldLineHandler);
          }
          if (oldKeypressHandler) {
            process.stdin.removeListener('keypress', oldKeypressHandler);
            process.stdin.prependListener('keypress', oldKeypressHandler);
          }
        }

        resolve('');
        return;
      }
      clearReplyBottomAreaOnEnter();
      
      let substitutedLine = line;
      let hadPlaceholders = false;
      for (let i = 0; i < replyPastedBlocks.length; i++) {
        const placeholderPattern = `[pasted text #${i + 1} [`;
        const idx = substitutedLine.indexOf(placeholderPattern);
        if (idx !== -1) {
          const endIdx = substitutedLine.indexOf(']]', idx + placeholderPattern.length);
          if (endIdx !== -1) {
            const fullPlaceholder = substitutedLine.substring(idx, endIdx + 2);
            substitutedLine = substitutedLine.replace(fullPlaceholder, replyPastedBlocks[i]);
            hadPlaceholders = true;
          }
        }
      }

      if (hadPlaceholders) {
        if (!(rl as any).closed) rl.pause();
        const proceed = await previewLargePaste(substitutedLine);
        if (!(rl as any).closed) rl.resume();

        if (!proceed) {
          replyPastedBlocks = [];
          replyPasteCount = 0;
          (rl as any).line = '';
          (rl as any).cursor = 0;
          (rl as any)._refreshLine();
          rl.prompt();
          return;
        }
      }

      replyPastedBlocks = [];
      replyPasteCount = 0;

      const endsWithBackslash = substitutedLine.endsWith('\\');
      if (altEnterPressed || endsWithBackslash) {
        const lineToPush = endsWithBackslash ? substitutedLine.slice(0, -1) : substitutedLine;
        accumulatedLines.push(lineToPush);
        altEnterPressed = false;
        rl!.setPrompt('  ');
        if (!(rl as any).closed) rl!.prompt();
        drawReplyBottomArea();
      } else {
        const cmd = line.trim().toLowerCase();
        const baseCmd = cmd.split(' ')[0];
        if (['/init', '/sync', '/edit', '/restore', '/session'].includes(baseCmd)) {
          logger.error(`Command ${baseCmd} is not available during an active session.`);
          if (!(rl as any).closed) rl!.prompt();
          drawReplyBottomArea();
          return;
        }

        if (cmd === '/clear') {
          console.clear();
          console.log(chalk.bold.white('\n' + cleanHeader));
          console.log(chalk.dim('─'.repeat(Math.max(0, cols - 2))));
          if (!(rl as any).closed) rl!.prompt();
          drawReplyBottomArea();
          return;
        }
        if (cmd === '/shot') {
          handleShortcutsCommand();
          if (!(rl as any).closed) rl!.prompt();
          drawReplyBottomArea();
          return;
        }
        if (cmd === '/docs') {
          handleDocs();
          if (!(rl as any).closed) rl!.prompt();
          drawReplyBottomArea();
          return;
        }
        if (cmd === '/usage') {
          handleUsageCommand();
          if (!(rl as any).closed) rl!.prompt();
          drawReplyBottomArea();
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
          if (!(rl as any).closed) rl!.prompt();
          drawReplyBottomArea();
          return;
        }
        if (cmd === '/plan') {
          currentMode = 'plan';
          logger.success('Switched to PLAN mode (Manual plan approval required).');
          if (!(rl as any).closed) rl!.prompt();
          drawReplyBottomArea();
          return;
        }
        if (cmd === '/fast') {
          currentMode = 'fast';
          logger.success('Switched to FAST mode (Automatic plan approval enabled).');
          if (!(rl as any).closed) rl!.prompt();
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
            try { process.stdin.setRawMode(false); } catch (e) {}
          }
        } else {
          if (oldLineHandler) {
            rl!.on('line', oldLineHandler);
          }
          if (oldKeypressHandler) {
            process.stdin.removeListener('keypress', oldKeypressHandler);
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
        
        if (activePollingTimer) {
          clearInterval(activePollingTimer!);
          shellState.activePollTimer = null;
        }
        resolve(substitutedLine);
      }
    };

    rl!.on('line', lineHandler);
    rl!.on('close', () => {
      if (activePollingTimer) {
        clearInterval(activePollingTimer!);
        shellState.activePollTimer = null;
      }
      resolve('');
    });
  });
}

export async function trackJulesSession(sessionId: string, repoUrl?: string, forceSync: boolean = false) {
  const localSignal = shellState.abortController.signal;
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

  const sessionUrl = `https://jules.google.com/sessions/${sessionId}`;
  
  console.log(chalk.dim('\n── Synced with Jules Web Session ──'));
  console.log(`🆔 ${chalk.cyan('Session ID'.padEnd(11))} : ${chalk.white(sessionId)}`);
  console.log(chalk.cyan('🌐 Session URL : ') + chalk.yellow(sessionUrl));
  console.log(chalk.dim('──────────────────────────────────────────\n'));

  if (!shellState.keypressEventsEmitted) {
    readline.emitKeypressEvents(process.stdin);
    shellState.keypressEventsEmitted = true;
  }
  const wasRaw = process.stdin.isRaw;
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(true); } catch (e) {}
  }
  process.stdin.resume(); // Ensure stream is flowing

  // Helper: detect if text is internal markdown evaluation garbage
  const isJunkDescription = (d: string) =>
    d.startsWith('###') ||
    d.includes('Final Rating') ||
    d.includes('Merge Assessment') ||
    (d.includes('\n') && d.includes('###'));

  const formatSpinnerText = (verb: string, state: string = 'WORKING') => {
    const s = state.toUpperCase();
    const now = new Date();
    const ts = `[${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}]`;
    
    if (['IDLE', 'WAITING', 'COMPLETED', 'STOPPED', 'INACTIVE', 'AWAITING_USER_FEEDBACK', 'PAUSED', 'HALTED', 'BLOCKED'].includes(s)) {
      const displayState = s.replace(/_/g, ' ');
      return chalk.bold.yellow(`⏸ Jules is ${displayState.toLowerCase()} ${chalk.dim(ts)}`);
    } else if (['ERROR', 'FAILED'].includes(s)) {
      return chalk.bold.red(`❌ Jules encountered an error ${chalk.dim(ts)}`);
    } else {
      const displayVerb = (verb && !['WORKING', 'ANALYZING', 'IN_PROGRESS', 'RUNNING'].includes(verb.toUpperCase())) ? verb : 'Analyzing';
      const displayStatus = (s === 'WORKING' || s === 'ANALYZING' || s === 'IN_PROGRESS' || s === 'RUNNING') ? 'Working' : s.replace(/_/g, ' ').toLowerCase();
      return chalk.bold.cyan(`⚡ Status: ${displayStatus.charAt(0).toUpperCase() + displayStatus.slice(1)}`) + chalk.dim(' • ') + chalk.white(`${displayVerb} ${chalk.dim(ts)}`);
    }
  };

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
  let currentState = 'WORKING';
  updateActivityTracker(currentVerb);

  const spinner = ora({
    text: formatSpinnerText(currentVerb, currentState),
    spinner: 'dots',
    color: 'yellow'
  }).start();
  activeSpinner = spinner;

  let lastStatusDescription = '';
  let isOffline = false;

  // Verb rotator interval — only rotates random verbs when no real Jules
  // step has set currentVerb. Once live status sync sets currentVerb to a
  // real step name, stop rotating and just keep refreshing that text.
  const timer = setInterval(() => {
    if (shellState.escCancelled || localSignal.aborted || shellState.sessionAborted) {
      clearInterval(timer);
      activeIntervals.delete(timer);
      if (activePollingTimer === timer) activePollingTimer = null;
      return;
    }
    if (spinner.isSpinning) {
      const isStillRandom = (spinnerVerbs as readonly string[]).includes(currentVerb);
      if (isStillRandom && !lastStatusDescription) {
        // No real status yet — keep rotating random verbs
        currentVerb = spinnerVerbs[Math.floor(Math.random() * spinnerVerbs.length)];
        updateActivityTracker(currentVerb);
      }
      // Otherwise keep currentVerb as-is (real Jules step name)
      spinner.text = formatSpinnerText(currentVerb, currentState);
    }
  }, 2000);
  activeIntervals.add(timer);
  activePollingTimer = timer;
  shellState.activePollTimer = activePollingTimer;

  let completed = false;
  let idlePollCount = 0;
  const seenActivities = new Set<string>();
  const repliedActivities = new Set<string>();
  const approvedPlans = new Set<string>();
  const downloadedMedia = new Set<string>();
  const printedAgentMessages = new Set<string>();
  const printedMutations = new Set<string>();
  let lastChecklistStateStr = '';

  const checkAndRenderPlanChecklist = (steps: any[], currentStepIndex: number, completedStepIndices: Set<number>) => {
    if (!steps || steps.length === 0) return;

    const stateParts = steps.map((s, idx) => {
      const isCompleted = completedStepIndices.has(idx);
      const isActive = idx === currentStepIndex;
      return `${idx}:${isCompleted ? 'C' : isActive ? 'A' : 'P'}`;
    });
    const stateStr = stateParts.join(',');

    if (stateStr === lastChecklistStateStr) return;
    lastChecklistStateStr = stateStr;

    const wasSpinning = spinner.isSpinning;
    if (wasSpinning) spinner.stop();

    console.log(chalk.bold.white('\n📋 Task Plan Progress:'));
    steps.forEach((s: any, idx: number) => {
      const stepTitle = s.title || s.description || `Step ${idx + 1}`;
      const isCompleted = completedStepIndices.has(idx);
      const isActive = idx === currentStepIndex;

      if (isCompleted) {
        console.log(`  ${chalk.green('[✓]')} ${chalk.dim(stepTitle)}`);
      } else if (isActive) {
        console.log(`  ${chalk.cyan('[▸]')} ${chalk.bold.cyan(stepTitle)}`);
      } else {
        console.log(`  ${chalk.dim('[ ]')} ${chalk.white(stepTitle)}`);
      }
    });
    console.log('');

    if (wasSpinning) spinner.start(formatSpinnerText(currentVerb, currentState));
  };

  // Initialize tracking state with existing activities to avoid blocking on old history
  try {
    const initialActivities = await getSessionActivities(sessionId, localSignal);
    
    // Find if plan is already approved in history
    const isPlanAlreadyApproved = initialActivities.some((a: any) => 
      a.progressUpdated || 
      a.description?.toLowerCase().includes('step') || 
      a.planApproved
    );

    // Find the last agent message activity
    const agentMsgs = initialActivities.filter((a: any) => a.agentMessaged?.agentMessage);
    const lastAgentMsg = agentMsgs[agentMsgs.length - 1];

    for (const act of initialActivities) {
      const isPlanGen = !!act.planGenerated;
      const isLastMsg = lastAgentMsg && (act.id === lastAgentMsg.id || act.name === lastAgentMsg.name);

      // Skip caching/marking as seen if it's the unapproved plan or the last active message
      if (isPlanGen && !isPlanAlreadyApproved) {
        continue;
      }
      if (isLastMsg) {
        continue;
      }

      if (act.id) printedAgentMessages.add(act.id);
      if (act.name) printedAgentMessages.add(act.name);
      
      if (act.planGenerated && isPlanAlreadyApproved) {
        if (act.name) approvedPlans.add(act.name);
        if (act.id) approvedPlans.add(act.id);
      }

      if (act.agentMessaged) {
        if (act.id) repliedActivities.add(act.id);
        if (act.name) repliedActivities.add(act.name);
      }

      const actKey = act.id || act.name;
      if (actKey) seenActivities.add(actKey);
    }
  } catch (e) {
    // Initial fetch failed, main loop will retry
  }

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
      if (shellState.escCancelled || localSignal.aborted || shellState.sessionAborted) {
        if (spinner.isSpinning) spinner.stop();
        clearAllIntervals();
        logger.info('Aborting Jules task...');
        try {
          await deleteJulesSession(sessionId);
        } catch (e) {}
        logger.info('Task cancelled.');
        completed = true;
        break;
      }

      try {
        const status = await getSessionStatus(sessionId, localSignal);
        currentState = status.state || status.status || status.executionStatus?.state || 'WORKING';

        let activities: any[] = [];
        try {
          activities = await getSessionActivities(sessionId, localSignal);
        } catch (e) {}

        const planAct = activities.find(a => a.planGenerated?.plan);
        if (planAct) {
          const planSteps = planAct.planGenerated.plan.steps || [];
          let currentStepIndex = -1;
          const completedStepIndices = new Set<number>();

          planSteps.forEach((s: any, idx: number) => {
            const sState = (s.state || s.status || '').toUpperCase();
            if (sState === 'COMPLETED' || sState === 'SUCCESS' || sState === 'SUCCEEDED') {
              completedStepIndices.add(idx);
            } else if (sState === 'RUNNING' || sState === 'IN_PROGRESS' || sState === 'ACTIVE') {
              currentStepIndex = idx;
            }
          });

          if (currentStepIndex === -1) {
            for (let i = activities.length - 1; i >= 0; i--) {
              const act = activities[i];
              const actTitle = (act.progressUpdated?.title || '').toLowerCase();
              const actDesc = (act.progressUpdated?.description || act.description || '').toLowerCase();
              let foundMatch = false;
              for (let idx = 0; idx < planSteps.length; idx++) {
                const s = planSteps[idx];
                const stepTitle = (s.title || '').toLowerCase();
                const stepDesc = (s.description || '').toLowerCase();
                if (
                  (stepTitle && (actTitle.includes(stepTitle) || actDesc.includes(stepTitle))) ||
                  (stepDesc && (actTitle.includes(stepDesc) || actDesc.includes(stepDesc)))
                ) {
                  currentStepIndex = idx;
                  foundMatch = true;
                  break;
                }
              }
              if (foundMatch) break;
            }
          }

          if (currentStepIndex >= 0) {
            for (let i = 0; i < currentStepIndex; i++) {
              completedStepIndices.add(i);
            }
          }

          checkAndRenderPlanChecklist(planSteps, currentStepIndex, completedStepIndices);
        }

        const hasUnapprovedPlan = activities.some((a: any) => 
          a.planGenerated?.plan && 
          !approvedPlans.has(a.name) && 
          !approvedPlans.has(a.id)
        );
        
        const isWaitingState = ['IDLE', 'WAITING', 'COMPLETED', 'STOPPED', 'INACTIVE', 'AWAITING_USER_FEEDBACK', 'AWAITING_USER_INPUT', 'AWAITING_INPUT', 'PAUSED', 'HALTED', 'BLOCKED'].includes(currentState.toUpperCase()) ||
                               status.requires_user_input === true ||
                               status.requiresUserInput === true ||
                               (activities.length > 0 && activities[activities.length - 1].agentMessaged?.agentMessage);

        if (isWaitingState && !hasUnapprovedPlan) {
          idlePollCount++;
        } else {
          idlePollCount = 0;
        }

        if (idlePollCount >= 2) {
          if (spinner.isSpinning) spinner.stop();
          clearAllIntervals();
          
          if (process.stdin.isTTY) {
            try { process.stdin.setRawMode(wasRaw); } catch (e) {}
          }

          const userReply = await promptJulesReply('Send a message to continue (or type /exit):', sessionId);

          if (process.stdin.isTTY) {
            try { process.stdin.setRawMode(true); } catch (e) {}
          }
          process.stdin.resume();
          

          if (shellState.escCancelled || userReply.trim().toLowerCase() === '/exit' || localSignal.aborted) {
            completed = true;
            break;
          }

          const msgSpinner = ora({ text: chalk.dim('Sending message to continue…'), spinner: 'dots', color: 'white' }).start();
          const bridgedReply = bridgePathsInText(userReply);
          await syncLocalChanges();
          
          await sendJulesMessage(sessionId, bridgedReply, localSignal);
          msgSpinner.stop();
          logger.success('Message sent successfully. Resuming session...');
          
          idlePollCount = 0;
          spinner.start(formatSpinnerText(currentVerb, currentState));
          continue; // Poll again immediately
        }
        
        // Update spinner text immediately
        spinner.text = formatSpinnerText(currentVerb, currentState);

        // --- Bug 3: Detect Interrupt/Question ---
        const isInterrupt = !hasUnapprovedPlan && (
          status.requires_user_input === true || 
          status.requiresUserInput === true ||
          ['question', 'interrupt', 'user_input_required', 'awaiting_user_feedback', 'awaiting_user_input', 'awaiting_input', 'paused', 'halted', 'blocked'].includes(status.type?.toLowerCase() || '') ||
          ['awaiting_user_feedback', 'awaiting_user_input', 'awaiting_input', 'paused', 'halted', 'blocked', 'inactive'].includes(currentState.toLowerCase()) ||
          (activities.length > 0 && activities[activities.length - 1].agentMessaged?.agentMessage)
        );

        if (isInterrupt) {
          if (spinner.isSpinning) spinner.stop();

          let interruptMsg = status.question_text || status.prompt_message || status.description || 'Jules is waiting for your input';
          
          // Try to get a better message from activities
          const lastAgentMsg = activities.slice().reverse().find((a: any) => a.agentMessaged?.agentMessage);
          if (lastAgentMsg) {
            interruptMsg = lastAgentMsg.agentMessaged.agentMessage;
            // Mark it as printed so it doesn't duplicate if we fall through
            if (lastAgentMsg.id) printedAgentMessages.add(lastAgentMsg.id);
            if (lastAgentMsg.name) printedAgentMessages.add(lastAgentMsg.name);
          }

          console.log('\n' + chalk.bold.white('── Jules needs your input ──────────'));
          const cols = process.stdout.columns || 80;
          const wrapWidth = Math.max(20, cols - 10);
          const wrappedMsg = wrapText(interruptMsg, wrapWidth, '          ');
          console.log(chalk.yellow(`⚠ ${wrappedMsg}`));

          if (status.options && Array.isArray(status.options)) {
            console.log('\nOptions:');
            status.options.forEach((opt: any, idx: number) => {
              const label = typeof opt === 'string' ? opt : opt.label || opt.text || 'Option ' + (idx + 1);
              console.log(`  ${idx + 1}. ${label}`);
            });
          }

          
          if (process.stdin.isTTY) {
            try { process.stdin.setRawMode(wasRaw); } catch (e) {}
          }

          clearAllIntervals();

          const userReply = await promptJulesReply('Your response (or type /exit):', sessionId);

          if (process.stdin.isTTY) {
            try { process.stdin.setRawMode(true); } catch (e) {}
          }
          process.stdin.resume();
          

          if (shellState.escCancelled || userReply.trim().toLowerCase() === '/exit' || localSignal.aborted) {
            completed = true;
            break;
          }

          const msgSpinner = ora({ text: chalk.dim('Sending response…'), spinner: 'dots', color: 'white' }).start();
          const bridgedReply = bridgePathsInText(userReply);
          await sendJulesMessage(sessionId, bridgedReply, localSignal);
          msgSpinner.stop();
          
          console.log(chalk.bold.green('🧑 You: ') + chalk.white(userReply.trim()));
          console.log(chalk.dim('────────────────────────────────────\n'));
          
          spinner.start(formatSpinnerText(currentVerb, currentState));
          continue; // Poll again immediately
        }

        const rawDesc = status.description || status.executionStatus?.description || status.currentOperation || status.executionStatus?.currentOperation || '';
        if (rawDesc && rawDesc !== lastStatusDescription) {
          lastStatusDescription = rawDesc;
          currentVerb = rawDesc;
          if (spinner.isSpinning) spinner.stop();
          logger.info(rawDesc);
          spinner.start(formatSpinnerText(currentVerb, currentState));
        }
        
        if (shellState.escCancelled || localSignal.aborted || shellState.sessionAborted) {
          if (spinner.isSpinning) spinner.stop();
          clearAllIntervals();
          logger.info('Aborting Jules task...');
          try {
            await deleteJulesSession(sessionId);
          } catch (e) {}
          logger.info('Task cancelled.');
          completed = true;
          break;
        }

        if (isOffline) {
          isOffline = false;
          logger.success('Back online! Resuming sync...');
          spinner.start(chalk.bold.white(`∴ ${currentVerb}…`));
        }

        try {
          if (!initialized && activities.length > 0) {
            const isWaitingForInput = status.requires_user_input === true || 
                                      status.requiresUserInput === true ||
                                      ['inactive', 'question', 'interrupt', 'user_input_required', 'awaiting_user_feedback', 'awaiting_user_input', 'awaiting_input', 'paused', 'halted', 'blocked'].includes(status.state?.toLowerCase() || status.status?.toLowerCase() || status.type?.toLowerCase() || '') ||
                                      (activities.length > 0 && activities[activities.length - 1].agentMessaged?.agentMessage);
            
            const agentMsgs = activities.filter((a: any) => a.agentMessaged?.agentMessage);
            
            // Mark older messages as replied
            for (let i = 0; i < agentMsgs.length - 1; i++) {
              const msg = agentMsgs[i];
              if (msg.id) {
                printedAgentMessages.add(msg.id);
                repliedActivities.add(msg.id);
              }
              if (msg.name) {
                printedAgentMessages.add(msg.name);
                repliedActivities.add(msg.name);
              }
            }

            // Handle the VERY last message specially
            const lastAgentMsg = agentMsgs[agentMsgs.length - 1];
            if (lastAgentMsg) {
              if (!isWaitingForInput) {
                if (lastAgentMsg.id) {
                  printedAgentMessages.add(lastAgentMsg.id);
                  repliedActivities.add(lastAgentMsg.id);
                }
                if (lastAgentMsg.name) {
                  printedAgentMessages.add(lastAgentMsg.name);
                  repliedActivities.add(lastAgentMsg.name);
                }
                
                const cols = process.stdout.columns || 80;
                const wrapWidth = Math.max(20, cols - 10);
                const wrappedMsg = wrapText(lastAgentMsg.agentMessaged.agentMessage, wrapWidth, '          ');
                console.log('\n' + chalk.bold.white('💬 Jules (Last Message): ') + chalk.dim(wrappedMsg));
              }
            }

            // Cache all activities as seen during initialization
            for (const act of activities) {
              const actKey = act.id || act.name;
              if (actKey) seenActivities.add(actKey);
            }

            // Print historical mutated files
            const initialMutatedFiles = new Set<string>();
            for (const act of activities) {
              if (act.artifacts && Array.isArray(act.artifacts)) {
                for (const art of act.artifacts) {
                  let files: string[] = [];
                  if (art.codeChanges?.files) {
                    files = art.codeChanges.files.map((f: any) => f.path);
                  } else if (art.changeSet?.gitPatch?.unidiffPatch) {
                    try {
                      const patches = parsePatch(art.changeSet.gitPatch.unidiffPatch);
                      files = patches.map(p => {
                        let filePath = p.newFileName || p.oldFileName || 'unknown';
                        return filePath.replace(/^[ab]\//, '');
                      });
                    } catch (e) {}
                  }
                  for (const file of files) {
                    if (file && file !== 'unknown') {
                      initialMutatedFiles.add(file);
                    }
                  }
                }
              }
            }
            
            if (initialMutatedFiles.size > 0) {
              console.log(chalk.bold.white('📂 Modified files in session so far:'));
              for (const file of initialMutatedFiles) {
                const fullPath = path.join(process.cwd(), file);
                const isCreated = !fs.existsSync(fullPath);
                if (isCreated) {
                  console.log(chalk.bold.green('  Created ') + chalk.white(file));
                } else {
                  console.log(chalk.bold.cyan('  Updated ') + chalk.white(file));
                }
                printedMutations.add(`${file}:${isCreated ? 'created' : 'updated'}`);
              }
              console.log('');
            }

            // Render initial plan checklist if plan exists
            const latestPlanAct = activities.slice().reverse().find((a: any) => a.planGenerated?.plan);
            if (latestPlanAct) {
              const planSteps = latestPlanAct.planGenerated.plan.steps || [];
              let currentStepIndex = -1;
              const completedStepIndices = new Set<number>();

              planSteps.forEach((s: any, idx: number) => {
                const sState = (s.state || s.status || '').toUpperCase();
                if (sState === 'COMPLETED' || sState === 'SUCCESS' || sState === 'SUCCEEDED') {
                  completedStepIndices.add(idx);
                } else if (sState === 'RUNNING' || sState === 'IN_PROGRESS' || sState === 'ACTIVE') {
                  currentStepIndex = idx;
                }
              });

              if (currentStepIndex === -1) {
                for (let i = activities.length - 1; i >= 0; i--) {
                  const act = activities[i];
                  const actTitle = (act.progressUpdated?.title || '').toLowerCase();
                  const actDesc = (act.progressUpdated?.description || act.description || '').toLowerCase();
                  let foundMatch = false;
                  for (let idx = 0; idx < planSteps.length; idx++) {
                    const s = planSteps[idx];
                    const stepTitle = (s.title || '').toLowerCase();
                    const stepDesc = (s.description || '').toLowerCase();
                    if (
                      (stepTitle && (actTitle.includes(stepTitle) || actDesc.includes(stepTitle))) ||
                      (stepDesc && (actTitle.includes(stepDesc) || actDesc.includes(stepDesc)))
                    ) {
                      currentStepIndex = idx;
                      foundMatch = true;
                      break;
                    }
                  }
                  if (foundMatch) break;
                }
              }

              if (currentStepIndex >= 0) {
                for (let i = 0; i < currentStepIndex; i++) {
                  completedStepIndices.add(i);
                }
              }

              checkAndRenderPlanChecklist(planSteps, currentStepIndex, completedStepIndices);
            }

            initialized = true;
          }
        } catch (actError: any) {
          if (actError.response?.status !== 404) {
            // Ignore network errors in activities fetch
          }
        }

        if (shellState.escCancelled || localSignal.aborted || shellState.sessionAborted) {
          if (spinner.isSpinning) spinner.stop();
          clearAllIntervals();
          logger.info('Aborting Jules task...');
          try {
            await deleteJulesSession(sessionId);
          } catch (e) {}
          logger.info('Task cancelled.');
          completed = true;
          break;
        }

        // Check if there are any unreplied agent messages
        const unrepliedActivity = activities.find((a: any) => 
          a.agentMessaged?.agentMessage && 
          !repliedActivities.has(a.id) && 
          !repliedActivities.has(a.name)
        );
        if (unrepliedActivity) {
          if (spinner.isSpinning) spinner.stop();
          
          if (!printedAgentMessages.has(unrepliedActivity.id) && !printedAgentMessages.has(unrepliedActivity.name)) {
            if (unrepliedActivity.id) printedAgentMessages.add(unrepliedActivity.id);
            if (unrepliedActivity.name) printedAgentMessages.add(unrepliedActivity.name);
            console.log('\n');
            const cols = process.stdout.columns || 80;
            const wrapWidth = Math.max(20, cols - 10);
            const wrappedMsg = wrapText(unrepliedActivity.agentMessaged.agentMessage, wrapWidth, '          ');
            console.log(chalk.bold.white('💬 Jules: ') + chalk.white(wrappedMsg));
          }
          
          // Remove our session cancel keypress listener while user is replying
          
          if (process.stdin.isTTY) {
            try { process.stdin.setRawMode(wasRaw); } catch (e) {}
          }

          clearAllIntervals();

          const userReply = await promptJulesReply('Reply (or type /exit):');

          if (process.stdin.isTTY) {
            try { process.stdin.setRawMode(true); } catch (e) {}
          }
          process.stdin.resume();
          

          if (shellState.escCancelled || userReply.trim().toLowerCase() === '/exit' || localSignal.aborted) {
            completed = true;
            break;
          }

          const msgSpinner = ora({ text: chalk.dim('Sending message…'), spinner: 'dots', color: 'white' }).start();
          const bridgedReply = bridgePathsInText(userReply);
          await syncLocalChanges();
          
          await sendJulesMessage(sessionId, bridgedReply, localSignal);
          msgSpinner.stop();
          logger.success('Message sent successfully.');

          if (unrepliedActivity.id) repliedActivities.add(unrepliedActivity.id);
          if (unrepliedActivity.name) repliedActivities.add(unrepliedActivity.name);
          spinner.start(chalk.bold.white(`∴ ${currentVerb}…`));
          continue; // Poll again immediately
        }

        for (const activity of activities) {
          const actKey = activity.id || activity.name;
          if (!actKey) continue;

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

          if (!seenActivities.has(actKey)) {
            // Plan Approval Block
            if (activity.planGenerated?.plan && !approvedPlans.has(actKey)) {
              approvedPlans.add(actKey);
              
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
                a.planApproved
              );

              if (!isAlreadyApproved) {
                let approvePlan = true;
                if (currentMode === 'plan') {
                  if (process.stdin.isTTY) {
                    try { process.stdin.setRawMode(wasRaw); } catch (e) {}
                  }
                  
                  const approve = await askUser(chalk.bold.white('Approve plan? (y/n): '));

                  if (process.stdin.isTTY) {
                    try { process.stdin.setRawMode(true); } catch (e) {}
                  }
                  process.stdin.resume();

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
                  await approveJulesPlan(sessionId, localSignal);
                  approveSpinner.stop();
                } catch (e: any) {
                  approveSpinner.stop();
                }
              }
              
              spinner.start(chalk.bold.white(`∴ ${currentVerb}…`));
            }

            // Print agent messages in the activities feed too, if not already handled
            if (activity.agentMessaged?.agentMessage && !printedAgentMessages.has(activity.id) && !printedAgentMessages.has(activity.name)) {
              if (spinner.isSpinning) spinner.stop();
              const cols = process.stdout.columns || 80;
              const wrapWidth = Math.max(20, cols - 10);
              const wrappedMsg = wrapText(activity.agentMessaged.agentMessage, wrapWidth, '          ');
              console.log('\n' + chalk.bold.white('💬 Jules: ') + chalk.white(wrappedMsg));
              if (activity.id) printedAgentMessages.add(activity.id);
              if (activity.name) printedAgentMessages.add(activity.name);
              spinner.start(chalk.bold.white(`∴ ${currentVerb}…`));
            }

            if (activity.planApproved) {
              if (spinner.isSpinning) spinner.stop();
              logger.success('Plan approved 🎉');
              spinner.start(chalk.bold.white(`∴ ${currentVerb}…`));
            }

            // Output real-time file tree mutations directly into the console layout
            const mutatedFiles = new Set<string>();
            if (activity.artifacts && Array.isArray(activity.artifacts)) {
              for (const art of activity.artifacts) {
                let files: string[] = [];
                if (art.codeChanges?.files) {
                  files = art.codeChanges.files.map((f: any) => f.path);
                } else if (art.changeSet?.gitPatch?.unidiffPatch) {
                  try {
                    const patches = parsePatch(art.changeSet.gitPatch.unidiffPatch);
                    files = patches.map(p => {
                      let filePath = p.newFileName || p.oldFileName || 'unknown';
                      return filePath.replace(/^[ab]\//, '');
                    });
                  } catch (e) {}
                }
                for (const file of files) {
                  if (file && file !== 'unknown') {
                    mutatedFiles.add(file);
                  }
                }
              }
            }

            const desc = (activity.description || '').toLowerCase();
            const progDesc = (activity.progressUpdated?.description || '').toLowerCase();
            const progTitle = (activity.progressUpdated?.title || '').toLowerCase();
            
            const fileRegexes = [
              /(?:created|creating|updated|updating|wrote|writing|saved|saving|modified|modifying)\s+(?:file\s+)?([a-zA-Z0-9_\-\.\/\\~@]+)/gi,
              /([a-zA-Z0-9_\-\.\/\\~@]+)\s+(?:has been|was)?\s*(?:created|updated|modified)/gi
            ];
            
            for (const text of [desc, progDesc, progTitle]) {
              if (!text) continue;
              for (const regex of fileRegexes) {
                let match;
                while ((match = regex.exec(text)) !== null) {
                  const filePath = match[1];
                  if (filePath && (filePath.includes('.') || filePath.includes('/'))) {
                    if (!filePath.startsWith('http') && !/^\d+$/.test(filePath) && filePath.length > 2) {
                      mutatedFiles.add(filePath);
                    }
                  }
                }
              }
            }

            for (const file of mutatedFiles) {
              const fullPath = path.join(process.cwd(), file);
              const isCreated = !fs.existsSync(fullPath);
              const mutationKey = `${file}:${isCreated ? 'created' : 'updated'}`;
              if (!printedMutations.has(mutationKey)) {
                printedMutations.add(mutationKey);
                if (spinner.isSpinning) spinner.stop();
                if (isCreated) {
                  console.log(chalk.bold.green('  Created ') + chalk.white(file));
                } else {
                  console.log(chalk.bold.cyan('  Updated ') + chalk.white(file));
                }
                spinner.start(formatSpinnerText(currentVerb, currentState));
              }
            }

            // Detect step progress & print tool use
            if (activity.progressUpdated?.title || activity.progressUpdated?.description || activity.description) {
              const title = activity.progressUpdated?.title || '';
              const description = activity.progressUpdated?.description || activity.description || '';
              const text = title + (title && description ? ': ' : '') + description;
              if (spinner.isSpinning) spinner.stop();
              printToolUse(text);
              currentVerb = text;
              spinner.start(formatSpinnerText(currentVerb, currentState));
            }
            
            seenActivities.add(actKey);
          }
        }

        const upperState = (status.state || status.status || '').toUpperCase();
        if (upperState === 'COMPLETED' || upperState === 'SUCCEEDED' || upperState === 'SUCCESS') {
          if (spinner.isSpinning) spinner.stop();
          clearAllIntervals();
          console.log('');
          logger.success('Task Completed!');
          
          try {
            const finalSession = await getSessionStatus(sessionId, localSignal);
            const outRepo = finalSession.outputRepo || finalSession.executionStatus?.outputRepo;
            const outBranch = finalSession.outputBranch || finalSession.executionStatus?.outputBranch;
            const compareUrl = finalSession.compareUrl || finalSession.executionStatus?.compareUrl;
            const sessionUrl = `https://jules.google.com/sessions/${sessionId}`;

            const divider = chalk.dim('  ' + '─'.repeat(50));
            console.log(divider);
            console.log(`  🆔 ${chalk.cyan('Session ID'.padEnd(13))} : ${chalk.white(sessionId)}`);
            console.log(`  🌐 ${chalk.cyan('Session URL'.padEnd(13))} : ${chalk.yellow(sessionUrl)}`);
            
            if (outRepo && outBranch) {
              console.log(`  📦 ${chalk.cyan('Output Repo'.padEnd(13))} : ${chalk.yellow.underline(outRepo)}`);
              console.log(`  🌿 ${chalk.cyan('Output Branch'.padEnd(13))} : ${chalk.white(outBranch)}`);
              if (compareUrl) {
                console.log(`  🔗 ${chalk.cyan('View Changes'.padEnd(13))} : ${chalk.yellow.underline(compareUrl)}`);
              }
            } else {
              console.log(chalk.yellow('  ⚠ Output repo info not available via API.'));
            }
            console.log(divider);
            console.log(chalk.dim('  💡 Tip: Review changes on GitHub before merging.\n'));
          } catch (e) {
            console.log(chalk.yellow('  ⚠ Output repo info not available via API.'));
          }
          
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
              if (forceSync || shouldApplyChanges(sessionId)) {
                const applied = await applyChanges(changes);
                
                // Save sync state
                try {
                  const branch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
                  execSync(`git fetch origin ${branch}`, { stdio: 'ignore' });
                  const remoteCommit = execSync(`git rev-parse origin/${branch}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
                  saveSyncState(remoteCommit, sessionId, changes.map(c => c.path), !applied);
                } catch (e) {}

                if (applied) {
                  restoreExternalMappedFiles();
                }
              }
            } else {
              logger.warn('No valid code changes found in the artifact.');
            }
          } else {
            logger.warn('No code changes found in the completed session.');
          }

          completed = true;
        } else if (upperState === 'FAILED' || upperState === 'ERROR') {
          if (spinner.isSpinning) spinner.stop();
          clearAllIntervals();
          logger.error('Jules session failed.');

          completed = true;
        } else if (status.state?.toUpperCase() === 'INACTIVE') {
          if (spinner.isSpinning) spinner.stop();
          console.log('\n' + chalk.bold.yellow('⏸ Session is inactive - chat to resume'));
          
          
          if (process.stdin.isTTY) {
            try { process.stdin.setRawMode(wasRaw); } catch (e) {}
          }

          clearAllIntervals();

          const userReply = await promptJulesReply('Chat to resume (or type /exit):');

          if (process.stdin.isTTY) {
            try { process.stdin.setRawMode(true); } catch (e) {}
          }
          process.stdin.resume();
          

          if (shellState.escCancelled || userReply.trim().toLowerCase() === '/exit' || localSignal.aborted) {
            completed = true;
            break;
          }

          const msgSpinner = ora({ text: chalk.dim('Sending message to resume…'), spinner: 'dots', color: 'white' }).start();
          const bridgedReply = bridgePathsInText(userReply);
          await syncLocalChanges();
          
          await sendJulesMessage(sessionId, bridgedReply, localSignal);
          msgSpinner.stop();
          logger.success('Message sent successfully. Resuming session...');
          
          spinner.start(chalk.bold.white(`∴ ${currentVerb}…`));
          continue; // Poll again immediately
        } else {
          await cancellableSleep(2000);
        }
      } catch (pollError: any) {
        if (shellState.escCancelled || localSignal.aborted || shellState.sessionAborted) {
          if (spinner.isSpinning) spinner.stop();
          clearAllIntervals();
          logger.info('Aborting Jules task...');
          try {
            await deleteJulesSession(sessionId);
          } catch (e) {}
          logger.info('Task cancelled.');
          completed = true;
          break;
        }
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
          await cancellableSleep(5000);
          continue;
        }

        if (spinner.isSpinning) spinner.stop();
        if (pollError.response?.status === 404) {
           clearAllIntervals();
           console.log(chalk.yellow('\n⚠ Session not found or has ended.'));
           if (repoUrl) {
             logger.error(`Jules could not find the repository/session.`);
             logger.info(`Ensure that the Google Jules GitHub App is installed and has access to your repository:`);
             logger.info(`  ${sanitizeUrlForDisplay(repoUrl)}`);
           } else {
             logger.error('Session not found (404). Stopping.');
           }
           completed = true;
           break; 
        }
        logger.error(`Polling error: ${pollError.message}`);
        spinner.start(chalk.bold.white(`∴ ${currentVerb}…`));
        await cancellableSleep(2000);
      }
    }
  } finally {
    if (spinner && spinner.isSpinning) spinner.stop();
    if (activePollingTimer) {
      clearInterval(activePollingTimer!);
      activePollingTimer = null;
    }
    if (shellState.activePollTimer === activePollingTimer) {
      shellState.activePollTimer = null;
    }
    
    if (shellState.escCancelled || localSignal.aborted || shellState.sessionAborted) {
      try {
        await deleteJulesSession(sessionId);
      } catch (e) {}
    }

    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(wasRaw); } catch (e) {}
    }

    // Check for new projects to create repos for
    await handleNewProjects();
  }
}

async function handleEdit(instruction: string) {
  shellState.sessionAborted = false;
  shellState.escCancelled = false;
  const localSignal = shellState.abortController.signal;
  await enforceWorkspace();
  validateEnv();
  let repoUrl = '';
  let sessionId: string | undefined;
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

    if (shellState.trackedSessionId) {
      sessionId = shellState.trackedSessionId;
      spinner = ora({
        text: chalk.dim('Sending message to Jules…'),
        spinner: 'dots',
        color: 'white'
      }).start();

      await sendJulesMessage(sessionId, bridgedInstruction, localSignal);
      spinner.stop();
      logger.success(`Message sent to tracked session · ${chalk.dim(sessionId)}`);
      
      await trackJulesSession(sessionId, repoUrl);
      return;
    }

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
        session = await createJulesSession(bridgedInstruction, repoUrl, branch, undefined, localSignal);
        break;
      } catch (err: any) {
        if (err.response?.status === 404 && retries > 0) {
          retries--;
          spinner.text = chalk.yellow(`⚠ Waiting for GitHub app sync... Retrying in 3s (${retries} retries left)`);
          await cancellableSleep(3000);
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

    // 5. Polling Loop
    await trackJulesSession(sessionId!, repoUrl);
  } catch (error: any) {
    if (shellState.escCancelled) return;
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
  console.log(chalk.bold.white('📚 JULES CLI - DOCUMENTATION (v2.0)'));
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
  console.log(chalk.white('   • /repo                  : Switch between multiple projects interactively'));
  console.log(chalk.white('   • /sync                  : Manually push local changes to the cloud'));
  console.log(chalk.white('   • /session [ls|rm|track] : List, delete, or track/resume active sessions'));
  console.log(chalk.white('   • /restore               : Recover files from automatic backups (.bak)'));
  console.log(chalk.white('   • /docs                  : Show this documentation manual'));
  
  console.log(`\n${chalk.bold.cyan('7. CLOUD PERSISTENCE')}`);
  console.log(chalk.white('   Your sessions and shadow repositories are stored in the cloud.'));
  console.log(chalk.white('   Access them anytime at https://jules.google.com'));

  console.log(`\n${chalk.bold.cyan('8. CONTACT & COMMUNITY')}`);
  console.log(chalk.white('   • Developer : https://t.me/R3V_X'));
  console.log(chalk.white('   • Community : https://t.me/allinformation0173'));
  console.log(chalk.white('   • Instagram : https://www.instagram.com/opeditzxx/'));

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

  printGroup('Control & Terminal', [
    { keys: 'Ctrl + Z',     desc: 'Suspend CLI process (SIGTSTP)' },
    { keys: 'Ctrl + \\',    desc: 'Terminate CLI process (SIGQUIT)' },
    { keys: 'Ctrl + C',     desc: 'Cancel current input or exit search mode' },
    { keys: 'End + D',      desc: 'Delete workspace and restart' },
    { keys: 'Tab',          desc: 'Cycle autocomplete suggestions' },
    { keys: 'Shift+Tab/Meta+Tab', desc: 'Cycle autocomplete suggestions in reverse' },
  ]);

  console.log('\n' + chalk.dim('─'.repeat(60)));
  console.log('');
}

async function handleRestore() {
  if (shellState.escCancelled) return;
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
      if (shellState.escCancelled) {
        restoreSpinner.stop();
        process.stdout.write('\n' + chalk.yellow('⚠ Operation cancelled.\n'));
        return;
      }
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
    if (shellState.escCancelled) return;
    logger.error(`Restore failed: ${error.message}`);
  }
}

async function handleSessionCommand(args: string[]) {
  const localSignal = shellState.abortController.signal;
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
      const settings = loadSettings();
      const storedTrackedId = settings.trackedSessionId;
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

        const isTracked = id === storedTrackedId || id === shellState.trackedSessionId;

        const stateIcon =
          state === 'COMPLETED'            ? chalk.green('✓') :
          state === 'FAILED'               ? chalk.red('✗') :
          state === 'AWAITING_USER_FEEDBACK' ? chalk.yellow('◆') :
          state === 'RUNNING'              ? chalk.cyan('⠋') :
                                             chalk.dim('○');

        console.log(
          `  ${stateIcon} ${chalk.white(prompt)}${prompt.length >= 52 ? chalk.dim('…') : ''}${isTracked ? chalk.bold.cyan(' [Tracked]') : ''}` +
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
      await deleteJulesSession(sessionId, localSignal);
      deleteSpinner.stop();
      logger.success(`Session deleted.`);
    } catch (error: any) {
      deleteSpinner.stop();
      logger.error(`Failed to delete: ${error.message}`);
    }
  } else if (subcommand === 'track' || subcommand === 'watch') {
    shellState.escCancelled = false;
    if (activePollingTimer) {
      clearInterval(activePollingTimer!);
      activePollingTimer = null;
    }
    const sessionId = args[1];
    if (!sessionId) {
      logger.error('Error: Please specify a sessionId. Usage: /session track [sessionId]');
      return;
    }
    const validateSpinner = ora({ text: chalk.dim(`Validating session ${sessionId}…`), spinner: 'dots', color: 'white' }).start();
    try {
      const status = await getSessionStatus(sessionId, localSignal);
      validateSpinner.stop();
      
      shellState.trackedSessionId = sessionId;
      const sessionUrl = `https://jules.google.com/sessions/${sessionId}`;
      shellState.trackedSessionUrl = sessionUrl;
      saveSettings({ trackedSessionId: sessionId, trackedSessionUrl: sessionUrl });
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
    shellState.trackedSessionUrl = null;
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
  let projectName = await enforceWorkspace();
  await ensureGitAndRemoteLinked();
  let branch = await getCurrentBranch() || 'main';
  let shadowUrl = await getRemoteUrl();

  const getTermSize = () => ({
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24
  });

  const squidMascot = [
    '      ▄████████▄',
    '     ███▀    ▀███',
    '    ███  ●  ●  ███',
    '    ███        ███',
    '   ▄███  █  █  ███▄',
    '  █████  █  █  █████',
    '  ▀███▀  ▀  ▀  ▀███▀'
  ].join('\n');

  function printMascot(cols: number) {
    if (cols >= 40) {
      console.log(chalk.hex('#7C3AED')(squidMascot));
    }
  }

  const figletFullText = [
    '      _ _   _   _ _      _____ ____       ____ _     ___ ',
    '     | | | | | | | |    | ____/ ___|     / ___| |   |_ _|',
    '  _  | | | | | | | |    |  _| \\___ \\    | |   | |    | | ',
    ' | |_| | | |_| | | |___ | |___ ___) |   | |___| |___ | | ',
    '  \\___/|_|  \\___/|_____||_____|____/     \\____|_____|___|'
  ].join('\n');

  function printAsciiTitle(cols: number) {
    if (cols >= 60) {
      console.log(chalk.bold.white(figletFullText));
      console.log(chalk.bold.white('\n                JULES  C L I   —  research preview Developer: Rev'));
      console.log(chalk.bold.white('                Version: 2.0'));
    } else if (cols >= 40) {
      console.log(chalk.bold.white('[ JULES CLI ] ') + chalk.dim('— research preview Developer: Rev'));
      console.log(chalk.bold.white('                Version: 2.0'));
    } else {
      console.log(chalk.bold.white('JULES CLI — Rev v2.0'));
    }
  }

  function printInfoPanel(cols: number) {
    const divider = '─'.repeat(Math.max(0, cols - 2));
    const labelWidth = 14;
    const row = (emoji: string, label: string, value: string) => {
      const paddedLabel = (emoji + ' ' + label).padEnd(labelWidth);
      const maxVal = cols - labelWidth - 4;
      // URL fields NEVER truncated, NEVER wrapped
      const isUrl = value && (value.startsWith('http') || label === 'Shadow' || label === 'Session URL');
      const displayVal = (value && value.length > maxVal && !isUrl) ? value.substring(0, maxVal) + '...' : (value || '(none)');
      return chalk.cyan(paddedLabel) + chalk.white(': ') + (isUrl ? chalk.yellow(displayVal) : chalk.white(displayVal));
    };

    const maskedShadowUrl = shadowUrl ? shadowUrl.replace(/https:\/\/[^@]+@/, 'https://') : '(none)';

    console.log(divider);
    console.log(row('📁', 'Project', projectName));
    console.log(row('🌿', 'Branch', cachedBranch));
    console.log(row('⚡', 'Mode', currentMode.toUpperCase()));
    console.log(row('🔗', 'Shadow', maskedShadowUrl));
    console.log(row('🆔', 'Session ID', shellState.trackedSessionId || '(none)'));
    console.log(row('🌐', 'Session URL', shellState.trackedSessionUrl || '(none)'));
    console.log(divider);
  }

  function printTips(cols: number) {
    if (cols < 40) return; // MINIMAL mode has no tips

    const wrap = (text: string) => {
      const words = text.split(' ');
      let line = '';
      const lines: string[] = [];
      for (const word of words) {
        if ((line + word).length > cols - 2) {
          lines.push(line.trim());
          line = '';
        }
        line += word + ' ';
      }
      if (line.trim()) lines.push(line.trim());
      return lines.join('\n');
    };
    
    console.log(chalk.bold('Tips for getting started:'));
    console.log(wrap('1. Run /init to link this directory to a shadow repository'));
    console.log(wrap('2. Type your coding instruction and press Enter to edit files'));
    console.log(wrap('/help for commands · /exit to quit'));
    console.log('');
  }

  // Detect new projects on startup
  const newProjectPath = await handleNewProjects();
  if (newProjectPath) {
    process.chdir(newProjectPath);
    projectName = path.basename(newProjectPath);
    await ensureGitAndRemoteLinked();
    branch = await getCurrentBranch() || 'main';
    shadowUrl = await getRemoteUrl();
    shellState.trackedSessionId = null;
    shellState.trackedSessionUrl = null;
    logger.success(`Automatically switched to new project: ${projectName}`);
  }

  await printBanner(projectName, branch, currentMode, shadowUrl, shellState.trackedSessionId, shellState.trackedSessionUrl);

  console.log(chalk.bold.white('  Tips for getting started:'));
  console.log(chalk.white('  1. Run ') + chalk.bold.cyan('/init') + chalk.white(' to link this directory to a shadow repository'));
  console.log(chalk.white('  2. Type your coding instruction and press ') + chalk.bold('Enter') + chalk.white(' to edit files\n'));

  const commandsList = ['/init', '/newrepo', '/repo', '/sync', '/edit', '/restore', '/session', '/usage', '/plan', '/fast', '/clear', '/help', '/docs', '/shot', '/deleteworkspace', '/exit'];

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
    const currentPrompt = (rl as any)._prompt || '';
    const cleanPrompt = currentPrompt.replace(/\u001b\[[0-9;]*m/g, '');
    const actualPromptLen = cleanPrompt.length;
    const col = actualPromptLen + rl.cursor;

    // Save current position, move to prompt column, clear everything below
    readline.cursorTo(process.stdout, col);
    readline.clearScreenDown(process.stdout);
    activeBottomLines = 0;
  };

  const clearBottomAreaOnEnter = () => {
    if (activeBottomLines === 0) return;
    // When Enter is pressed, the cursor is at the end of the input line.
    // We just need to clear everything below it.
    readline.clearScreenDown(process.stdout);
    activeBottomLines = 0;
  };

  const drawBottomArea = (matches: string[] = []) => {
    const rows = process.stdout.rows || 24;
    const cols = process.stdout.columns || 80;

    // Lower threshold for mobile/small screens
    if (rows < 8 || cols < 30) {
      clearBottomArea();
      shellState.isBottomAreaRendered = false;
      return;
    }
    shellState.isBottomAreaRendered = true;
    clearBottomArea();

    const lines: string[] = [];
    lines.push(chalk.dim('─'.repeat(Math.max(0, cols - 2))));

    const projectName = path.basename(process.cwd());
    const mode = currentMode.toUpperCase();
    
    // Header Line: ⚙️ JULES-CLI | 📁 project [🌿 branch] | ⚡ MODE: FAST
    const headerContent = `⚙️  JULES-CLI | 📁 ${projectName} [🌿 ${cachedBranch}] | ⚡ MODE: ${mode}`;
    let truncatedHeader = headerContent;
    if (truncatedHeader.length > cols - 2) {
      truncatedHeader = `⚙️  JULES | 📁 ${projectName} [🌿 ${cachedBranch}]`;
      if (truncatedHeader.length > cols - 2) {
        truncatedHeader = `⚙️  JULES | 📁 ${projectName}`;
        if (truncatedHeader.length > cols - 2) {
          truncatedHeader = truncatedHeader.substring(0, cols - 5) + '...';
        }
      }
    }
    lines.push(chalk.cyan(truncatedHeader));
    lines.push(chalk.dim('─'.repeat(Math.max(0, cols - 2))));

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

    // Tips line: 💡 Tips: `/init` to link repo • `/help` for commands • `/exit` to quit
    const tipsContent = `💡 Tips: \`/init\` to link repo  •  \`/help\` for commands  •  \`/exit\` to quit`;
    let truncatedTips = tipsContent;
    if (truncatedTips.length > cols - 2) {
      truncatedTips = `💡 Tips: /init • /help • /exit`;
      if (truncatedTips.length > cols - 2) {
        truncatedTips = truncatedTips.substring(0, cols - 5) + '...';
      }
    }
    lines.push(chalk.dim(truncatedTips));
    lines.push(chalk.dim('─'.repeat(Math.max(0, cols - 2))));

    const currentPrompt = (rl as any)._prompt || '';
    const cleanPrompt = currentPrompt.replace(/\u001b\[[0-9;]*m/g, '');
    const actualPromptLen = cleanPrompt.length;
    let col = actualPromptLen + rl.cursor;
    if (isNaN(col)) col = 0;

    for (const line of lines) {
      process.stdout.write(`\n\r\u001b[2K${line}`);
    }

    activeBottomLines = lines.length;
    readline.moveCursor(process.stdout, 0, -activeBottomLines);
    readline.cursorTo(process.stdout, col);
  };

  const showPrompt = () => {
    shellState.escCancelled = false;
    shellState.sessionAborted = false;
    shellState.abortController = new AbortController();
    if (shellState.isRestarting || (rl as any).closed) return;

    const cols = process.stdout.columns || 80;
    process.stdout.write('\n' + chalk.bold.cyan('🤖 Jules-CLI » ') + chalk.dim('Type your coding instruction...') + '\n');
    
    rl.setPrompt(chalk.bold.cyan('❯ '));

    if (!(rl as any).closed) rl.prompt();

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
    
    if (!(rl as any).closed) rl.pause();
    disableShellBracketedPaste();
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch (e) {}
    }
    
    const { spawn } = require('child_process');
    const child = spawn(editor, [tempFile], { stdio: 'inherit' });
    
    child.on('exit', () => {
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(true); } catch (e) {}
      }
      process.stdout.write('\u001b[?2004h');
      if (!(rl as any).closed) rl.resume();
      
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

    const isEscape = (key && key.name === 'escape' && (key.sequence === '\u001b' || key.sequence === '\x1b')) ||
                     (!key && (char === '\u001b' || char === '\x1b'));
    if (isEscape) {
      handleEscapePress();
      return;
    }

    if (key) {

      // Ctrl + Z (Suspend)
      if (key.ctrl && key.name === 'z') {
        disableShellBracketedPaste();
        if (process.stdin.isTTY) {
          try { process.stdin.setRawMode(false); } catch (e) {}
        }
        process.kill(process.pid, 'SIGTSTP');
        process.once('SIGCONT', () => {
          if (process.stdin.isTTY) {
            try { process.stdin.setRawMode(true); } catch (e) {}
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

      // Ctrl + C (SIGINT)
      if (key.ctrl && key.name === 'c') {
        if (rl.line || accumulatedLines.length > 0 || isPasting) {
          accumulatedLines = [];
          altEnterPressed = false;
          shellPastedBlocks = [];
          shellPasteCount = 0;
          isPasting = false;
          rl.setPrompt(chalk.bold.white(PROMPT_STR));
          (rl as any).line = '';
          (rl as any).cursor = 0;
          (rl as any)._refreshLine();
          activeMatches = [];
          cyclingIndex = -1;
          lastCyclingIndex = -1;
          drawBottomArea([]);
        } else {
          clearBottomArea();
          console.log(chalk.yellow('\nGoodbye!'));
          process.exit(0);
        }
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

      // End + D (Delete workspace and restart)
      if (key.name === 'end' && (char === 'd' || char === 'D')) {
        const wsRoot = getWorkspaceRoot();
        logger.info(`\nDeleting workspace: ${wsRoot}...`);
        try {
          const parentDir = path.dirname(wsRoot);
          try {
            process.chdir(fs.existsSync(parentDir) ? parentDir : require('os').homedir());
          } catch (e) {}

          if (fs.existsSync(wsRoot)) {
            fs.rmSync(wsRoot, { recursive: true, force: true });
          }
          logger.success('Workspace deleted. Restarting Jules CLI...');
          shellState.isRestarting = true;
          if (process.stdin.isTTY) {
            try { process.stdin.setRawMode(false); } catch (e) {}
          }
          rl.close();
          const { spawn } = require('child_process');
          const child = spawn(process.argv[0], process.argv.slice(1), {
            stdio: 'inherit',
            cwd: process.cwd()
          });
          child.on('exit', (code: number | null) => {
            process.exit(code || 0);
          });
        } catch (err: any) {
          logger.error(`Failed to delete workspace: ${err.message}`);
        }
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

  if (!shellState.keypressEventsEmitted) {
    readline.emitKeypressEvents(process.stdin);
    shellState.keypressEventsEmitted = true;
  }
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(true); } catch (e) {}
  }
  process.stdin.resume();

  shellState.keypressHandler = handleKeypress;
  shellState.showPrompt = showPrompt;
  process.stdin.removeListener('keypress', handleKeypress);
  process.stdin.prependListener('keypress', handleKeypress);

  console.log(chalk.dim('  Type /help for commands · /exit to quit'));
  process.stdout.write('\u001b[?2004h');
  showPrompt();

  shellState.shellLineHandler = async (line) => {
    const localSignal = shellState.abortController.signal;
    if (shellState.isRestarting) return;

    const endsWithBackslash = line.endsWith('\\');
    if (altEnterPressed || endsWithBackslash) {
      const lineToPush = endsWithBackslash ? line.slice(0, -1) : line;
      accumulatedLines.push(lineToPush);
      altEnterPressed = false;
      rl.setPrompt('  ');
      if (!(rl as any).closed) rl.prompt();
      drawBottomArea([]);
      shellState.isBottomAreaRendered = true;
      return;
    }

    shellState.isTaskActive = true;
    try {
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
    let hadPlaceholders = false;
    for (let i = 0; i < shellPastedBlocks.length; i++) {
      const placeholderPattern = `[pasted text #${i + 1} [`;
      const idx = substitutedLine.indexOf(placeholderPattern);
      if (idx !== -1) {
        const endIdx = substitutedLine.indexOf(']]', idx + placeholderPattern.length);
        if (endIdx !== -1) {
          const fullPlaceholder = substitutedLine.substring(idx, endIdx + 2);
          substitutedLine = substitutedLine.replace(fullPlaceholder, shellPastedBlocks[i]);
          hadPlaceholders = true;
        }
      }
    }

    if (hadPlaceholders) {
      if (!(rl as any).closed) rl.pause();
      const proceed = await previewLargePaste(substitutedLine);
      if (!(rl as any).closed) rl.resume();

      if (!proceed) {
        shellPastedBlocks = [];
        shellPasteCount = 0;
        if (shellState.keypressHandler) {
          process.stdin.removeListener('keypress', shellState.keypressHandler);
          process.stdin.prependListener('keypress', shellState.keypressHandler);
        }
        process.stdout.write('\u001b[?2004h');
        showPrompt();
        return;
      }
    }

    shellPastedBlocks = [];
    shellPasteCount = 0;

    // Detect new projects before processing task
    const nextPath = await handleNewProjects();
    if (nextPath) {
      process.chdir(nextPath);
      projectName = path.basename(nextPath);
      await ensureGitAndRemoteLinked();
      branch = await getCurrentBranch() || 'main';
      shadowUrl = await getRemoteUrl();
      shellState.trackedSessionId = null;
      shellState.trackedSessionUrl = null;
      logger.success(`Automatically switched to new project: ${projectName}`);
      await printBanner(projectName, branch, currentMode, shadowUrl, shellState.trackedSessionId, shellState.trackedSessionUrl);
    }

    const input = substitutedLine.trim();
    if (!input) {
      if (shellState.keypressHandler) {
        process.stdin.removeListener('keypress', shellState.keypressHandler);
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
        process.stdin.removeListener('keypress', shellState.keypressHandler);
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
          if (!(rl as any).closed) rl.pause();
          await handleEdit(finalInput);
        } finally {
          if (!(rl as any).closed) rl.resume();
          if (shellState.keypressHandler) {
            process.stdin.removeListener('keypress', shellState.keypressHandler);
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
            if (!(rl as any).closed) rl.pause();
            await handleInit();
          } finally {
            if (!(rl as any).closed) rl.resume();
          }
          break;
        case '/newrepo':
          try {
            if (!(rl as any).closed) rl.pause();
            await handleNewRepo();
          } finally {
            if (!(rl as any).closed) rl.resume();
          }
          break;
        case '/repo':
          try {
            if (!(rl as any).closed) rl.pause();
            await handleNewProjects();
            if (!(rl as any).closed) rl.resume();

            const wsRoot = getWorkspaceRoot();
            const localProjects = fs.readdirSync(wsRoot).filter(f => {
              const fullPath = path.join(wsRoot, f);
              return fs.statSync(fullPath).isDirectory() && !f.startsWith('.');
            });

            if (!(rl as any).closed) rl.pause();
            const spinner = ora({ text: chalk.dim('Fetching GitHub repositories...'), color: 'magenta' }).start();
            const githubRepos = await listUserRepos();
            spinner.stop();
            if (!(rl as any).closed) rl.resume();

            console.log(chalk.bold.white('\n  Available Local Projects:'));
            if (localProjects.length === 0) {
              console.log(chalk.dim('    (No local projects found)'));
            } else {
              localProjects.forEach((p, i) => {
                console.log(`    ${chalk.bold.cyan((i + 1).toString().padEnd(3))} ${chalk.white(p)}`);
              });
            }

            console.log(chalk.bold.white('\n  Your GitHub Repositories:'));
            const displayRepos = githubRepos.slice(0, 15); // Show top 15 updated
            displayRepos.forEach((r: any, i: number) => {
              const num = localProjects.length + i + 1;
              console.log(`    ${chalk.bold.cyan(num.toString().padEnd(3))} ${chalk.white(r.name)} ${chalk.dim('(' + r.full_name + ')')}`);
            });
            console.log('');

            if (!(rl as any).closed) rl.pause();
            const choice = await askUser(chalk.hex('#2ec4b6')('Select number or type name to switch/init (Enter to cancel): '));
            if (!(rl as any).closed) rl.resume();

            if (!choice.trim()) break;

            let selectedProject = '';
            let selectedRepoUrl = '';
            const numChoice = parseInt(choice.trim());

            if (!isNaN(numChoice)) {
              if (numChoice >= 1 && numChoice <= localProjects.length) {
                selectedProject = localProjects[numChoice - 1];
              } else if (numChoice > localProjects.length && numChoice <= localProjects.length + displayRepos.length) {
                const repo = displayRepos[numChoice - localProjects.length - 1];
                selectedProject = repo.name;
                selectedRepoUrl = repo.clone_url.replace('https://', `https://${config.GITHUB_TOKEN}@`);
              }
            } else {
              // Try match by name
              const localMatch = localProjects.find(p => p.toLowerCase() === choice.trim().toLowerCase());
              if (localMatch) {
                selectedProject = localMatch;
              } else {
                const repoMatch = githubRepos.find((r: any) => r.name.toLowerCase() === choice.trim().toLowerCase());
                if (repoMatch) {
                  selectedProject = repoMatch.name;
                  selectedRepoUrl = repoMatch.clone_url.replace('https://', `https://${config.GITHUB_TOKEN}@`);
                }
              }
            }

            if (selectedProject) {
              const projectPath = path.join(wsRoot, selectedProject);
              if (!fs.existsSync(projectPath)) {
                fs.mkdirSync(projectPath, { recursive: true });
                process.chdir(projectPath);
                if (selectedRepoUrl) {
                  await initGit();
                  await setRemote(selectedRepoUrl);
                  logger.info(`Initialized new project from GitHub: ${selectedProject}`);
                }
              } else {
                process.chdir(projectPath);
                logger.success(`Switched to project: ${selectedProject}`);
              }
              
              const shadowUrl = await getRemoteUrl();
              const branch = await getCurrentBranch();
              const newStatus = getWorkspaceStatus();
              projectName = newStatus.projectName || selectedProject;
              await printBanner(projectName, branch || 'main', currentMode, shadowUrl, shellState.trackedSessionId, shellState.trackedSessionUrl);
            } else {
              logger.error('Invalid selection.');
            }
          } catch (err: any) {
            logger.error(`Failed to handle /repo: ${err.message}`);
          }
          break;
        case '/sync':
          try {
            if (!(rl as any).closed) rl.pause();
            const fetchSpinner = ora({ text: chalk.dim('Fetching latest from Jules...'), color: 'magenta' }).start();
            try {
              const branch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
              execSync(`git fetch origin ${branch}`, { stdio: 'ignore' });
            } catch (e) {}
            fetchSpinner.stop();

            let sessionIdToTrack = shellState.trackedSessionId;
            if (!sessionIdToTrack && fs.existsSync(SYNC_STATE_FILE)) {
              try {
                const state = JSON.parse(fs.readFileSync(SYNC_STATE_FILE, 'utf8'));
                sessionIdToTrack = state.sessionId;
              } catch (e) {}
            }

            if (sessionIdToTrack) {
              await trackJulesSession(sessionIdToTrack, undefined, true);
            } else {
              await handleSync();
            }
          } finally {
            if (!(rl as any).closed) rl.resume();
            if (shellState.keypressHandler) {
              process.stdin.removeListener('keypress', shellState.keypressHandler);
              process.stdin.prependListener('keypress', shellState.keypressHandler);
            }
            process.stdout.write('\u001b[?2004h');
          }
          break;
        case '/edit':
          if (args.length === 0) {
            logger.error('Usage: /edit [instruction]');
          } else {
            try {
              if (!(rl as any).closed) rl.pause();
              await handleEdit(args.join(' '));
            } finally {
              if (!(rl as any).closed) rl.resume();
            }
          }
          break;
        case '/restore':
          try {
            if (!(rl as any).closed) rl.pause();
            await handleRestore();
          } finally {
            if (!(rl as any).closed) rl.resume();
          }
          break;
        case '/session':
          try {
            if (!(rl as any).closed) rl.pause();
            await handleSessionCommand(args);
          } finally {
            if (!(rl as any).closed) rl.resume();
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
            if (!(rl as any).closed) rl.pause();
            await handleUsageCommand();
          } finally {
            if (!(rl as any).closed) rl.resume();
          }
          break;

        case '/deleteworkspace':
        case '/DeleteWorkspace':
        case '/deleteworkspace:':
        case '/deleleteworkspace':
        case '/Deleleteworkspace':
          try {
            const wsRoot = getWorkspaceRoot();
            logger.info(`Deleting workspace: ${wsRoot}...`);
            
            // Change directory out of the workspace before deleting it to avoid process.cwd() ENOENT errors
            const parentDir = path.dirname(wsRoot);
            try {
              process.chdir(fs.existsSync(parentDir) ? parentDir : require('os').homedir());
            } catch (e) {}
            
            // Delete workspace
            if (fs.existsSync(wsRoot)) {
              fs.rmSync(wsRoot, { recursive: true, force: true });
            }
            
            logger.success('Workspace deleted. Restarting Jules CLI...');

            // Restart
            shellState.isRestarting = true;
            if (process.stdin.isTTY) {
              try { process.stdin.setRawMode(false); } catch (e) {}
            }
            rl.close(); // Stop listening to stdin so the child can have it
            const { spawn } = require('child_process');
            const child = spawn(process.argv[0], process.argv.slice(1), {
              stdio: 'inherit',
              cwd: process.cwd()
            });
            child.on('exit', (code: number | null) => {
              process.exit(code || 0);
            });
          } catch (err: any) {
            logger.error(`Failed to delete workspace: ${err.message}`);
          }
          return;

        case '/help':
          console.log('');
          console.log(chalk.bold.white('  Commands:'));
          const cmd = (c: string, desc: string) => {
            console.log(`    ${chalk.bold.cyan(c.padEnd(28))} ${chalk.dim(desc)}`);
          };

          cmd('/init',                   'Initialize git & link shadow repo');
          cmd('/newrepo',                'Create new empty private GitHub repo');
          cmd('/repo',                   'Create GitHub repo or switch projects');
          cmd('/sync',                   'Push local changes to GitHub');
          cmd('/edit [prompt]',          'Ask Jules AI to edit your code');
          cmd('/restore',                'Restore files from .bak backups');
          cmd('/session [ls|rm|track]',  'List, delete or track sessions');
          cmd('/usage',                  "Today's stats & all-time summary");
          cmd('/plan',                   'Switch to manual plan mode');
          cmd('/fast',                   'Switch to auto plan mode (default)');
          cmd('/docs',                   'Full documentation');
          cmd('/shot',                   'Show keyboard shortcuts manual');
          cmd('/deleteworkspace',        'Delete workspace and restart');
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
      process.stdin.removeListener('keypress', shellState.keypressHandler);
      process.stdin.prependListener('keypress', shellState.keypressHandler);
    }
    process.stdout.write('\u001b[?2004h');
    showPrompt();
    } finally {
      shellState.isTaskActive = false;
    }
  };

  function redrawUI() {
    if (shellState.isTaskActive) {
      return;
    }
    activeBottomLines = 0; // Reset before drawing
    if (shellState.activeRl && !(shellState.activeRl as any).closed) {
      shellState.activeRl.prompt(true);
    }
    drawBottomArea(activeMatches);
  }

  let resizeTimer: NodeJS.Timeout | null = null;
  const resizeHandler = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      // Don't redraw if the terminal has 0 columns or rows (e.g. minimized)
      const cols = process.stdout.columns;
      const rows = process.stdout.rows;
      if (cols === 0 || rows === 0) {
        resizeTimer = null;
        return;
      }
      activeBottomLines = 0; // Force reset because terminal viewport has reflowed
      redrawUI();
      resizeTimer = null;
    }, 150);
  };
  process.on('SIGWINCH', resizeHandler);

  rl.on('line', shellState.shellLineHandler);

  rl.on('close', () => {
    process.off('SIGWINCH', resizeHandler);
    disableShellBracketedPaste();
    process.off('exit', disableShellBracketedPaste);
    if (shellState.keypressHandler) {
      process.stdin.removeListener('keypress', shellState.keypressHandler);
    }
    shellState.showPrompt = null;
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch (e) {}
    }
    clearBottomArea();
    
    if (!shellState.isRestarting) {
      console.log(chalk.yellow('\nGoodbye!'));
      process.exit(0);
    }
  });
}

program
  .name('jules-local')
  .description('Bridge between local files and Google Jules API')
  .version('2.0');

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
  // 1. Load .env
  dotenv.config();

  // 2. Auto-append missing fields if needed
  ensureEnvFields();

  // 3. Validate all required vars
  validateEnv();

  // 4. Clear session vars for fresh start
  shellState.trackedSessionId = null;
  shellState.trackedSessionUrl = null;

  if (process.argv.length <= 2) {
    startShell().catch(error => {
      logger.error(`Shell failed: ${error.message}`);
      process.exit(1);
    });
  } else {
    program.parse(process.argv);
  }
}
