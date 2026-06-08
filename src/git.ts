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
  const branch = await git.cwd(process.cwd()).branch();
  return branch.current;
}
