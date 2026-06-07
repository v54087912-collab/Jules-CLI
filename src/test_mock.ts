import * as api from './api';
import { trackJulesSession } from './index';

// We will mock the state transitions using a simple counter/state variable
let step = 0;
let statusCallCount = 0;

(api as any).getSessionStatus = async (sessionId: string) => {
  statusCallCount++;
  console.log(`\n[MOCK API] getSessionStatus called (count=${statusCallCount}), step=${step}`);
  
  if (step === 0 && statusCallCount > 1) {
    step = 1; // Auto-transition from PLANNING to AWAITING_PLAN_APPROVAL
  }
  
  if (step === 0) {
    return { state: 'PLANNING', description: 'Generating plan...' };
  } else if (step === 1) {
    return { state: 'AWAITING_PLAN_APPROVAL', description: 'Awaiting plan approval...' };
  } else if (step === 2) {
    return { state: 'IN_PROGRESS', description: 'Working on media gallery PWA...' };
  } else if (step === 3) {
    return { state: 'INACTIVE', description: 'Paused for feedback' };
  } else {
    return { state: 'COMPLETED', description: 'Task completed successfully' };
  }
};

(api as any).getSessionActivities = async (sessionId: string) => {
  console.log(`[MOCK API] getSessionActivities called, step=${step}`);
  if (step === 0) {
    return [];
  } else if (step === 1) {
    return [
      {
        name: 'plan_activity',
        planGenerated: {
          plan: {
            steps: [
              { title: 'Configure Android Permissions', description: 'Update AndroidManifest.xml to include READ_EXTERNAL_STORAGE' },
              { title: 'Create PWA Files (www folder)', description: 'Setup index.html and manifest.json' }
            ]
          }
        }
      }
    ];
  } else if (step === 2) {
    return [
      {
        name: 'plan_activity',
        planGenerated: {
          plan: {
            steps: [
              { title: 'Configure Android Permissions', description: 'Update AndroidManifest.xml to include READ_EXTERNAL_STORAGE' },
              { title: 'Create PWA Files (www folder)', description: 'Setup index.html and manifest.json' }
            ]
          }
        }
      },
      {
        id: 'msg_activity_1',
        name: 'msg_activity_1',
        agentMessaged: {
          agentMessage: "Hi! Jules here. I've finished the permissions setup. Do you have any advice?"
        }
      }
    ];
  } else if (step === 3) {
    return [
      {
        name: 'plan_activity',
        planGenerated: {
          plan: {
            steps: [
              { title: 'Configure Android Permissions', description: 'Update AndroidManifest.xml to include READ_EXTERNAL_STORAGE' },
              { title: 'Create PWA Files (www folder)', description: 'Setup index.html and manifest.json' }
            ]
          }
        }
      },
      {
        id: 'msg_activity_1',
        name: 'msg_activity_1',
        agentMessaged: {
          agentMessage: "Hi! Jules here. I've finished the permissions setup. Do you have any advice?"
        }
      }
    ];
  } else {
    // completed
    return [
      {
        name: 'plan_activity',
        planGenerated: {
          plan: {
            steps: [
              { title: 'Configure Android Permissions', description: 'Update AndroidManifest.xml to include READ_EXTERNAL_STORAGE' },
              { title: 'Create PWA Files (www folder)', description: 'Setup index.html and manifest.json' }
            ]
          }
        }
      },
      {
        id: 'msg_activity_1',
        name: 'msg_activity_1',
        agentMessaged: {
          agentMessage: "Hi! Jules here. I've finished the permissions setup. Do you have any advice?"
        }
      },
      {
        name: 'complete_activity',
        artifacts: [
          {
            codeChanges: {
              files: []
            }
          }
        ]
      }
    ];
  }
};

(api as any).sendJulesMessage = async (sessionId: string, prompt: string) => {
  console.log(`[MOCK API] sendJulesMessage called with: "${prompt}"`);
  step++;
  return {};
};

(api as any).approveJulesPlan = async (sessionId: string) => {
  console.log(`[MOCK API] approveJulesPlan called`);
  step++;
  return {};
};

(api as any).deleteJulesSession = async (sessionId: string) => {
  console.log(`[MOCK API] deleteJulesSession called`);
  return {};
};

async function runTest() {
  console.log('Starting mock session polling test...');
  try {
    // Start tracking the mock session
    await trackJulesSession('mock-session-123');
    console.log('\nMock session polling test completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
}

runTest();
