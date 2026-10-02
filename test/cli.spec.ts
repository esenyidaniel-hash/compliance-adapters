/// <reference types="jest" />

/**
 * End-to-end tests for the shipped CLI wrapper, `bin/compliance-adapters.js`
 * (issue #345).
 *
 * These spawn the actual bin script as a child process — the way an end user
 * runs it via `npx compliance-adapters` — instead of calling sanctions-oracle's
 * `parseArgs` / `runCli` directly. That exercises the wrapper's own logic
 * (top-level command dispatch, `--help` handling at the top level vs. the
 * command level, and the `process.argv` splicing that forwards the remaining
 * args to the sync script), which unit tests of sanctions-oracle can't cover.
 */

import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CLI = path.resolve(__dirname, '..', 'bin', 'compliance-adapters.js');
const FIXTURE_ADDRESSES = path.resolve(
  __dirname,
  '..',
  'sanctions-oracle',
  'test',
  'fixtures',
  'addresses.json',
);

function run(args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function runWithError(args: string[]): { stdout: string; stderr: string; code: number | null } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout: string; stderr: string; status: number | null };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status };
  }
}

/**
 * Spawn `listen`, wait for the startup banner, send `signal`, and collect
 * output until the process exits.
 */
function runListenAndSignal(
  args: string[],
  signal: NodeJS.Signals,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'listen', ...args]);
    let stdout = '';
    let stderr = '';
    let signalled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`listen did not exit in time. stdout: ${stdout}\nstderr: ${stderr}`));
    }, 12_000);
    child.stdout.on('data', (d) => {
      stdout += d;
      if (!signalled && stdout.includes('Press Ctrl+C')) {
        signalled = true;
        child.kill(signal);
      }
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

/** Extract the trailing machine-readable JSON block that runCli prints last. */
function parseTrailingJson(output: string): Record<string, unknown> {
  // JSON.stringify(result, null, 2) starts with `{\n  "` — the pretty-printed
  // log lines above it use util.inspect formatting (`{ checked: 3 }`), so this
  // marker uniquely locates the start of the real JSON.
  const jsonStart = output.indexOf('{\n  "');
  const jsonEnd = output.lastIndexOf('}');
  expect(jsonStart).toBeGreaterThanOrEqual(0);
  return JSON.parse(output.slice(jsonStart, jsonEnd + 1));
}

describe('compliance-adapters CLI wrapper (bin/compliance-adapters.js)', () => {
  describe('top-level argv handling', () => {
    it('prints top-level usage with --help', () => {
      const output = run(['--help']);
      expect(output).toContain('compliance-adapters <command> [options]');
      expect(output).toContain('sync-sanctions');
      // The top-level --help must NOT fall through to the sync command's help.
      expect(output).not.toContain('sanctions-oracle sync');
    });

    it('prints top-level usage with -h', () => {
      const output = run(['-h']);
      expect(output).toContain('compliance-adapters <command> [options]');
    });

    it('prints top-level usage with no arguments', () => {
      const output = run([]);
      expect(output).toContain('compliance-adapters <command> [options]');
    });

    it('exits 0 for the help paths', () => {
      expect(runWithError(['--help']).code).toBe(0);
      expect(runWithError([]).code).toBe(0);
    });

    it('exits with code 1 and an error for an unknown command', () => {
      const { stdout, stderr, code } = runWithError(['definitely-not-a-command']);
      expect(code).toBe(1);
      expect(stderr).toContain('Unknown command');
      // Still shows usage so the user can recover.
      expect(stdout + stderr).toContain('compliance-adapters <command> [options]');
    });
  });

  describe('sync-sanctions command dispatch', () => {
    it('forwards --help to command-level help (not the top-level usage)', () => {
      const output = run(['sync-sanctions', '--help']);
      expect(output).toContain('compliance-adapters sync-sanctions [options]');
      for (const flag of [
        '--addresses',
        '--dry-run',
        '--contract-id',
        '--rpc-url',
        '--network-passphrase',
        '--secret-key',
      ]) {
        expect(output).toContain(flag);
      }
    });

    it('forwards -h to command-level help', () => {
      const output = run(['sync-sanctions', '-h']);
      expect(output).toContain('compliance-adapters sync-sanctions [options]');
    });

    it('runs a dry-run sync, splicing flags through to the sync script', () => {
      const output = run(['sync-sanctions', '--addresses', FIXTURE_ADDRESSES, '--dry-run']);

      const result = parseTrailingJson(output);
      expect(result.dryRun).toBe(true);
      expect(result.checked).toBe(3);
      expect(Array.isArray(result.flagged) && (result.flagged as string[]).length).toBe(2);
      expect(result.written).toEqual([]);
      expect(result.invalid).toEqual([]);
    });

    it('handles flags in any order (--dry-run before --addresses)', () => {
      const output = run(['sync-sanctions', '--dry-run', '--addresses', FIXTURE_ADDRESSES]);
      const result = parseTrailingJson(output);
      expect(result.dryRun).toBe(true);
      expect(result.checked).toBe(3);
    });

    it('reports malformed addresses under `invalid` without failing the run', () => {
      const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-')), 'addrs.json');
      fs.writeFileSync(
        tmp,
        JSON.stringify([
          'GCDVWDVSFNX43HOAIMRLPHJAQMPRRDZGRUE6DM6IFSV35BBNMGEZ662M',
          'not-a-real-address',
        ]),
      );

      const output = run(['sync-sanctions', '--addresses', tmp, '--dry-run']);
      const result = parseTrailingJson(output);
      expect(result.invalid).toEqual(['not-a-real-address']);
      expect(result.checked).toBe(1);
    });

    it('exits with code 1 when --addresses is missing', () => {
      const { stderr, code } = runWithError(['sync-sanctions']);
      expect(code).toBe(1);
      expect(stderr).toContain('--addresses');
    });

    it('exits with code 1 when the addresses file does not exist', () => {
      const { stderr, code } = runWithError([
        'sync-sanctions',
        '--addresses',
        '/no/such/addresses.json',
        '--dry-run',
      ]);
      expect(code).toBe(1);
      expect(stderr).toMatch(/ENOENT|no such file/i);
    });

    it('exits with code 1 for a live sync missing its required flags', () => {
      const { stderr, code } = runWithError(['sync-sanctions', '--addresses', FIXTURE_ADDRESSES]);
      expect(code).toBe(1);
      expect(stderr).toContain('Missing required flags for live sync');
    });
  });

  describe('listen command dispatch', () => {
    const CONTRACT_A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABH4M';
    const CONTRACT_B = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBH4M';
    const OFFLINE_RPC = 'http://127.0.0.1:1';

    it('prints command-level help with --help', () => {
      const output = run(['listen', '--help']);
      expect(output).toContain('compliance-adapters listen [options]');
      for (const flag of [
        '--contract-id',
        '--rpc-url',
        '--webhook-url',
        '--dry-run',
        '--start-ledger',
        '--poll-interval-ms',
        '--max-retries',
      ]) {
        expect(output).toContain(flag);
      }
    });

    it('prints command-level help with -h', () => {
      expect(run(['listen', '-h'])).toContain('compliance-adapters listen [options]');
    });

    it('exits with code 1 when --contract-id is missing', () => {
      const { stderr, code } = runWithError(['listen', '--webhook-url', 'http://localhost:9000']);
      expect(code).toBe(1);
      expect(stderr).toContain('Missing required flag: --contract-id');
    });

    it('exits with code 1 when --webhook-url is missing', () => {
      const { stderr, code } = runWithError(['listen', '--contract-id', CONTRACT_A]);
      expect(code).toBe(1);
      expect(stderr).toContain('Missing required flag: --webhook-url');
    });

    it('collects every repeated --contract-id and shuts down gracefully on SIGINT', async () => {
      const { stdout, code } = await runListenAndSignal(
        [
          '--contract-id',
          CONTRACT_A,
          '--contract-id',
          CONTRACT_B,
          '--webhook-url',
          'http://localhost:9000/events',
          '--rpc-url',
          OFFLINE_RPC,
        ],
        'SIGINT',
      );
      expect(stdout).toContain(`contracts:      ${CONTRACT_A}, ${CONTRACT_B}`);
      expect(stdout).toContain('Received SIGINT');
      expect(code).toBe(0);
    }, 15_000);

    it('shuts down gracefully on SIGTERM', async () => {
      const { stdout, code } = await runListenAndSignal(
        [
          '--contract-id',
          CONTRACT_A,
          '--webhook-url',
          'http://localhost:9000',
          '--rpc-url',
          OFFLINE_RPC,
        ],
        'SIGTERM',
      );
      expect(stdout).toContain('Received SIGTERM');
      expect(code).toBe(0);
    }, 15_000);

    it('--dry-run does not require --webhook-url and does not claim a webhook', async () => {
      const { stdout, code } = await runListenAndSignal(
        ['--contract-id', CONTRACT_A, '--dry-run', '--rpc-url', OFFLINE_RPC],
        'SIGINT',
      );
      expect(stdout).toContain('dry-run: events printed only');
      expect(code).toBe(0);
    }, 15_000);
  });
});
