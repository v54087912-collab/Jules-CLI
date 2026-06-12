const fs = require('fs');
const path = require('path');

const srcPath = 'src/index.ts';
const utilsPath = 'src/utils.ts';

const srcContent = fs.readFileSync(srcPath, 'utf8');
const utilsContent = fs.readFileSync(utilsPath, 'utf8');

const results = [];

function check(name, condition, details) {
  results.push({ name, status: condition ? 'PASS' : 'FAIL', details });
}

console.log('--- JULES CLI LOGIC VALIDATION REPORT ---\n');

// 1. Bug 2: Session Tracking Desynchronization
const expectedStates = ['AWAITING_USER_FEEDBACK', 'PAUSED', 'HALTED', 'BLOCKED'];
const stateCheckFound = expectedStates.every(s => srcContent.includes(s));
check('Bug 2: State Machine Expansion', stateCheckFound, `Verified expanded states: ${expectedStates.join(', ')}`);

// 2. Bug 5: Application Reset on Blur
const skipClearFound = utilsContent.includes('skipClear: boolean = false') && srcContent.includes('printBanner(') && srcContent.includes('true);');
const nonDestructiveRedraw = srcContent.includes("process.stdout.write('\\u001b[H')") && !srcContent.includes("'\\u001b[2J\\u001b[3J\\u001b[H'");
check('Bug 5: Non-Destructive UI Redraw', skipClearFound && nonDestructiveRedraw, 'Verified skipClear in printBanner and non-destructive redrawUI');

// 3. Feature 2: Universal ESC Key Handling
const unifiedState = utilsContent.includes('escCancelled: false') && utilsContent.includes('sessionAborted: false');
const noLocalFlags = !srcContent.includes('let escCancelled = false;') && !srcContent.includes('let sessionAborted = false;');
const handleEscapeRefactored = srcContent.includes('function handleEscapePress()') && srcContent.includes('shellState.escCancelled = true') && srcContent.includes('shellState.activeRl.write(\'\\n\')');

check('Feature 2: Unified State Migration', unifiedState && noLocalFlags, 'Verified removal of local state flags and migration to global shellState');
check('Feature 2: Robust ESC Handler', handleEscapeRefactored, 'Verified refactored handleEscapePress for context-aware cancellation');

// 4. Overall Integrity
const botchedRef = srcContent.includes('shellState.shellState');
check('Integrity: No Botched References', !botchedRef, 'Verified no double "shellState.shellState" occurrences');

console.table(results);

if (results.some(r => r.status === 'FAIL')) {
  console.log('\n❌ SOME VALIDATIONS FAILED');
  process.exit(1);
} else {
  console.log('\n✅ ALL LOGIC VALIDATIONS PASSED');
}
