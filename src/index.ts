/**
 * NeoClaw — a super AI assistant
 *
 * Entry point. Dispatches to sub-commands:
 *
 *   bun start           Start the daemon (default)
 *   bun onboard         Generate config template at ~/.neoclaw/config.json
 */

import { loadConfig } from './config.js';
import { NeoClawDaemon } from './daemon.js';
import { runOnboard } from './onboard.js';

const command = process.argv[2] ?? 'start';

switch (command) {
  case 'onboard': {
    await runOnboard();
    break;
  }

  case 'start':
  default: {
    const config = loadConfig();
    const daemon = new NeoClawDaemon(config);
    await daemon.run();
    break;
  }
}
