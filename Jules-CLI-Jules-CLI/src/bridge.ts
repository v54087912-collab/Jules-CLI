import fs from 'fs';
import path from 'path';
import { logger } from './utils';
import { syncLocalChanges } from './git';

const MAPPINGS_FILE = path.join(process.cwd(), 'external_mappings.json');
const EXTERNAL_DIR = path.join(process.cwd(), 'external');

interface Mappings {
  [repoRelativePath: string]: string; // maps workspace-relative path to absolute local path
}

function loadMappings(): Mappings {
  if (fs.existsSync(MAPPINGS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(MAPPINGS_FILE, 'utf8'));
    } catch (e) {
      return {};
    }
  }
  return {};
}

function saveMappings(mappings: Mappings) {
  fs.writeFileSync(MAPPINGS_FILE, JSON.stringify(mappings, null, 2));
}

// Ensure external_mappings.json is ignored
function ensureGitignore() {
  const gitignore = path.join(process.cwd(), '.gitignore');
  if (fs.existsSync(gitignore)) {
    try {
      const content = fs.readFileSync(gitignore, 'utf8');
      if (!content.includes('external_mappings.json')) {
        fs.appendFileSync(gitignore, '\n# Jules local path bridging\nexternal_mappings.json\n');
      }
    } catch (err) {}
  }
}

// Recursively copy files and return list of mappings
function copyRecursive(src: string, dest: string, mappings: Mappings, relativeDestPath: string) {
  const stats = fs.statSync(src);
  if (stats.isDirectory()) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    const files = fs.readdirSync(src);
    for (const file of files) {
      copyRecursive(
        path.join(src, file),
        path.join(dest, file),
        mappings,
        path.join(relativeDestPath, file)
      );
    }
  } else {
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.copyFileSync(src, dest);
    mappings[relativeDestPath] = src;
  }
}

/**
 * Scan a text prompt for absolute paths.
 * If found, copy them to workspace `external/` folder, register them in mappings,
 * and return the rewritten text prompt.
 */
export function bridgePathsInText(text: string): string {
  // Regex to find absolute paths like /storage/emulated/0/... or /home/... or /data/...
  const pathRegex = /(\/(?:storage|data|home|sdcard|etc|var|usr|bin|lib)[a-zA-Z0-9_\-\s\.\/]+)/g;
  
  let rewrittenText = text;
  const matches = text.match(pathRegex);
  
  if (!matches) return text;
  
  ensureGitignore();
  const mappings = loadMappings();
  let changed = false;

  for (const rawPath of matches) {
    const cleanPath = rawPath.trim();
    if (fs.existsSync(cleanPath)) {
      const isAbsolute = path.isAbsolute(cleanPath);
      if (!isAbsolute) continue;
      
      // Ignore paths that are already inside the workspace
      if (cleanPath.startsWith(process.cwd())) continue;

      logger.info(`Auto-bridging external path: ${cleanPath}`);
      
      // Create a safe directory name under external/
      const safeName = cleanPath
        .replace(/^\//, '')
        .replace(/[\/\s\.-]+/g, '_');
      
      const targetDest = path.join(EXTERNAL_DIR, safeName);
      const relativeDestPath = path.join('external', safeName);
      
      try {
        copyRecursive(cleanPath, targetDest, mappings, relativeDestPath);
        
        // Rewrite the path in the text prompt
        rewrittenText = rewrittenText.replace(cleanPath, relativeDestPath);
        changed = true;
      } catch (err: any) {
        logger.warn(`Failed to copy external path ${cleanPath}: ${err.message}`);
      }
    }
  }

  if (changed) {
    saveMappings(mappings);
    logger.success('External files bridged and synced to workspace.');
  }

  return rewrittenText;
}

/**
 * Copy modified files in `external/` back to their original local paths.
 */
export function restoreExternalMappedFiles() {
  const mappings = loadMappings();
  let count = 0;
  
  for (const [repoRelativePath, absoluteLocalPath] of Object.entries(mappings)) {
    const workspacePath = path.join(process.cwd(), repoRelativePath);
    if (fs.existsSync(workspacePath)) {
      try {
        const destDir = path.dirname(absoluteLocalPath);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }
        
        let shouldCopy = true;
        if (fs.existsSync(absoluteLocalPath)) {
          const srcBuf = fs.readFileSync(workspacePath);
          const destBuf = fs.readFileSync(absoluteLocalPath);
          if (srcBuf.equals(destBuf)) {
            shouldCopy = false;
          }
        }
        
        if (shouldCopy) {
          fs.copyFileSync(workspacePath, absoluteLocalPath);
          logger.info(`Restored modified file back to: ${absoluteLocalPath}`);
          count++;
        }
      } catch (err: any) {
        logger.warn(`Failed to copy back ${workspacePath} -> ${absoluteLocalPath}: ${err.message}`);
      }
    }
  }

  if (count > 0) {
    logger.success(`Restored ${count} external files back to their local storage locations.`);
  }
}
