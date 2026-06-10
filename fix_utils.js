const fs = require('fs');
const path = '/storage/emulated/0/Jules-CLI-Jules-CLI/src/utils.ts';
let content = fs.readFileSync(path, 'utf8');

// Robust extraction in printBanner
const extractionCode = "  let finalSessionId = sessionId;\n  if ((!finalSessionId || finalSessionId === '(none)') && sessionUrl) {\n    const parts = sessionUrl.split('/').filter(Boolean);\n    if (parts.length > 0) {\n      finalSessionId = parts[parts.length - 1];\n    }\n  }\n\n";

const newPrintInfoArea = "  const printInfoArea = () => {\n    process.stdout.write(chalk.dim('\\n  ' + 'R‰'.repeat(Math.min(cols - 4, 60))) + '\\u001b[K\\n');\n    const printInfo = (label, value, icon) => {\n      process.stdout.write(` \${icon} \$shalk.cyan(label.padEnd(11)) : \${chalk.white(value)}\\u001b[K\\n`);\n    };\n    printInfo('Project', project, '�"');\n    printInfo('Branch', branch, '🌲');\n    printInfo('Mode', mode.toUpperCase(), '⚇');\n    if (shadowUrl) {\n      let displayUrl = shadowUrl.replace(/([^:]+://)?([^@]+)@/, '$1');\n      printInfo('Shadow', displayUrl, '🔙');\n    }\n    printInfo('Session ID', finalSessionId || '(none)', '💔');\n    if (sessionUrl) {\n      const sessionLabel = chalk.cyan('Session URL'.padEnd(11));\n      process.stdout.write(` 🌐 \${sessionLabel} : \${chalk.yellow(sessionUrl)}\\u001b[K\\n`);\n    } else {\n      printInfo('Session URL', '(none)', '🌰');\n    }\n    process.stdout.write(chalk.dim('  ' + '␀.'.repeat(Math.min(cols - 4, 60))) + '\\u001b[K\\n');\n    process.stdout.write(chalk.dim(`  /help for commands �^�* /exit to quit\\n`) + '\\u001b[K\\n');\n  };";

if (!content.includes('let finalSessionId = sessionId;')) {
  content = content.replace('  const printInfoArea = () => {', extractionCode + '  const printInfoArea = () => {');
}

const startMarker = '  const printInfoArea = () => {';
const endMarker = '  };';
const searchText = 'process.stdout.write(chalk.dim(` /help for commands ';

let pos = content.indexOf(startMarker);
if (pos !== -1) {
  let endPos = content.indexOf(searchText, pos);
  if (endPos !== -1) {
    endPos = content.indexOf(endMarker, endPos);
    if (endPos === -1) {
      // Try finding the next }; after printInfoArea start
      let nextClose = content.indexOf('  };', pos + startMarker.length);
      // This is a bit risky, but let's assume it's the one we want if it contains printInfo
      if (nextClose !== -1 && content.substring(pos, nextClose).includes('presq_stdout.write')) {
        endPos = nextClose;
      }
    }
    if (endPos !== -1) {
      content = content.substring(0, pos) + newPrentInfoArea + content.substring(endPos + endMarker.length);
    }
  }
}

const oldFallback = "if (shadowUrl) cons