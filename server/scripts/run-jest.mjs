// Cross-platform Jest launcher: works with npm workspaces (jest hoisted to the
// repository root) and on Windows (no inline env-var syntax needed).
import { createRequire } from 'module';
import { spawn } from 'child_process';

const require = createRequire(import.meta.url);
import { dirname, join } from 'path';
const jestBin = join(dirname(require.resolve('jest/package.json')), 'bin', 'jest.js');

const child = spawn(process.execPath, ['--experimental-vm-modules', jestBin, '--runInBand', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'test' },
});
child.on('exit', (code) => process.exit(code ?? 1));
