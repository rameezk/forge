import { join } from 'node:path';
import { Store } from '@forge/shared';

export const main = (env: NodeJS.ProcessEnv): void => {
  const stateDir = env.FORGE_STATE_DIR;
  if (stateDir === undefined) {
    throw new Error('FORGE_STATE_DIR is not set');
  }
  Store.open(join(stateDir, 'forge.db')).close();
};

if (import.meta.filename === process.argv[1]) {
  try {
    main(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
