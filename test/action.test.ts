import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { REPO_ROOT } from './helpers.js';

/**
 * The composite action's PR comment is a second, independent rendering of a
 * run's result, written in JavaScript inside action.yml. Nothing else in the
 * suite executes it, and that is exactly how it came to keep asserting
 * SmartContract deployment consequences for a ZkProgram after src/report.ts
 * stopped doing so. These tests run the real script from the real file.
 */

/**
 * Pull the `script: |` block out of action.yml by indentation.
 *
 * Deliberately not a YAML parse: a YAML library is not a dependency of this
 * package, and adding one to read one literal block would ship a dependency to
 * every consumer for the benefit of a test.
 */
function extractScript(): string {
  const lines = readFileSync(join(REPO_ROOT, 'action.yml'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.trim() === 'script: |');
  const header = lines[start];
  if (start === -1 || header === undefined) throw new Error('no `script: |` block in action.yml');

  const indent = header.length - header.trimStart().length;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const blank = line.trim() === '';
    if (!blank && line.length - line.trimStart().length <= indent) break;
    body.push(blank ? '' : line.slice(indent + 2));
  }
  return body.join('\n');
}

type VkChange = { contract: string; kind?: string; before: string; after: string };

/**
 * Run the extracted script the way actions/github-script does — an async
 * function body with `core`, `github` and `context` in scope — and return the
 * comment body it tried to post.
 */
async function render(result: unknown): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'vk-guard-action-'));
  writeFileSync(join(dir, 'vk-guard-result.json'), JSON.stringify(result));

  let posted: string | undefined;
  const core = { warning: () => {}, info: () => {}, setFailed: () => {} };
  const github = {
    paginate: async () => [] as { body?: string }[],
    rest: {
      issues: {
        listComments: {},
        createComment: async ({ body }: { body: string }) => void (posted = body),
        updateComment: async ({ body }: { body: string }) => void (posted = body),
      },
    },
  };
  const context = { repo: { owner: 'o', repo: 'r' }, issue: { number: 1 } };

  const env = {
    ...process.env,
    GITHUB_WORKSPACE: dir,
    VK_GUARD_WORKING_DIRECTORY: '.',
  };
  const fn = new Function(
    'core',
    'github',
    'context',
    'require',
    'process',
    `return (async () => {${extractScript()}})()`
  );
  await fn(core, github, context, createRequire(import.meta.url), { ...process, env });

  if (posted === undefined) throw new Error('the action script posted no comment');
  return posted;
}

function result(vk: VkChange[]) {
  return {
    ok: false,
    summary: '2 contracts, 3 methods, o1js 3.0.0',
    o1js: { snapshot: '3.0.0', current: '3.0.0', changed: false },
    observations: {
      comparedVerificationKeys: 2,
      verificationKeysChanged: vk.length,
      methodDigestsChanged: true,
      causeDetermined: false,
    },
    verificationKeyChanges: vk,
  };
}

const SMART_CONTRACT = /account permissions/;
const ZK_PROGRAM = /no deployed account of its own/;

const counter: VkChange = {
  contract: 'Counter',
  kind: 'SmartContract',
  before: '1'.repeat(40),
  after: '2'.repeat(40),
};
const program: VkChange = {
  contract: 'Prog',
  kind: 'ZkProgram',
  before: '3'.repeat(40),
  after: '4'.repeat(40),
};

describe('the action PR comment', () => {
  it('gives a ZkProgram verifier guidance, not account guidance', async () => {
    const body = await render(result([program]));
    expect(body).toMatch(ZK_PROGRAM);
    expect(body).not.toMatch(SMART_CONTRACT);
    expect(body).not.toMatch(/redeploy/i);
  });

  it('gives a SmartContract account guidance, not ZkProgram guidance', async () => {
    const body = await render(result([counter]));
    expect(body).toMatch(SMART_CONTRACT);
    expect(body).not.toMatch(ZK_PROGRAM);
  });

  it('gives both when both kinds changed, and says which target is which', async () => {
    const body = await render(result([counter, program]));
    expect(body).toMatch(SMART_CONTRACT);
    expect(body).toMatch(ZK_PROGRAM);
    expect(body).toMatch(/\|\s*`Counter`\s*\|\s*SmartContract\s*\|/);
    expect(body).toMatch(/\|\s*`Prog`\s*\|\s*ZkProgram\s*\|/);
  });

  it('falls back to account guidance when a result carries no kind', async () => {
    // Results written by vk-guard 0.2.0 and earlier have no `kind`. Dropping the
    // consequence text entirely would be worse than the assumption.
    const { kind, ...noKind } = counter;
    void kind;
    const body = await render(result([noKind]));
    expect(body).toMatch(SMART_CONTRACT);
    expect(body).not.toMatch(ZK_PROGRAM);
    expect(body).toMatch(/\|\s*`Counter`\s*\|\s*unknown\s*\|/);
  });

  it('makes no causal claim and no claim about chain state', async () => {
    for (const vk of [[counter], [program], [counter, program]]) {
      const body = await render(result(vk));
      expect(body).toContain('This comparison does not determine the cause.');
      expect(body).toContain('does not change any key on-chain');
      expect(body).not.toMatch(/caused|because of|explains/i);
      expect(body).not.toMatch(/all deployed|every deployed|must be redeployed/i);
    }
  });

  // The paths that end a run before there is a comparison — nothing discovered,
  // no baseline, a full check against a rows-only baseline — now emit JSON like
  // every other --json result, so the comment can report them instead of the
  // script bailing out on an unparseable file and leaving a failed job silent.
  it('reports a run that could not complete, rather than an empty result', async () => {
    const body = await render({
      ok: false,
      reason: 'no-contracts',
      error: 'no contracts found; check --entry\n\nSearched 3 file(s) matching: src/**/*.ts',
      summary: '0 contracts, 0 methods, o1js 3.0.0',
    });
    expect(body).toContain('could not complete the check');
    expect(body).toContain('no contracts found; check --entry');
    // No verification key table, and none of the deployment consequence text:
    // nothing was compared, so there is nothing to say about a key.
    expect(body).not.toMatch(SMART_CONTRACT);
    expect(body).not.toMatch(ZK_PROGRAM);
  });

  it('reports the o1js version as a fact on either side of a change', async () => {
    const unchanged = await render(result([counter]));
    expect(unchanged).toContain('o1js version unchanged (3.0.0)');

    const changed = await render({
      ...result([counter]),
      o1js: { snapshot: '2.3.0', current: '3.0.0', changed: true },
    });
    expect(changed).toContain('o1js version changed: 2.3.0 → 3.0.0');
    expect(changed).not.toMatch(/caused|explains/i);
  });
});
