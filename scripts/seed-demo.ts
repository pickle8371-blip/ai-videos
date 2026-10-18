/** Creates the demonstration project in the data directory (npm run demo:seed). */
import { createContext } from '../server/app.js';
import { createDemoProject } from '../server/demo.js';

const ctx = await createContext();
const p = await createDemoProject(ctx);
console.log(`Created demo project "${p.name}" (${p.id}) in ${ctx.config.dataDir}`);
process.exit(0);
