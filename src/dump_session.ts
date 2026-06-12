import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
dotenv.config({ path: path.join(__dirname, '../.env') });

import { getSessionStatus, getSessionActivities } from './api';

async function main() {
  const sessionId = '12612224667752336798';
  try {
    const status = await getSessionStatus(sessionId);
    const activities = await getSessionActivities(sessionId);

    // Save full JSON responses to inspect
    fs.writeFileSync(
      path.join(__dirname, '../session_status.json'),
      JSON.stringify(status, null, 2)
    );
    fs.writeFileSync(
      path.join(__dirname, '../session_activities.json'),
      JSON.stringify(activities, null, 2)
    );

    console.log('Keys of status:', Object.keys(status));
    if (status.outputs) {
      console.log('status.outputs structure:', JSON.stringify(status.outputs, null, 2));
    }
    console.log('Dumped successfully.');
  } catch (e: any) {
    console.error('Error:', e.message);
  }
}

main();
