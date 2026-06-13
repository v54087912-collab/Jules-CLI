import simpleGit, { SimpleGit } from 'simple-git';
import { logger } from './utils';
import fs from 'fs';
import path from 'path';
import cliProgress from 'cli-progress';
import chalk from 'chalk';

const git: SimpleGit = simpleGit({
  binary: fs.existsSync('/data/data/com.termux/files/usr/bin/git') 
    ? '/data/data/com.termux/files/usr/bin/git' 
    : 'git'
});

export async function isGitRepo(): Promise<boolean> {
  try {
    let curr = path.resolve(process.cwd());
    while (curr !== path.parse(curr).root) {
      if (fs.existsSync(path.join(curr, '.git'))) {
        return true;
      }
      const parent = path.dirname(curr);
      if (parent === curr || path.basename(curr) === 'Jules-Workspace') {
        break;
      }
      curr = parent;
    }
    return false;
  } catch (e) {
    return false;
  }
}

export async function initGit(): Promise<void> {
  if (!(await isGitRepo())) {
    logger.info('Initializing git repository...');
    await git.cwd(process.cwd()).init();
  }
}

export async function getRemoteUrl(): Promise<string | null> {
  try {
    if (!(await isGitRepo())) {
      return null;
    }
    const remotes = await git.cwd(process.cwd()).getRemotes(true);
    const origin = remotes.find(r => r.name === 'origin');
    return origin ? origin.refs.push : null;
  } catch (e) {
    return null;
  }
}

export async function syncLocalChanges(): Promise<void> {
  const syncBar = new cliProgress.SingleBar({
    format: chalk.bold.cyan('⌁ [Syncing] [') + chalk.white('{bar}') + chalk.bold.cyan('] {percentage}%'),
    barCompleteChar: '█',
    barIncompleteChar: ' ',
    hideCursor: true
  });
  
  const localGit = git.cwd(process.cwd());

  // Setup identity
  const name = process.env.GITHUB_USER;
  const email = process.env.GITHUB_EMAIL;
  if (!name || !email) {
    throw new Error('GITHUB_USER or GITHUB_EMAIL missing in .env');
  }
  try {
    await localGit.addConfig('user.name', name);
    await localGit.addConfig('user.email', email);
  } catch (e) {}

  // Setup auth remote — use the project's existing remote if set,
  // otherwise fall back to SHADOW_REPO env for legacy support.
  const token = process.env.GITHUB_TOKEN;
  const user = process.env.GITHUB_USER;
  if (!token || !user) {
    throw new Error('GITHUB_TOKEN or GITHUB_USER missing in .env');
  }

  const existingRemotes = await localGit.getRemotes(true);
  const existingOrigin = existingRemotes.find(r => r.name === 'origin');

  let url: string;
  if (existingOrigin && existingOrigin.refs.push) {
    // Use the current project's already-configured remote, just ensure token is injected
    const cleanUrl = existingOrigin.refs.push.replace(/https:\/\/[^@]+@/, 'https://');
    url = cleanUrl.replace('https://', `https://${token}@`);
    await localGit.remote(['set-url', 'origin', url]);
  } else {
    // No remote yet — fall back to SHADOW_REPO env
    const repo = process.env.SHADOW_REPO || 'jules-shadow-default-project';
    url = `https://${token}@github.com/${user}/${repo}.git`;
    await localGit.addRemote('origin', url);
  }

  syncBar.start(4, 0, { task: 'Scanning and staging local changes...' });
  await localGit.add('.');
  syncBar.update(1, { task: 'Checking git status...' });
  
  const status = await localGit.status();
  if (status.staged.length > 0) {
    syncBar.update(2, { task: 'Committing staged changes...' });
    await localGit.commit('Jules sync: ' + new Date().toISOString());
    
    const branch = (await localGit.branch()).current;
    syncBar.update(3, { task: `Pushing changes to remote branch: ${branch}...` });
    await localGit.push('origin', branch, ['--set-upstream', '--force']);
    
    syncBar.update(4, { task: 'Push complete!' });
    syncBar.stop();
    console.log(chalk.hex('#2ecc71')('✔ Synced successfully.'));
  } else {
    syncBar.update(4, { task: 'No changes to sync.' });
    syncBar.stop();
  }
}

export async function setRemote(url: string): Promise<void> {
  const localGit = git.cwd(process.cwd());
  const remotes = await localGit.getRemotes();
  if (remotes.find(r => r.name === 'origin')) {
    await localGit.remote(['set-url', 'origin', url]);
  } else {
    await localGit.addRemote('origin', url);
  }
}

export async function getCurrentBranch(): Promise<string> {
  try {
    const branch = await git.cwd(process.cwd()).revparse(['--abbrev-ref', 'HEAD']);
    return branch.trim() || 'main';
  } catch (e) {
    return 'main';
  }
}

export async function syncBranchAndPull(headBranch?: string): Promise<void> {
  if (!(await isGitRepo())) return;

  const localGit = git.cwd(process.cwd());
  try {
    const targetBranch = headBranch || (await localGit.branch()).current;
    logger.info(`Syncing local workspace with remote branch: ${targetBranch}...`);

    // Fetch
    await localGit.fetch('origin', targetBranch);

    // Checkout if needed
    const current = (await localGit.branch()).current;
    if (headBranch && current !== headBranch) {
      await localGit.checkout(headBranch);
      logger.success(`Checked out branch: ${headBranch}`);
    }

    // Pull
    await localGit.pull('origin', targetBranch, ['--rebase']);
    logger.success('Local workspace successfully synced with remote.');
  } catch (error: any) {
    logger.warn(`Failed to sync workspace: ${error.message}`);
  }
}
