#!/usr/bin/env node
import { runClient } from './client.js';
import { runServer } from './server.js';

try {
  if (process.env.ASK_AGENT_ACTIVE === '1') {
    console.error('ask is already active in this command. Nested invocation blocked. The outer ask manages the daemon.');
    process.exitCode = 125;
  } else if (process.argv[2] === '__serve') await runServer();
  else process.exitCode = await runClient(process.argv.slice(2));
} catch (error) {
  console.error(`ask error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
