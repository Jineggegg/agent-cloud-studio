// Entry point of the order broker program: /opt/studio-trader/bin/node /opt/studio-trader/app/main.js <command>.
// See docs/t212-broker.md; scripts/wsl/install-t212-broker.sh installs it.
import { runBrokerCommand } from './index.js';

process.exitCode = await runBrokerCommand(process.argv.slice(2));
