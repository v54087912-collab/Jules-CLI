import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });

import { getSessionStatus, getSessionActivities } from './api';
import { parsePatch, formatPatch } from 'diff';
import chalk from 'chalk';

async function main() {
  const sessionId = '12612224667752336798';
  try {
    const status = await getSessionStatus(sessionId);
    const activities = await getSessionActivities(sessionId);

    console.log('Status state:', status.state);
    console.log('Activities count:', activities.length);

    let outRepo = '';
    let outBranch = '';
    let compareUrl = '';
    let sessionUrl = `https://jules.google.com/sessions/${sessionId}`;
    let suggestedCommitMessage = '';
    
    outRepo = status.outputRepo || status.executionStatus?.outputRepo;
    outBranch = status.outputBranch || status.executionStatus?.outputBranch;
    compareUrl = status.compareUrl || status.executionStatus?.compareUrl;
    if (status.outputs?.[0]?.changeSet?.gitPatch?.suggestedCommitMessage) {
      suggestedCommitMessage = status.outputs[0].changeSet.gitPatch.suggestedCommitMessage;
    }
    
    console.log('outRepo:', outRepo);
    console.log('outBranch:', outBranch);
    console.log('compareUrl:', compareUrl);
    console.log('suggestedCommitMessage from status:', suggestedCommitMessage);

    const finalActivity = activities.find((a: any) => 
      a.artifacts?.some((art: any) => art.changeSet || art.codeChanges)
    );
    console.log('finalActivity found:', !!finalActivity);

    let additions = 0;
    let deletions = 0;
    let changes: any[] = [];

    if (finalActivity) {
      const artifact = finalActivity.artifacts.find((art: any) => art.changeSet || art.codeChanges);
      console.log('artifact found in finalActivity:', !!artifact);
      
      if (artifact.changeSet?.gitPatch?.suggestedCommitMessage) {
        suggestedCommitMessage = artifact.changeSet.gitPatch.suggestedCommitMessage;
        console.log('suggestedCommitMessage from artifact:', suggestedCommitMessage);
      }
      
      if (artifact.codeChanges) {
        changes = artifact.codeChanges.files;
        console.log('artifact is codeChanges, files count:', changes.length);
        for (const file of changes) {
          if (file.diff) {
            const lines = file.diff.split('\n');
            for (const line of lines) {
              if (line.startsWith('+') && !line.startsWith('+++')) additions++;
              else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
            }
          }
        }
      } else if (artifact.changeSet) {
        const gitPatch = artifact.changeSet.gitPatch;
        console.log('artifact is changeSet, gitPatch exists:', !!gitPatch);
        if (gitPatch && gitPatch.unidiffPatch) {
           console.log('unidiffPatch exists, length:', gitPatch.unidiffPatch.length);
           const lines = gitPatch.unidiffPatch.split('\n');
           for (const line of lines) {
             if (line.startsWith('+') && !line.startsWith('+++')) additions++;
             else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
           }
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
    }

    console.log('additions calculated:', additions);
    console.log('deletions calculated:', deletions);

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

    if (additions > 0 || deletions > 0 || suggestedCommitMessage || outBranch) {
      console.log(chalk.bold.green('Ready for review 🎉'));
      console.log(chalk.bold.green(`+${additions}`) + ' ' + chalk.bold.red(`-${deletions}`));
      if (outBranch) {
        console.log(chalk.white(outBranch));
      }
      if (suggestedCommitMessage) {
        console.log(chalk.white(suggestedCommitMessage));
      }
      console.log(divider);
    } else {
      console.log('BANNER CONDITION EVALUATED TO FALSE!');
    }
  } catch (e: any) {
    console.error('Error:', e.message);
  }
}

main();
