import fs from 'fs';
import path from 'path';
import { applyPatch, parsePatch } from 'diff';
import { logger, askUser, shellState } from './utils';
import chalk from 'chalk';
import readline from 'readline';
import { execSync } from 'child_process';

export interface CodeChange {
  path: string;
  diff: string;
}

function applyPatchFuzzy(content: string, patchDiff: string): string | false {
  const patches = parsePatch(patchDiff);
  if (patches.length === 0) return false;

  let fileLines = content.split(/\r?\n/);

  for (const patch of patches) {
    let lineOffset = 0;

    for (const hunk of patch.hunks) {
      const oldStart = hunk.oldStart - 1;
      const expectedOldLines: string[] = [];
      const expectedNewLines: string[] = [];

      for (const line of hunk.lines) {
        const type = line[0];
        const text = line.slice(1);
        if (type === ' ') {
          expectedOldLines.push(text);
          expectedNewLines.push(text);
        } else if (type === '-') {
          expectedOldLines.push(text);
        } else if (type === '+') {
          expectedNewLines.push(text);
        }
      }

      const matchesSequence = (startIdx: number, seq: string[]) => {
        if (startIdx < 0 || startIdx + seq.length > fileLines.length) return false;
        for (let i = 0; i < seq.length; i++) {
          if (fileLines[startIdx + i].trim() !== seq[i].trim()) {
            return false;
          }
        }
        return true;
      };

      let foundIdx = -1;
      let alreadyApplied = false;
      const maxSearch = Math.max(fileLines.length, 100);

      for (let offset = 0; offset < maxSearch; offset++) {
        const idxDown = oldStart + lineOffset + offset;
        if (idxDown >= 0 && idxDown < fileLines.length) {
          if (matchesSequence(idxDown, expectedOldLines)) {
            foundIdx = idxDown;
            break;
          }
          if (matchesSequence(idxDown, expectedNewLines)) {
            foundIdx = idxDown;
            alreadyApplied = true;
            break;
          }
        }
        if (offset > 0) {
          const idxUp = oldStart + lineOffset - offset;
          if (idxUp >= 0 && idxUp < fileLines.length) {
            if (matchesSequence(idxUp, expectedOldLines)) {
              foundIdx = idxUp;
              break;
            }
            if (matchesSequence(idxUp, expectedNewLines)) {
              foundIdx = idxUp;
              alreadyApplied = true;
              break;
            }
          }
        }
      }

      if (foundIdx === -1) {
        return false;
      }

      if (alreadyApplied) {
        lineOffset += expectedNewLines.length - expectedOldLines.length;
        continue;
      }

      const beforeHunk = fileLines.slice(0, foundIdx);
      const afterHunk = fileLines.slice(foundIdx + expectedOldLines.length);
      
      fileLines = [...beforeHunk, ...expectedNewLines, ...afterHunk];
      lineOffset += expectedNewLines.length - expectedOldLines.length;
    }
  }

  return fileLines.join('\n');
}


export async function applyChanges(changes: CodeChange[]): Promise<boolean> {
  // 1. Show Diff Preview
  console.log(chalk.bold.hex('#9d4edd')('\n🔍 Diff Preview of Jules changes:'));
  console.log(chalk.gray('──────────────────────────────────────────────────'));
  
  for (const change of changes) {
    console.log(chalk.bold.hex('#2ec4b6')(`📄 File: ${change.path}`));
    const lines = change.diff.split('\n');
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        console.log(chalk.green(line));
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        console.log(chalk.red(line));
      } else if (line.startsWith('@@')) {
        console.log(chalk.cyan(line));
      } else {
        console.log(chalk.gray(line));
      }
    }
    console.log(chalk.gray('──────────────────────────────────────────────────'));
  }
  
  console.log(chalk.bold.white('Do you want to apply these changes to your local files?'));
  console.log(chalk.white('  1. Yes'));
  console.log(chalk.white('  2. No'));
  
  shellState.diffPending = true;
  const confirm = await askUser(chalk.bold.white('\nOption [1-2]: '));
  shellState.diffPending = false;
  
  if (confirm.trim() !== '1' && confirm.trim().toLowerCase() !== 'y') {
    logger.warn('Changes discarded by user.');
    return false;
  }

  // 2. Apply Changes
  for (const change of changes) {
    const fullPath = path.resolve(process.cwd(), change.path);
    
    try {
      const dirPath = path.dirname(fullPath);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      let currentContent = '';
      if (fs.existsSync(fullPath)) {
        currentContent = fs.readFileSync(fullPath, 'utf8');
        // Create backup
        fs.writeFileSync(`${fullPath}.bak`, currentContent);
        logger.info(`Backup created: ${change.path}.bak`);
      }

      // Handle new file creation if the patch is for a new file
      let patchedContent = applyPatch(currentContent, change.diff);
      
      if (patchedContent === false) {
        // Fallback: Try fuzzy patching (handles CRLF, duplicate lines, or context mismatches)
        patchedContent = applyPatchFuzzy(currentContent, change.diff);
      }
      
      if (patchedContent === false) {
        const patches = parsePatch(change.diff);
        if (patches.length > 0 && patches[0].oldFileName === '/dev/null') {
           let newContent = '';
           patches[0].hunks.forEach(hunk => {
             hunk.lines.forEach(line => {
               if (line.startsWith('+')) {
                 newContent += line.substring(1) + '\n';
               }
             });
           });
           fs.writeFileSync(fullPath, newContent.trimEnd() + '\n');
           logger.success(`Created new file: ${change.path}`);
           continue;
        }

        logger.error(`Failed to apply patch to ${change.path}. Please check manually.`);
        continue;
      }

      fs.writeFileSync(fullPath, patchedContent);
      logger.success(`Applied changes to ${change.path}`);
    } catch (error: any) {
      logger.error(`Error applying changes to ${change.path}: ${error.message}`);
    }
  }

  // 3. Auto-install dependencies
  let packageJsonModified = false;
  let requirementsModified = false;
  for (const change of changes) {
    if (change.path.endsWith('package.json')) {
      packageJsonModified = true;
    } else if (change.path.endsWith('requirements.txt')) {
      requirementsModified = true;
    }
  }
  
  if (packageJsonModified) {
    logger.info('Detected changes to package.json. Running npm install...');
    try {
      const isSharedStorage = process.cwd().startsWith('/storage/emulated') || process.cwd().startsWith('/sdcard');
      const npmCmd = isSharedStorage ? 'npm install --no-bin-links' : 'npm install';
      execSync(npmCmd, { stdio: 'inherit' });
      logger.success('Dependencies installed successfully.');
    } catch (e: any) {
      logger.error(`Failed to install npm dependencies: ${e.message}`);
    }
  }
  
  if (requirementsModified) {
    logger.info('Detected changes to requirements.txt. Running pip install...');
    try {
      execSync('pip install -r requirements.txt', { stdio: 'inherit' });
      logger.success('Python dependencies installed successfully.');
    } catch (e: any) {
      logger.error(`Failed to install python dependencies: ${e.message}`);
    }
  }
  
  return true;
}
