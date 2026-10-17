import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  sha256,
  Store,
  type DispatchRecord,
  type RunFingerprint,
  type RunRecord,
} from '@forge/shared';
import { createApp, FileTranscriptSource } from '@forge/frontend';
import { main } from '../src/dispatch-main.ts';
import {
  APP_ID,
  fakeGithubApp,
  routedThrough,
  BOT_EMAIL,
  BOT_LOGIN,
  type FakeGithubApp,
  tokenFor,
} from '../../shared/test/fixtures/fake-github-app.ts';
import { NARRATION_INSTRUCTION, UNATTENDED_INSTRUCTION, revisionInstruction } from '../src/harness.ts';
import {
  COVERAGE_PROMPT,
  COVERAGE_SKILL_FILES,
  TRUNCATED_PROMPT,
  TRUNCATED_SKILL_FILES,
  REVIEWING_PROMPT,
  SKILL_FILES,
  SUBAGENTS_PROMPT,
} from './fixtures/fake-provider.ts';
import { CLAUDE_TOKEN } from './fixtures/fake-anthropic.ts';
import {
  billedAt,
  claudeReplay,
  fakeOpenRouter,
  LISTED_MODELS,
  journaled,
  startedDispatch,
  PI_CONTRACT,
  PI_EXTENSIONS,
  lockedPiPackage,
  writeFakeBwrap,
  writeFakeClaude,
  writeFakePi,
  type BwrapCall,
} from './helpers.ts';

const GITHUB_FIXTURES = join(import.meta.dirname, 'fixtures', 'github');

const PI_OUTPUT = join(import.meta.dirname, 'fixtures', 'pi', 'success.jsonl');

const PROVIDER_ERROR = join(import.meta.dirname, 'fixtures', 'pi', 'provider-error.jsonl');

const {
  subagent: EXTENSION,
  modelDefaultReasoning: REASONING_EXTENSION,
  requestRecord: REQUEST_RECORD_EXTENSION,
} = PI_EXTENSIONS;

const WRITE_TOKEN = tokenFor('write', 'rameezk/forge');

const WRITE_TOKEN_AFTER = tokenFor('write', 'rameezk/forge', 2);

const WORKLOAD_TOKEN = tokenFor('workload', 'rameezk/forge');

const TICKET_URL = 'https://github.com/rameezk/forge/issues/113';

const GIT_IDENTITY = { name: BOT_LOGIN, email: BOT_EMAIL };

interface IssueResponse {
  data: {
    repository: {
      issue: { labels: { nodes: { name: string }[] } } | null;
    };
  };
}

const recorded = (name: string): IssueResponse =>
  JSON.parse(
    readFileSync(join(GITHUB_FIXTURES, `${name}.json`), 'utf8'),
  ) as IssueResponse;

const labelled = (response: IssueResponse, label: string): IssueResponse => {
  const copy = structuredClone(response);
  copy.data.repository.issue?.labels.nodes.push({ name: label });
  return copy;
};

const FORGE_READY = 'forge:ready';

interface GraphqlRequest {
  operation: string | undefined;
  authorization: string | null;
  variables: Record<string, unknown>;
}

interface ClosingResponse {
  data: {
    repository: {
      issue: {
        closedByPullRequestsReferences: {
          nodes: {
            number: number;
            url: string;
            state: string;
            isCrossRepository: boolean;
            repository: { nameWithOwner: string };
          }[];
        };
      };
    };
  };
}

const closing = (name: string): ClosingResponse =>
  JSON.parse(
    readFileSync(join(GITHUB_FIXTURES, `${name}.json`), 'utf8'),
  ) as ClosingResponse;

const opened = (
  response: ClosingResponse,
  from: { isCrossRepository?: boolean; repository?: string } = {},
): ClosingResponse => {
  const copy = structuredClone(response);
  for (const node of copy.data.repository.issue.closedByPullRequestsReferences.nodes) {
    node.state = 'OPEN';
    node.isCrossRepository = from.isCrossRepository ?? node.isCrossRepository;
    node.repository.nameWithOwner = from.repository ?? node.repository.nameWithOwner;
  }
  return copy;
};

interface CheckContext {
  __typename: 'CheckRun' | 'StatusContext';
  name?: string;
  status?: string;
  conclusion?: string | null;
  context?: string;
  state?: string;
  isRequired: boolean;
}

interface Readiness {
  isDraft: boolean;
  checks: CheckContext[] | null;
}

const readyPullRequest: Readiness = { isDraft: false, checks: [] };

const checkRun = (
  name: string,
  conclusion: string | null,
  isRequired = true,
): CheckContext => ({
  __typename: 'CheckRun',
  name,
  status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
  conclusion,
  isRequired,
});

const statusContext = (context: string, state: string, isRequired = true): CheckContext => ({
  __typename: 'StatusContext',
  context,
  state,
  isRequired,
});

const readinessResponse = ({ isDraft, checks }: Readiness) => ({
  data: {
    repository: {
      pullRequest: {
        isDraft,
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup:
                  checks === null
                    ? null
                    : { contexts: { pageInfo: { hasNextPage: false }, nodes: checks } },
              },
            },
          ],
        },
      },
    },
  },
});

interface LabelWrite {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
  piStarted: boolean;
}

interface LabelledResponse {
  data: {
    repository: {
      issues: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { number: number; url: string }[];
      };
    };
  };
}

const labelledIssues = (numbers: number[]): LabelledResponse => {
  const response = JSON.parse(
    readFileSync(join(GITHUB_FIXTURES, 'labelled-issues.json'), 'utf8'),
  ) as LabelledResponse;
  const { issues } = response.data.repository;
  issues.nodes = issues.nodes.filter((node) => numbers.includes(node.number));
  return response;
};

const fakeGithub = (
  responses: Record<number, IssueResponse>,
  pullRequests: ClosingResponse,
  running: LabelledResponse,
  labelStatus: (write: Pick<LabelWrite, 'method' | 'path' | 'body'>) => number,
  pullRequestsStatus: number,
  readiness: Readiness,
  piRecord: () => string,
  forgeLabels: boolean,
) => {
  const requests: GraphqlRequest[] = [];
  const labelWrites: LabelWrite[] = [];
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get('authorization');
    if (url.pathname === '/graphql') {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      const operation = /query (\w+)/.exec(body.query)?.[1];
      requests.push({ operation, authorization, variables: body.variables });
      if (operation === 'ClosingPullRequests') {
        return pullRequestsStatus === 200
          ? json(pullRequests)
          : json({ message: 'Bad Gateway' }, pullRequestsStatus);
      }
      if (operation === 'PullRequestReadiness') {
        return json(readinessResponse(readiness));
      }
      if (operation === 'LabelledIssues') {
        assert.equal(body.variables.label, 'forge:running');
        return json(running);
      }
      const response = responses[Number(body.variables.number)];
      if (response === undefined) {
        throw new Error(`no recorded response for ${String(body.variables.number)}`);
      }
      return json(response);
    }
    if ((init?.method ?? 'GET') === 'GET' && url.pathname.includes('/labels/')) {
      return json({ name: 'forge' }, forgeLabels ? 200 : 404);
    }
    const write = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      authorization,
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
      piStarted: existsSync(piRecord()),
    };
    labelWrites.push(write);
    return json([], labelStatus(write));
  };
  return { fetch, requests, labelWrites };
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    ['-c', 'user.name=Forge Test', '-c', 'user.email=forge@example.com', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();

const SKILL = '---\nname: work-on\ndescription: Drive one ticket to a pull request.\n---\n\nWork on it.\n';

interface Origin {
  path: string;
  tip: string;
}

const originWith = (
  files: Record<string, string>,
  links: Record<string, string> = {},
): Origin => {
  const path = mkdtempSync(join(tmpdir(), 'forge-origin-'));
  git(path, 'init', '--quiet', '--initial-branch', 'main');
  git(path, 'config', 'uploadpack.allowFilter', 'true');
  writeFileSync(join(path, 'README.md'), 'first\n');
  git(path, 'add', '.');
  git(path, 'commit', '--quiet', '-m', 'first');
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(path, file)), { recursive: true });
    writeFileSync(join(path, file), contents);
  }
  for (const [link, target] of Object.entries(links)) {
    mkdirSync(dirname(join(path, link)), { recursive: true });
    symlinkSync(target, join(path, link));
  }
  writeFileSync(join(path, 'README.md'), 'tip\n');
  git(path, 'add', '.');
  git(path, 'commit', '--quiet', '-m', 'tip');
  git(path, 'branch', 'other', 'HEAD~1');
  return { path, tip: git(path, 'rev-parse', 'HEAD') };
};

interface Scenario {
  origin?: Origin;
  repository?: string;
  issue?: number;
  responses?: Record<number, IssueResponse>;
  pullRequests?: ClosingResponse;
  running?: LabelledResponse;
  labelStatus?: (write: Pick<LabelWrite, 'method' | 'path' | 'body'>) => number;
  pullRequestsStatus?: number;
  readiness?: Readiness;
  forgeLabels?: boolean;
  piPackage?: string;
  failing?: boolean;
  seed?: (store: Store) => void;
  prompt?: string;
  installed?: string[];
  lifetimeSeconds?: number;
  appId?: string | null;
  privateKey?: string | null;
  piOutput?: string;
  maxConcurrent?: number;
  gitConfig?: Record<string, string>;
  env?: Record<string, string>;
  nix?: FakeNix;
  bwrapFailure?: string;
  timeoutSeconds?: number;
  maxCostUsd?: number;
  models?: unknown;
  piLingerMs?: number;
  subscription?: boolean;
  claudeFixture?: string;
  stateDir?: string;
  rejectBotLookup?: boolean;
}

interface FakeNix {
  variables?: Record<string, { type: string; value: unknown }>;
  stdout?: string;
  stderr?: string;
  exit?: number;
}

interface NixCall {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

const DEVSHELL_PATH = '/nix/store/00000000000000000000000000000000-devshell-stub/bin';

const DEVSHELL_VARIABLES = {
  PATH: { type: 'exported', value: DEVSHELL_PATH },
  DEVSHELL_TOOL: { type: 'exported', value: 'devshell-stub' },
};

const writeFakeNix = (dir: string, record: string, nix: FakeNix): string => {
  const bin = join(dir, 'fake-nix-bin');
  mkdirSync(bin, { recursive: true });
  const stdout =
    nix.stdout ??
    JSON.stringify({ variables: nix.variables ?? DEVSHELL_VARIABLES, bashFunctions: {} });
  writeFileSync(
    join(bin, 'nix'),
    `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }) + '\\n');
process.stdout.write(${JSON.stringify(stdout)});
process.stderr.write(${JSON.stringify(nix.stderr ?? '')});
process.exitCode = ${nix.exit ?? 0};
if (process.env.FAKE_BWRAP_STATUS_FD) process.on('exit', (code) => writeFileSync(Number(process.env.FAKE_BWRAP_STATUS_FD), JSON.stringify({ 'exit-code': code }) + '\\n'));
`,
    { mode: 0o755 },
  );
  return bin;
};

interface PiCall {
  argv: string[];
  cwd: string;
  subagentInvocation: string | undefined;
  githubToken: string | undefined;
  githubTokenFile: string | undefined;
  githubTokenFileContents: string | null;
  credential: string | null;
  nodeOptions: string | undefined;
  env: Record<string, string>;
}

interface Outcome {
  code: number;
  failure: unknown;
  transcript: string;
  stateDir: string;
  origin: Origin;
  runs: RunRecord[];
  dispatches: DispatchRecord[];
  pi: PiCall | null;
  piLater: { githubTokenFileContents: string; credential: string } | null;
  app: FakeGithubApp;
  bwrap: BwrapCall | null;
  nix: NixCall[];
  requests: GraphqlRequest[];
  labelWrites: LabelWrite[];
}

const gitConfigOf = (
  entries: Record<string, string>,
): Record<string, string> =>
  Object.fromEntries([
    ['GIT_CONFIG_COUNT', String(Object.keys(entries).length)],
    ...Object.entries(entries).flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ]),
  ]);

const rejectingBotLookup = (fetch: typeof globalThis.fetch): typeof globalThis.fetch =>
  async (input, init) =>
    /^\/users\/[^/]+(\[bot\]|%5Bbot%5D)$/.test(new URL(String(input)).pathname)
      ? new Response(JSON.stringify({ message: 'Bad credentials' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      : fetch(input, init);

const dispatch = async (scenario: Scenario = {}): Promise<Outcome> => {
  const origin =
    scenario.origin ??
    originWith({ '.claude/skills/work-on/SKILL.md': SKILL });
  const stateDir = scenario.stateDir ?? mkdtempSync(join(tmpdir(), 'forge-dispatch-'));
  const record = join(stateDir, 'pi-call.json');
  const bwrapRecord = join(stateDir, 'bwrap-call.json');
  const nixRecord = join(stateDir, 'nix-calls.jsonl');
  const nixBin = writeFakeNix(stateDir, nixRecord, scenario.nix ?? {});
  const configPath = join(stateDir, 'runtime.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      harnesses:
        scenario.subscription === true
          ? { 'claude-code': { command: writeFakeClaude(stateDir) } }
          : { pi: { command: writeFakePi(stateDir) } },
      workers: {
        builder: {
          ...(scenario.subscription === true
            ? { harness: 'claude-code', model: 'claude-opus-4-5' }
            : { harness: 'pi', model: 'z-ai/glm-5' }),
          prompt: scenario.prompt ?? '/work-on {url}',
          ...(scenario.timeoutSeconds === undefined
            ? {}
            : { timeoutSeconds: scenario.timeoutSeconds }),
          ...(scenario.maxCostUsd === undefined
            ? {}
            : { maxCostUsd: scenario.maxCostUsd }),
        },
      },
      repositories: {
        forge: { github: 'rameezk/forge', on: { ticket: 'builder' } },
      },
      dispatch: {
        ...(scenario.maxConcurrent === undefined
          ? {}
          : { maxConcurrent: scenario.maxConcurrent }),
      },
    }),
  );
  const app = fakeGithubApp(scenario.installed ?? ['rameezk/forge'], scenario.lifetimeSeconds);
  const privateKeyFile = join(stateDir, 'github-app-private-key.pem');
  const privateKey = scenario.privateKey === undefined ? app.privateKey : scenario.privateKey;
  if (privateKey !== null) {
    writeFileSync(privateKeyFile, privateKey);
  }
  const github = fakeGithub(
    scenario.responses ?? {
      113: labelled(recorded('frontier-ticket'), FORGE_READY),
    },
    scenario.pullRequests ?? opened(closing('merged-pull-request')),
    scenario.running ?? labelledIssues([]),
    scenario.labelStatus ?? (() => 200),
    scenario.pullRequestsStatus ?? 200,
    scenario.readiness ?? readyPullRequest,
    () => record,
    scenario.forgeLabels ?? true,
  );
  if (scenario.seed !== undefined) {
    const seeded = Store.open(join(stateDir, 'forge.db'));
    try {
      scenario.seed(seeded);
    } finally {
      seeded.close();
    }
  }

  const routed = routedThrough(app, github.fetch);
  let failure: unknown = null;
  const openRouter = await fakeOpenRouter(billedAt({}), scenario.models ?? null);
  const code = await main(
    [scenario.repository ?? 'forge', String(scenario.issue ?? 113)],
    {
      PATH: `${nixBin}:${process.env.PATH}`,
      HOME: stateDir,
      FORGE_NIX_SYSTEM: 'x86_64-linux',
      FORGE_RUNTIME_CONFIG: configPath,
      FORGE_STATE_DIR: stateDir,
      FORGE_PI_SUBAGENT_EXTENSION: EXTENSION,
      FORGE_PI_MODEL_DEFAULT_REASONING_EXTENSION: REASONING_EXTENSION,
      FORGE_PI_REQUEST_RECORD_EXTENSION: REQUEST_RECORD_EXTENSION,
      FORGE_PI_PACKAGE: scenario.piPackage ?? lockedPiPackage(),
      FORGE_BWRAP: writeFakeBwrap(stateDir, {
        record: bwrapRecord,
        harnessEnv: {
          FAKE_PI_RECORD: record,
          FAKE_PI_OUTPUT: scenario.piOutput ?? PI_OUTPUT,
          ...(scenario.subscription === true ? claudeReplay(scenario.claudeFixture ?? 'success', record) : {}),
          ...(scenario.piLingerMs === undefined
            ? {}
            : { FAKE_PI_LINGER_MS: String(scenario.piLingerMs) }),
        },
        ...(scenario.bwrapFailure === undefined ? {} : { failure: scenario.bwrapFailure }),
      }),
      ...(scenario.appId === null ? {} : { FORGE_GITHUB_APP_ID: scenario.appId ?? APP_ID }),
      FORGE_GITHUB_APP_PRIVATE_KEY_FILE: privateKeyFile,
      OPENROUTER_API_KEY: 'sk-or-test',
      ...(scenario.subscription === true
        ? { CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN }
        : {}),
      OPENROUTER_BASE_URL: openRouter.baseUrl,
      ...gitConfigOf({
        [`url.${pathToFileURL(origin.path).href}.insteadOf`]:
          'https://github.com/rameezk/forge.git',
        ...scenario.gitConfig,
      }),
      ...scenario.env,
    },
    scenario.rejectBotLookup === true ? rejectingBotLookup(routed) : routed,
  )
    .catch((error: unknown) => {
      if (scenario.failing !== true) throw error;
      failure = error;
      return 1;
    })
    .finally(openRouter.close);

  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    const [run] = store.listRuns();
    return {
      code,
      failure,
      transcript:
        run?.transcriptRef == null
          ? ''
          : readFileSync(join(stateDir, 'transcripts', run.transcriptRef), 'utf8'),
      stateDir,
      origin,
      runs: store.listRuns(),
      dispatches: store.listDispatches(new Date().toISOString()),
      pi: existsSync(record)
        ? (JSON.parse(readFileSync(record, 'utf8')) as PiCall)
        : null,
      piLater: existsSync(`${record}.later`)
        ? (JSON.parse(readFileSync(`${record}.later`, 'utf8')) as {
            githubTokenFileContents: string;
            credential: string;
          })
        : null,
      bwrap: existsSync(bwrapRecord)
        ? (JSON.parse(readFileSync(bwrapRecord, 'utf8')) as BwrapCall)
        : null,
      nix: existsSync(nixRecord)
        ? readFileSync(nixRecord, 'utf8')
            .split('\n')
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as NixCall)
        : [],
      requests: github.requests,
      labelWrites: github.labelWrites,
      app,
    };
  } finally {
    store.close();
  }
};

test('given a frontier ticket labelled forge:ready in a repository whose worker prompt is /work-on {url}, when forge-dispatch runs, then pi starts in a fresh blobless clone of the default branch tip under the state directory with the prompt /skill:work-on and the ticket url, and the run records the repository and ticket', async () => {
  const { code, stateDir, origin, runs, pi, requests } = await dispatch();

  assert.equal(code, 0);
  assert.ok(pi);
  assert.equal(pi.argv.at(-1), `/skill:work-on ${TICKET_URL}`);
  const workDir = realpathSync(pi.cwd);
  assert.ok(workDir.startsWith(realpathSync(stateDir) + sep));
  assert.equal(git(workDir, 'rev-parse', 'HEAD'), origin.tip);
  assert.equal(git(workDir, 'branch', '--show-current'), 'main');
  assert.equal(git(workDir, 'config', 'remote.origin.partialclonefilter'), 'blob:none');
  assert.equal(git(workDir, 'status', '--porcelain'), '');
  assert.deepEqual(requests, [
    {
      operation: 'LabelledIssues',
      authorization: `bearer ${WRITE_TOKEN}`,
      variables: { owner: 'rameezk', name: 'forge', label: 'forge:running', first: 100, after: null },
    },
    {
      operation: 'Ticket',
      authorization: `bearer ${WRITE_TOKEN}`,
      variables: { owner: 'rameezk', name: 'forge', number: 113 },
    },
    {
      operation: 'ClosingPullRequests',
      authorization: `bearer ${WRITE_TOKEN_AFTER}`,
      variables: { owner: 'rameezk', name: 'forge', number: 113 },
    },
    {
      operation: 'PullRequestReadiness',
      authorization: `bearer ${WRITE_TOKEN_AFTER}`,
      variables: { owner: 'rameezk', name: 'forge', number: 143 },
    },
  ]);
  const [run, ...others] = runs;
  assert.deepEqual(others, []);
  assert.ok(run);
  assert.equal(run.worker, 'builder');
  assert.equal(run.status, 'success');
  assert.deepEqual(run.ticket, {
    repository: 'forge',
    number: 113,
    url: TICKET_URL,
  });
});

test('given a workload that leaves an open pull request closing the ticket, when the dispatch ends, then it is done and holds that pull request\'s number and url, open and not yet settled', async () => {
  const { dispatches } = await dispatch();

  const [dispatched, ...others] = dispatches;
  assert.deepEqual(others, []);
  assert.equal(dispatched?.state, 'done');
  assert.deepEqual(dispatched?.pullRequest, {
    number: 143,
    url: 'https://github.com/rameezk/forge/pull/143',
    state: 'open',
    settledAt: null,
    rework: null,
  });
});

const gitAs = (pi: PiCall, ...args: string[]): string =>
  execFileSync('git', args, { cwd: pi.cwd, env: pi.env, encoding: 'utf8' }).trim();

test('given a dispatched ticket, when its workload commits, then the commit carries the bot identity of the App as its author and committer', async () => {
  const { pi } = await dispatch();

  assert.ok(pi);
  gitAs(pi, 'commit', '--quiet', '--allow-empty', '-m', 'work');
  assert.equal(
    gitAs(pi, 'log', '-1', '--format=%an <%ae>%n%cn <%ce>'),
    `${BOT_LOGIN} <${BOT_EMAIL}>\n${BOT_LOGIN} <${BOT_EMAIL}>`,
  );
});

const githubCredential = (
  pi: PiCall,
  env: Record<string, string> = {},
): string => {
  assert.ok(pi.githubTokenFile);
  mkdirSync(dirname(pi.githubTokenFile), { recursive: true });
  writeFileSync(pi.githubTokenFile, WORKLOAD_TOKEN);
  return execFileSync('git', ['credential', 'fill'], {
    cwd: pi.cwd,
    env: { ...pi.env, GIT_TERMINAL_PROMPT: '0', ...env },
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
};

test('given a dispatched workload on a box whose system git config already has a credential helper, when git asks for credentials for https://github.com, then it gets the write token, and neither its HOME nor the checkout\'s git config holds a credential', async () => {
  const systemConfig = join(mkdtempSync(join(tmpdir(), 'forge-etc-')), 'gitconfig');
  writeFileSync(
    systemConfig,
    '[credential]\n\thelper = "!f() { echo username=someone-else; echo password=not-the-write-token; }; f"\n',
  );
  const { pi } = await dispatch();

  assert.ok(pi);
  const credential = githubCredential(pi, { GIT_CONFIG_SYSTEM: systemConfig });
  assert.match(credential, /^username=x-access-token$/m);
  assert.match(credential, new RegExp(`^password=${WORKLOAD_TOKEN}$`, 'm'));
  const home = pi.env.HOME;
  assert.ok(home);
  for (const file of ['.gitconfig', '.git-credentials', '.config/git']) {
    assert.equal(existsSync(join(home, file)), false, file);
  }
  assert.doesNotMatch(readFileSync(join(pi.cwd, '.git', 'config'), 'utf8'), /github_pat|helper/);
});

test('given a managed repository, when it is dispatched, then its clone runs with the same credential environment as the workload', async () => {
  const hooks = mkdtempSync(join(tmpdir(), 'forge-hooks-'));
  const credential = join(hooks, 'credential');
  writeFileSync(
    join(hooks, 'post-checkout'),
    `#!/bin/sh\nprintf 'protocol=https\\nhost=github.com\\n\\n' | GIT_TERMINAL_PROMPT=0 git credential fill > '${credential}'\n`,
    { mode: 0o755 },
  );

  const { pi } = await dispatch({ gitConfig: { 'core.hooksPath': hooks } });

  assert.ok(pi);
  assert.equal(readFileSync(credential, 'utf8'), githubCredential(pi));
  assert.match(readFileSync(credential, 'utf8'), new RegExp(`^password=${WORKLOAD_TOKEN}$`, 'm'));
});

test('given a subscription worker and a runner environment holding both provider credentials, when its repository is cloned, then no git process on the box sees either credential', async () => {
  const hooks = mkdtempSync(join(tmpdir(), 'forge-hooks-'));
  const seen = join(hooks, 'environment');
  writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\nenv > '${seen}'\n`, { mode: 0o755 });

  await dispatch({ subscription: true, gitConfig: { 'core.hooksPath': hooks } });

  const environment = readFileSync(seen, 'utf8');
  assert.doesNotMatch(environment, /CLAUDE_CODE_OAUTH_TOKEN|sk-ant-oat|OPENROUTER_API_KEY|sk-or-test/);
});

test('given a frontier ticket labelled forge:ready, when it is dispatched, then forge:running replaces forge:ready before the workload starts', async () => {
  const { labelWrites } = await dispatch();

  assert.deepEqual(labelWrites.slice(0, 2), [
    {
      method: 'POST',
      path: '/repos/rameezk/forge/issues/113/labels',
      authorization: `bearer ${WRITE_TOKEN}`,
      body: { labels: ['forge:running'] },
      piStarted: false,
    },
    {
      method: 'DELETE',
      path: '/repos/rameezk/forge/issues/113/labels/forge%3Aready',
      authorization: `bearer ${WRITE_TOKEN}`,
      body: null,
      piStarted: false,
    },
  ]);
});

const FLAKE = '{ outputs = { self }: { }; }\n';

test('given a checkout whose flake\'s default devShell provides a tool, when the ticket is dispatched, then the runner asks nix for that devShell inside the workload sandbox, from the checkout root and without forge\'s credentials, and pi starts with the devShell\'s variables and its path ahead of the workload toolset', async () => {
  const { pi, nix } = await dispatch({
    origin: originWith({
      '.claude/skills/work-on/SKILL.md': SKILL,
      'flake.nix': FLAKE,
    }),
  });

  assert.ok(pi);
  const [call, ...others] = nix;
  assert.deepEqual(others, []);
  assert.ok(call);
  assert.deepEqual(call.argv, [
    'print-dev-env',
    '--json',
    '--no-write-lock-file',
    '.#.devShells.x86_64-linux.default',
  ]);
  assert.equal(realpathSync(call.cwd), realpathSync(pi.cwd));
  assert.equal(call.env.FAKE_BWRAP_STATUS_FD, '3');
  for (const name of ['FORGE_GITHUB_TOKEN_FILE', 'GITHUB_TOKEN', 'OPENROUTER_API_KEY', 'GIT_CONFIG_COUNT', 'GIT_AUTHOR_NAME']) {
    assert.equal(call.env[name], undefined, name);
  }
  assert.equal(pi.env.DEVSHELL_TOOL, 'devshell-stub');
  const toolset = call.env.PATH;
  assert.ok(toolset);
  assert.equal(pi.env.PATH, `${DEVSHELL_PATH}:${toolset}`);
});

test('given a devShell that sets OPENROUTER_API_KEY, a git author, pi\'s agent dir, its own locale, and the build-only variables nix develop leaves out, when the workload starts, then pi sees forge\'s deliberate values, the devShell\'s locale over the box\'s, its sandbox HOME, and none of the build-only or unexported variables', async () => {
  const exported = (value: string) => ({ type: 'exported', value });
  const { pi } = await dispatch({
    origin: originWith({
      '.claude/skills/work-on/SKILL.md': SKILL,
      'flake.nix': FLAKE,
    }),
    nix: {
      variables: {
        ...DEVSHELL_VARIABLES,
        FORGE_GITHUB_TOKEN_FILE: exported('/nix/store/00000000000000000000000000000000-planted/token'),
        OPENROUTER_API_KEY: exported('sk-or-from-the-devshell'),
        GIT_AUTHOR_NAME: exported('Devshell Author'),
        GIT_AUTHOR_EMAIL: exported('devshell@example.com'),
        PI_CODING_AGENT_DIR: exported('/nix/store/00000000000000000000000000000000-planted'),
        HOME: exported('/homeless-shelter'),
        TMPDIR: exported('/build'),
        SSL_CERT_FILE: exported('/no-cert-file.crt'),
        NIX_BUILD_TOP: exported('/build'),
        LANG: exported('en_GB.UTF-8'),
        LOCALE_ARCHIVE: exported('/nix/store/00000000000000000000000000000000-glibc-locales/lib/locale/locale-archive'),
        SHELL_ONLY: { type: 'var', value: 'unexported' },
        ARRAY_ONLY: { type: 'array', value: ['a', 'b'] },
      },
    },
    env: { LANG: 'C.UTF-8', LOCALE_ARCHIVE: '/run/current-system/sw/lib/locale/locale-archive' },
  });

  assert.ok(pi);
  assert.match(pi.env.FORGE_GITHUB_TOKEN_FILE ?? '', /\/credentials\/[0-9a-f-]{36}\/github-token$/);
  assert.equal(pi.env.OPENROUTER_API_KEY, 'sk-or-test');
  assert.equal(pi.env.GIT_AUTHOR_NAME, GIT_IDENTITY.name);
  assert.equal(pi.env.GIT_AUTHOR_EMAIL, GIT_IDENTITY.email);
  assert.match(pi.env.PI_CODING_AGENT_DIR ?? '', /\/agent\/[0-9a-f-]{36}$/);
  assert.notEqual(pi.env.HOME, '/homeless-shelter');
  assert.equal(pi.env.LANG, 'en_GB.UTF-8');
  assert.equal(
    pi.env.LOCALE_ARCHIVE,
    '/nix/store/00000000000000000000000000000000-glibc-locales/lib/locale/locale-archive',
  );
  for (const name of ['TMPDIR', 'SSL_CERT_FILE', 'NIX_BUILD_TOP', 'SHELL_ONLY', 'ARRAY_ONLY']) {
    assert.equal(pi.env[name], undefined, name);
  }
});

test('given a checkout with no flake, when the ticket is dispatched, then nix is never asked for a devShell and pi starts with only the workload toolset on its path', async () => {
  const { pi, nix, bwrap } = await dispatch();

  assert.ok(pi);
  assert.deepEqual(nix, []);
  assert.equal(pi.env.PATH, bwrap?.env.PATH);
  assert.equal(pi.env.DEVSHELL_TOOL, undefined);
});

const CREDENTIAL_TOOLS = '/nix/store/00000000000000000000000000000000-forge-gh/bin';

test('given forge\'s credential tools directory and a devShell whose path has its own tools, when the ticket is dispatched, then pi\'s path starts with that directory, ahead of the devShell and the toolset, and its variable does not reach pi', async () => {
  const { pi, nix } = await dispatch({
    origin: originWith({
      '.claude/skills/work-on/SKILL.md': SKILL,
      'flake.nix': FLAKE,
    }),
    env: { FORGE_CREDENTIAL_TOOLS: CREDENTIAL_TOOLS },
  });

  assert.ok(pi);
  const toolset = nix[0]?.env.PATH;
  assert.ok(toolset);
  assert.equal(pi.env.PATH, `${CREDENTIAL_TOOLS}:${DEVSHELL_PATH}:${toolset}`);
  assert.equal(pi.env.FORGE_CREDENTIAL_TOOLS, undefined);
});

test('given forge\'s credential tools directory and a checkout with no flake, when the ticket is dispatched, then pi\'s path starts with that directory, ahead of the toolset', async () => {
  const { pi, nix } = await dispatch({
    env: { FORGE_CREDENTIAL_TOOLS: CREDENTIAL_TOOLS },
  });

  assert.ok(pi);
  assert.deepEqual(nix, []);
  const entries = pi.env.PATH?.split(':') ?? [];
  assert.equal(entries[0], CREDENTIAL_TOOLS);
  assert.equal(entries.filter((entry) => entry === CREDENTIAL_TOOLS).length, 1);
  assert.ok(entries.length > 1);
  assert.equal(pi.env.FORGE_CREDENTIAL_TOOLS, undefined);
});

const NIX_ERROR = [
  "error: undefined variable 'mkShel'",
  '       at /nix/store/00000000000000000000000000000000-source/flake.nix:1:60:',
  "            1| { outputs = { self }: { devShells.x86_64-linux.default = mkShel { }; }; }",
  '             |                                                            ^',
  '',
].join('\n');

test('given a checkout whose devShell fails to evaluate, when the ticket is dispatched, then pi never starts, the run keeps nix\'s error output, and the ticket becomes forge:failed with devShell failed as the reason and nix\'s error as the detail', async () => {
  const { code, pi, runs, labelWrites, dispatches, journal } = await journaled(() =>
    dispatch({
      origin: originWith({
        '.claude/skills/work-on/SKILL.md': SKILL,
        'flake.nix': FLAKE,
      }),
      nix: { stderr: NIX_ERROR, exit: 1, stdout: '' },
      pullRequests: closing('no-pull-request'),
    }),
  ).then(({ result, journal }) => ({ ...result, journal }));

  assert.equal(code, 1);
  assert.equal(pi, null);
  const expected = `nix print-dev-env exited with code 1: ${NIX_ERROR.trim()}`;
  assert.equal(runs[0]?.status, 'error');
  assert.equal(runs[0]?.error, expected);
  assert.ok(journal.includes(NIX_ERROR), journal);
  assert.deepEqual(
    labelWrites.slice(2),
    finalLabelWrites('forge:failed').map((write) => ({ ...write, piStarted: false })),
  );
  assert.deepEqual(
    dispatches.map(({ state, reason, detail }) => ({ state, reason, detail })),
    [{ state: 'failed', reason: 'devshell-failed', detail: "error: undefined variable 'mkShel'" }],
  );
});

const NIX_BUILD_FAILURE = [
  "building '/nix/store/00000000000000000000000000000000-broken-tool.drv'...",
  "error: builder for '/nix/store/00000000000000000000000000000000-broken-tool.drv' failed with exit code 3;",
  '       last 1 log lines:',
  '       > boom',
  '       For full logs, run:',
  '         nix log /nix/store/00000000000000000000000000000000-broken-tool.drv',
  "error: 1 dependencies of derivation '/nix/store/00000000000000000000000000000000-devshell-env.drv' failed to build",
  '',
].join('\n');

test('given a checkout whose devShell has a dependency that fails to build, when the ticket is dispatched, then the ticket fails with devShell failed and the failing builder as the detail, and the run keeps the whole build output', async () => {
  const { pi, runs, dispatches } = await journaled(() =>
    dispatch({
      origin: originWith({
        '.claude/skills/work-on/SKILL.md': SKILL,
        'flake.nix': FLAKE,
      }),
      nix: { stderr: NIX_BUILD_FAILURE, exit: 1, stdout: '' },
      pullRequests: closing('no-pull-request'),
    }),
  ).then(({ result }) => result);

  assert.equal(pi, null);
  assert.equal(runs[0]?.error, `nix print-dev-env exited with code 1: ${NIX_BUILD_FAILURE.trim()}`);
  assert.deepEqual(
    dispatches.map(({ reason, detail }) => ({ reason, detail })),
    [
      {
        reason: 'devshell-failed',
        detail: "error: builder for '/nix/store/00000000000000000000000000000000-broken-tool.drv' failed with exit code 3;",
      },
    ],
  );
});

test('given nix that exits cleanly without printing a dev environment, when the ticket is dispatched, then pi never starts and the ticket fails with devShell failed as the reason', async () => {
  const { pi, dispatches } = await journaled(() =>
    dispatch({
      origin: originWith({
        '.claude/skills/work-on/SKILL.md': SKILL,
        'flake.nix': FLAKE,
      }),
      nix: { stdout: 'warning: not json' },
      pullRequests: closing('no-pull-request'),
    }),
  ).then(({ result }) => result);

  assert.equal(pi, null);
  assert.equal(dispatches[0]?.reason, 'devshell-failed');
  assert.match(dispatches[0]?.detail ?? '', /^nix print-dev-env printed no dev environment: /);
});

test('given a checkout with a flake and a workload sandbox that cannot start, when the ticket is dispatched, then nix never runs unconfined, pi never starts, and the ticket fails because the run errored', async () => {
  const { pi, nix, runs, dispatches } = await journaled(() =>
    dispatch({
      origin: originWith({
        '.claude/skills/work-on/SKILL.md': SKILL,
        'flake.nix': FLAKE,
      }),
      bwrapFailure: 'bwrap: setting up uid map: Permission denied',
      pullRequests: closing('no-pull-request'),
    }),
  ).then(({ result }) => result);

  assert.equal(pi, null);
  assert.deepEqual(nix, []);
  const expected = 'the workload sandbox could not start: bwrap: setting up uid map: Permission denied';
  assert.equal(runs[0]?.error, expected);
  assert.deepEqual(
    dispatches.map(({ reason, detail }) => ({ reason, detail })),
    [{ reason: 'errored', detail: expected }],
  );
});

const finalLabelWrites = (label: string): LabelWrite[] => [
  {
    method: 'POST',
    path: '/repos/rameezk/forge/issues/113/labels',
    authorization: `bearer ${WRITE_TOKEN_AFTER}`,
    body: { labels: [label] },
    piStarted: true,
  },
  {
    method: 'DELETE',
    path: '/repos/rameezk/forge/issues/113/labels/forge%3Arunning',
    authorization: `bearer ${WRITE_TOKEN_AFTER}`,
    body: null,
    piStarted: true,
  },
  {
    method: 'DELETE',
    path: '/repos/rameezk/forge/issues/113/labels/forge%3Aready',
    authorization: `bearer ${WRITE_TOKEN_AFTER}`,
    body: null,
    piStarted: true,
  },
];

test('given a successful run that leaves a ready pull request closing the ticket whose required checks are green or skipped, and whose only red check is not required, when the run ends, then the ticket becomes forge:done, losing any forge:ready the run set so no later pass dispatches it again', async () => {
  for (const checks of [
    [],
    null,
    [
      checkRun('build', 'SUCCESS'),
      checkRun('lint', 'SKIPPED'),
      statusContext('ci/legacy', 'SUCCESS'),
      checkRun('flaky', 'FAILURE', false),
      checkRun('slow', null, false),
    ],
  ]) {
    const { labelWrites, runs, dispatches } = await dispatch({
      readiness: { isDraft: false, checks },
    });

    assert.deepEqual(labelWrites.slice(2), finalLabelWrites('forge:done'), JSON.stringify(checks));
    assert.equal(runs[0]?.status, 'success');
    assert.equal(dispatches[0]?.state, 'done');
  }
});

test('given a run that errors after leaving a ready pull request with green required checks, when the run ends, then the dispatch fails as errored and the ticket becomes forge:failed', async () => {
  const { labelWrites, runs, dispatches } = await dispatch({ piOutput: PROVIDER_ERROR });

  assert.equal(runs[0]?.status, 'error');
  assert.deepEqual(
    dispatches.map(({ state, reason }) => ({ state, reason })),
    [{ state: 'failed', reason: 'errored' }],
  );
  assert.deepEqual(labelWrites.slice(2), finalLabelWrites('forge:failed'));
});

test('given a successful run that leaves a pull request closing the ticket that is still a draft, or whose required check is red or pending, when the run ends, then the dispatch fails naming what fell short and the ticket becomes forge:failed', async () => {
  for (const [readiness, reason, detail] of [
    [{ isDraft: true, checks: [] }, 'draft', null],
    [{ isDraft: true, checks: [checkRun('build', 'FAILURE')] }, 'draft', null],
    [{ isDraft: false, checks: [checkRun('build', 'FAILURE')] }, 'check-failed', 'build'],
    [{ isDraft: false, checks: [checkRun('build', 'TIMED_OUT')] }, 'check-failed', 'build'],
    [{ isDraft: false, checks: [statusContext('ci/legacy', 'ERROR')] }, 'check-failed', 'ci/legacy'],
    [{ isDraft: false, checks: [checkRun('build', null)] }, 'check-pending', 'build'],
    [{ isDraft: false, checks: [statusContext('ci/legacy', 'PENDING')] }, 'check-pending', 'ci/legacy'],
    [
      {
        isDraft: false,
        checks: [checkRun('lint', 'FAILURE'), checkRun('test', 'SUCCESS'), checkRun('vm', 'CANCELLED')],
      },
      'check-failed',
      'lint, vm',
    ],
    [
      { isDraft: false, checks: [checkRun('vm', null), checkRun('lint', null), checkRun('test', 'SUCCESS')] },
      'check-pending',
      'vm, lint',
    ],
    [
      { isDraft: false, checks: [checkRun('vm', null), checkRun('lint', 'FAILURE')] },
      'check-failed',
      'lint',
    ],
  ] as const) {
    const { labelWrites, runs, dispatches } = await dispatch({
      readiness: { isDraft: readiness.isDraft, checks: [...readiness.checks] },
    });

    const label = `${reason} ${detail}`;
    assert.equal(runs[0]?.status, 'success', label);
    assert.deepEqual(
      dispatches.map((record) => ({
        state: record.state,
        reason: record.reason,
        detail: record.detail,
        pullRequest: record.pullRequest,
      })),
      [{ state: 'failed', reason, detail, pullRequest: null }],
      label,
    );
    assert.deepEqual(labelWrites.slice(2), finalLabelWrites('forge:failed'), label);
  }
});

test('given a dispatched subscription workload whose provider answers with a usage limit and leaves no pull request, when forge-dispatch runs, then the run ends error with Anthropic\'s message and the ticket becomes forge:failed', async () => {
  const { code, runs, dispatches, labelWrites } = await dispatch({
    subscription: true,
    claudeFixture: 'usage-limit',
    pullRequests: closing('no-pull-request'),
  });

  assert.equal(code, 1);
  assert.equal(runs[0]?.status, 'error');
  assert.match(runs[0]?.error ?? '', /You've hit your limit/);
  assert.equal(dispatches[0]?.state, 'failed');
  assert.deepEqual(labelWrites.slice(2), finalLabelWrites('forge:failed'));
});

const piOutputEnding = (text: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-output-')), 'pi.jsonl');
  writeFileSync(path, readFileSync(PI_OUTPUT, 'utf8').replaceAll('All done.', text));
  return path;
};

test('given a run that ends with a question and leaves no open pull request from the repository itself closing the ticket, whether there is none, a merged one, an open one from a fork or one in another repository, when the run ends, then the ticket becomes forge:failed with the agent\'s final message as the reason, and nothing but the label is written to the ticket', async () => {
  const question = 'Should the label check use REST or GraphQL?';
  for (const [pullRequests, response] of [
    ['none', closing('no-pull-request')],
    ['merged', closing('merged-pull-request')],
    ['open from a fork', opened(closing('merged-pull-request'), { isCrossRepository: true })],
    ['open in another repository', opened(closing('merged-pull-request'), { repository: 'someone/elsewhere' })],
  ] as const) {
    const { labelWrites, runs, dispatches } = await dispatch({
      piOutput: piOutputEnding(question),
      pullRequests: response,
    });

    assert.deepEqual(labelWrites.slice(2), finalLabelWrites('forge:failed'), pullRequests);
    assert.ok(
      labelWrites.every(({ path }) => path.startsWith('/repos/rameezk/forge/issues/113/labels')),
      pullRequests,
    );
    const [run] = runs;
    assert.ok(run);
    assert.deepEqual(
      dispatches.map(({ repository, number, url, runId, state, reason, detail }) => ({
        repository, number, url, runId, state, reason, detail,
      })),
      [
        {
          repository: 'forge',
          number: 113,
          url: TICKET_URL,
          runId: run.id,
          state: 'failed',
          reason: 'no-pull-request',
          detail: `The command printed forge. ${question}`,
        },
      ],
      pullRequests,
    );
  }
});

test('given a dispatched workload whose pi keeps running past the worker\'s timeout, when forge-dispatch runs, then the run ends exceeded, the dispatch fails with reason exceeded naming the timeout, the ticket becomes forge:failed, and nothing but the label is written to it', async () => {
  const { code, runs, dispatches, labelWrites } = await dispatch({
    piOutput: piOutputEnding('still working'),
    piLingerMs: 10_000,
    timeoutSeconds: 1,
    pullRequests: closing('no-pull-request'),
  });

  assert.equal(code, 1);
  assert.equal(runs[0]?.status, 'exceeded');
  assert.equal(runs[0]?.exceededLimit, 'timeout');
  assert.deepEqual(
    dispatches.map(({ state, reason, detail }) => ({ state, reason, detail })),
    [{ state: 'failed', reason: 'exceeded', detail: 'timeout' }],
  );
  assert.deepEqual(labelWrites.slice(2), finalLabelWrites('forge:failed'));
  assert.ok(
    labelWrites.every(({ path }) => path.startsWith('/repos/rameezk/forge/issues/113/labels')),
  );
});

test('given a dispatched workload whose generations pass the worker\'s budget, when forge-dispatch runs, then the run ends exceeded on its budget, the dispatch fails with reason exceeded naming the budget, the ticket becomes forge:failed, and nothing but the label is written to it', async () => {
  const { code, runs, dispatches, labelWrites } = await dispatch({
    piOutput: piOutputEnding('still working'),
    piLingerMs: 10_000,
    maxCostUsd: 0.002,
    models: LISTED_MODELS,
    pullRequests: closing('no-pull-request'),
  });

  assert.equal(code, 1);
  assert.equal(runs[0]?.status, 'exceeded');
  assert.equal(runs[0]?.exceededLimit, 'budget');
  assert.equal(runs[0]?.maxCostUsd, 0.002);
  assert.deepEqual(
    dispatches.map(({ state, reason, detail }) => ({ state, reason, detail })),
    [{ state: 'failed', reason: 'exceeded', detail: 'budget' }],
  );
  assert.deepEqual(labelWrites.slice(2), finalLabelWrites('forge:failed'));
  assert.ok(
    labelWrites.every(({ path }) => path.startsWith('/repos/rameezk/forge/issues/113/labels')),
  );
});

const forgeTicket = (number: number) => ({
  repository: 'forge',
  number,
  url: `https://github.com/rameezk/forge/issues/${number}`,
});

const interruptedLabelWrites = (number: number): LabelWrite[] => [
  {
    method: 'POST',
    path: `/repos/rameezk/forge/issues/${number}/labels`,
    authorization: `bearer ${WRITE_TOKEN}`,
    body: { labels: ['forge:failed'] },
    piStarted: false,
  },
  {
    method: 'DELETE',
    path: `/repos/rameezk/forge/issues/${number}/labels/forge%3Arunning`,
    authorization: `bearer ${WRITE_TOKEN}`,
    body: null,
    piStarted: false,
  },
  {
    method: 'DELETE',
    path: `/repos/rameezk/forge/issues/${number}/labels/forge%3Aready`,
    authorization: `bearer ${WRITE_TOKEN}`,
    body: null,
    piStarted: false,
  },
];

test('given tickets labelled forge:running, one whose dispatch stopped beating, one with no dispatch in the store, and one with a live dispatch, when the next dispatch pass runs, then the first two become forge:failed with interrupted as the reason, losing any forge:ready a split claim left behind, and the live one is left alone', async () => {
  const { labelWrites, dispatches } = await dispatch({
    running: labelledIssues([114, 115, 123]),
    seed: (store) => {
      startedDispatch(store, 'forge', 114, 'run-stale', '2026-09-01T09:00:00.000Z');
      startedDispatch(store, 'forge', 123, 'run-live', new Date().toISOString());
    },
  });

  assert.deepEqual(labelWrites.slice(0, 6), [
    ...interruptedLabelWrites(114),
    ...interruptedLabelWrites(115),
  ]);
  assert.ok(labelWrites.every(({ path }) => !path.includes('/issues/123/')));
  assert.deepEqual(
    dispatches
      .filter(({ number }) => number !== 113)
      .map(({ number, state, reason }) => ({ number, state, reason })),
    [
      { number: 114, state: 'failed', reason: 'interrupted' },
      { number: 115, state: 'failed', reason: 'interrupted' },
      { number: 123, state: 'running', reason: null },
    ],
  );
});

test('given a live dispatch of the ticket already in the store, when forge-dispatch runs for it, then it refuses without claiming the ticket or starting a workload', async () => {
  const { result, journal } = await journaled(() =>
    dispatch({
      seed: (store) => {
        startedDispatch(store, 'forge', 113, 'run-live', new Date().toISOString());
      },
    }),
  );

  assert.equal(result.code, 1);
  assert.equal(result.pi, null);
  assert.deepEqual(result.runs, []);
  assert.deepEqual(result.labelWrites, []);
  assert.match(journal, /forge#113 is not dispatchable: it is already being dispatched/);
});

test('given maxConcurrent = 1 and a dispatched workload of another ticket still running, when forge-dispatch runs, then it refuses without claiming the ticket or starting a second workload, while a stale dispatch does not count against the limit', async () => {
  const { result, journal } = await journaled(() =>
    dispatch({
      maxConcurrent: 1,
      seed: (store) => {
        startedDispatch(store, 'forge', 123, 'run-live', new Date().toISOString());
      },
    }),
  );

  assert.equal(result.code, 1);
  assert.equal(result.pi, null);
  assert.deepEqual(result.runs, []);
  assert.deepEqual(result.labelWrites.filter(({ path }) => path.includes('/issues/113/')), []);
  assert.match(
    journal,
    /forge#113 is not dispatchable: 1 dispatched workload is already running, the most forge\.runtime\.dispatch\.maxConcurrent allows/,
  );

  const stale = await dispatch({
    seed: (store) => {
      startedDispatch(store, 'forge', 123, 'run-stale', '2026-09-01T09:00:00.000Z');
    },
  });
  assert.equal(stale.code, 0);
  assert.notEqual(stale.pi, null);
});

test('given maxConcurrent = 2 and one dispatched workload still running, when forge-dispatch runs for another ticket, then its workload starts beside the first', async () => {
  const { code, pi } = await dispatch({
    maxConcurrent: 2,
    seed: (store) => {
      startedDispatch(store, 'forge', 123, 'run-live', new Date().toISOString());
    },
  });

  assert.equal(code, 0);
  assert.notEqual(pi, null);
});

test('given GitHub refuses the claim, when forge-dispatch runs, then it fails naming the refusal, starts no workload, and the dispatch fails with the claim as the reason', async () => {
  const { failure, pi, runs, dispatches } = await dispatch({
    labelStatus: ({ method }) => (method === 'POST' ? 403 : 200),
    failing: true,
  });

  const refused = 'GitHub answered 403 labelling rameezk/forge#113 forge:running';
  assert.ok(failure instanceof Error);
  assert.equal(failure.message, refused);
  assert.equal(pi, null);
  assert.deepEqual(runs, []);
  assert.deepEqual(
    dispatches.map(({ state, reason, detail }) => ({ state, reason, detail })),
    [{ state: 'failed', reason: 'errored', detail: `could not claim the ticket: ${refused}` }],
  );
});

test('given GitHub fails the pull request check after the run, when forge-dispatch runs, then it fails naming the error, and the dispatch fails as errored with that error rather than being left to look interrupted', async () => {
  const { failure, runs, labelWrites, dispatches } = await dispatch({
    pullRequestsStatus: 502,
    failing: true,
  });

  const error = 'GitHub answered 502 for rameezk/forge#113';
  assert.ok(failure instanceof Error);
  assert.equal(failure.message, error);
  assert.equal(runs[0]?.status, 'success');
  assert.equal(labelWrites.length, 2);
  assert.deepEqual(
    dispatches.map(({ state, reason, detail }) => ({ state, reason, detail })),
    [{ state: 'failed', reason: 'errored', detail: `could not check for a pull request: ${error}` }],
  );
});

test('given a ticket still labelled forge:running whose dispatch already ended done or failed, when the next dispatch pass runs, then the label catches up with the recorded outcome and its reason is kept', async () => {
  const at = '2026-09-30T08:00:00.000Z';
  const { labelWrites, dispatches } = await dispatch({
    running: labelledIssues([114, 115]),
    seed: (store) => {
      const done = startedDispatch(store, 'forge', 114, 'run-114', at);
      const failed = startedDispatch(store, 'forge', 115, 'run-115', at);
      store.endDispatch(done, { state: 'done', pullRequest: { number: 143, url: 'https://github.com/rameezk/forge/pull/143' } }, at);
      store.endDispatch(failed, { state: 'failed', reason: 'errored', detail: 'GitHub answered 502' }, at);
    },
  });

  assert.deepEqual(labelWrites.slice(0, 6), [
    ...interruptedLabelWrites(114).map((write, index) =>
      index === 0 ? { ...write, body: { labels: ['forge:done'] } } : write,
    ),
    ...interruptedLabelWrites(115),
  ]);
  assert.deepEqual(
    dispatches
      .filter(({ number }) => number !== 113)
      .map(({ number, state, reason, detail }) => ({ number, state, reason, detail })),
    [
      { number: 114, state: 'done', reason: null, detail: null },
      { number: 115, state: 'failed', reason: 'errored', detail: 'GitHub answered 502' },
    ],
  );
});

test('given a run that ends without a pull request on an enormous final message, when the run ends, then the stored reason keeps only its first 2000 characters', async () => {
  const { dispatches } = await dispatch({
    piOutput: piOutputEnding('x'.repeat(100_000)),
    pullRequests: closing('no-pull-request'),
  });

  const detail = dispatches[0]?.detail ?? '';
  assert.equal(detail.length, 2000);
  assert.ok(detail.startsWith('The command printed forge. xxx'));
  assert.ok(detail.endsWith('x…'));
});

const adding = (label: string) => ({ method, body }: Pick<LabelWrite, 'method' | 'body'>) =>
  method === 'POST' && JSON.stringify(body) === JSON.stringify({ labels: [label] }) ? 502 : 200;

test('given GitHub fails to set forge:done after a run that left an open pull request, when forge-dispatch runs, then it fails naming the error, and the dispatch is still recorded as done so the next pass can finish the label', async () => {
  const { failure, dispatches } = await dispatch({
    labelStatus: adding('forge:done'),
    failing: true,
  });

  assert.ok(failure instanceof Error);
  assert.equal(failure.message, 'GitHub answered 502 labelling rameezk/forge#113 forge:done');
  assert.deepEqual(
    dispatches.map(({ state, reason }) => ({ state, reason })),
    [{ state: 'done', reason: null }],
  );
});

test('given the locked pi package cannot be loaded, when forge-dispatch runs, then it fails, and the dispatch fails as errored because the workload could not start', async () => {
  const { failure, pi, dispatches } = await dispatch({
    piPackage: join(tmpdir(), 'forge-no-pi-package'),
    failing: true,
  });

  assert.ok(failure instanceof Error);
  assert.equal(pi, null);
  assert.equal(dispatches[0]?.state, 'failed');
  assert.equal(dispatches[0]?.reason, 'errored');
  assert.match(dispatches[0]?.detail ?? '', /^could not start the workload: /);
});

test('given a ticket labelled forge:ready that has an open blocker, one that is closed, one that is not ready-for-agent, and a frontier ticket without the label in a repository with the forge labels, and the same ticket in a repository without them, when forge-dispatch runs for each, then none starts a workload or clones, and each refusal names why', async () => {
  const cases = [
    { issue: 115, fixture: 'blocked-ticket', label: true, forgeLabels: true, reason: /forge#115 is not dispatchable: it has open blockers/ },
    { issue: 109, fixture: 'closed-ticket', label: true, forgeLabels: true, reason: /forge#109 is not dispatchable: it is closed/ },
    { issue: 112, fixture: 'spec-ticket', label: true, forgeLabels: true, reason: /forge#112 is not dispatchable: it is not labelled ready-for-agent/ },
    { issue: 113, fixture: 'frontier-ticket', label: false, forgeLabels: true, reason: /forge#113 is not dispatchable: it is not labelled forge:ready/ },
    { issue: 113, fixture: 'frontier-ticket', label: false, forgeLabels: false, reason: /forge#113 is not dispatchable: the forge labels are missing from rameezk\/forge, and the frontier sync creates them once it can write to GitHub as the App/ },
  ];
  for (const { issue, fixture, label, forgeLabels, reason } of cases) {
    const response = label
      ? labelled(recorded(fixture), FORGE_READY)
      : recorded(fixture);
    const { result, journal } = await journaled(() =>
      dispatch({ issue, forgeLabels, responses: { [issue]: response } }),
    );

    assert.equal(result.code, 1, fixture);
    assert.deepEqual(result.runs, [], fixture);
    assert.equal(result.pi, null, fixture);
    assert.deepEqual(result.labelWrites, [], fixture);
    assert.equal(existsSync(join(result.stateDir, 'work')), false, fixture);
    assert.match(journal, reason);
  }
});

const projectInstructions = (path: string): string[] => [
  '--append-system-prompt',
  `<project_context>\n\nProject-specific instructions and guidelines:\n\n<project_instructions path="${path}">`,
  '--append-system-prompt',
  path,
  '--append-system-prompt',
  '</project_instructions>\n\n</project_context>',
];

const childArgv = (pi: PiCall): string[] =>
  (JSON.parse(pi.subagentInvocation ?? 'null') as { argv: string[] }).argv;

test('given a checkout root with .claude/skills, .pi/skills, AGENTS.md, CLAUDE.md and .pi/SYSTEM.md and no .agents/skills, when the workload starts, then pi and the subagent invocation get the two skill paths, the system prompt file, AGENTS.md framed as project instructions, and the unattended instruction, which gives the scoped-check rule, and nothing for what does not exist', async () => {
  const { pi } = await dispatch({
    origin: originWith({
      '.claude/skills/work-on/SKILL.md': SKILL,
      '.pi/skills/review/SKILL.md': SKILL.replace('work-on', 'review'),
      'AGENTS.md': 'Agents instructions\n',
      'CLAUDE.md': 'Claude instructions\n',
      '.pi/SYSTEM.md': 'System prompt\n',
    }),
  });

  assert.ok(pi);
  assert.match(UNATTENDED_INSTRUCTION, /no human will answer/);
  for (const instruction of [UNATTENDED_INSTRUCTION, revisionInstruction([])]) {
    assert.match(instruction, /only the scoped local commands AGENTS\.md lists/);
    assert.match(instruction, /never the full `make check-no-vm`/);
    assert.match(instruction, /one line naming the local commands that passed.*"full suite: CI"/);
    assert.match(
      instruction,
      /required scoped command is killed or cannot run, stop and report that instead of running a narrower or different check/,
    );
    assert.doesNotMatch(instruction, /choose a narrower check/);
  }
  const root = realpathSync(pi.cwd);
  const flags = [
    ...PI_CONTRACT,
    '-e',
    REASONING_EXTENSION,
    '-e',
    REQUEST_RECORD_EXTENSION,
    '--skill',
    join(root, '.claude', 'skills'),
    '--skill',
    join(root, '.pi', 'skills'),
    '--system-prompt',
    join(root, '.pi', 'SYSTEM.md'),
    ...projectInstructions(join(root, 'AGENTS.md')),
    '--append-system-prompt',
    UNATTENDED_INSTRUCTION,
    '--append-system-prompt',
    NARRATION_INSTRUCTION,
  ];
  assert.deepEqual(pi.argv, [
    ...flags,
    '-e',
    EXTENSION,
    `/skill:work-on ${TICKET_URL}`,
  ]);
  assert.deepEqual(childArgv(pi).slice(1), flags);
});

test('given a checkout root with only CLAUDE.md, .agents/skills and .pi/APPEND_SYSTEM.md, when the workload starts, then CLAUDE.md is framed as project instructions and the append file is passed before it, with no system prompt file', async () => {
  const { pi } = await dispatch({
    origin: originWith({
      '.agents/skills/work-on/SKILL.md': SKILL,
      'CLAUDE.md': 'Claude instructions\n',
      '.pi/APPEND_SYSTEM.md': 'Appended\n',
    }),
  });

  assert.ok(pi);
  const root = realpathSync(pi.cwd);
  assert.deepEqual(pi.argv, [
    ...PI_CONTRACT,
    '-e',
    REASONING_EXTENSION,
    '-e',
    REQUEST_RECORD_EXTENSION,
    '--skill',
    join(root, '.agents', 'skills'),
    '--append-system-prompt',
    join(root, '.pi', 'APPEND_SYSTEM.md'),
    ...projectInstructions(join(root, 'CLAUDE.md')),
    '--append-system-prompt',
    UNATTENDED_INSTRUCTION,
    '--append-system-prompt',
    NARRATION_INSTRUCTION,
    '-e',
    EXTENSION,
    `/skill:work-on ${TICKET_URL}`,
  ]);
});

const notLoaded = (journal: string): string[] =>
  [...journal.matchAll(/the checkout's (\S+) is not loaded by forge/g)].map(
    ([, path]) => path ?? '',
  );

test('given a checkout root with .pi/settings.json and .pi/extensions beside .pi/skills and .pi/SYSTEM.md, or with .pi/mcp.json, .pi/prompts and .pi/themes, when the workload starts, then the run output warns that each of those project pi files is not loaded, names nothing else, and the run proceeds', async () => {
  const runs = [];
  for (const files of [
    {
      '.pi/settings.json': '{}\n',
      '.pi/extensions/local.ts': 'export default function () {}\n',
      '.pi/skills/review/SKILL.md': SKILL.replace('work-on', 'review'),
      '.pi/SYSTEM.md': 'System prompt\n',
    },
    {
      '.pi/mcp.json': '{}\n',
      '.pi/prompts/review.md': 'Review it.\n',
      '.pi/themes/dark.json': '{}\n',
      '.pi/APPEND_SYSTEM.md': 'Appended\n',
    },
  ]) {
    runs.push(
      await journaled(() =>
        dispatch({
          origin: originWith({
            '.claude/skills/work-on/SKILL.md': SKILL,
            ...files,
          }),
        }),
      ),
    );
  }

  assert.deepEqual(
    runs.map(({ journal }) => notLoaded(journal)),
    [
      ['.pi/settings.json', '.pi/extensions'],
      ['.pi/mcp.json', '.pi/prompts', '.pi/themes'],
    ],
  );
  assert.deepEqual(
    runs.map(({ result }) => [result.code, result.pi?.argv.at(-1)]),
    [
      [0, `/skill:work-on ${TICKET_URL}`],
      [0, `/skill:work-on ${TICKET_URL}`],
    ],
  );
});

test('given a worker prompt /work-on {url} and a checkout with no work-on skill, when forge-dispatch runs, then pi never starts, the run records that the skill was not found, and the ticket becomes forge:failed with skill not found as the reason', async () => {
  const { code, runs, pi, labelWrites, dispatches } = await journaled(() =>
    dispatch({
      origin: originWith({
        '.pi/skills/review/SKILL.md': SKILL.replace('work-on', 'review'),
      }),
      pullRequests: closing('no-pull-request'),
    }),
  ).then(({ result }) => result);

  assert.equal(code, 1);
  assert.equal(pi, null);
  const [run] = runs;
  assert.equal(run?.status, 'error');
  assert.equal(run?.error, "skill 'work-on' not found in the checkout");
  assert.equal(run?.ticket?.number, 113);
  assert.deepEqual(
    labelWrites.slice(2),
    finalLabelWrites('forge:failed').map((write) => ({ ...write, piStarted: false })),
  );
  assert.deepEqual(
    dispatches.map(({ state, reason, detail }) => ({ state, reason, detail })),
    [{ state: 'failed', reason: 'skill-not-found', detail: "skill 'work-on' not found in the checkout" }],
  );
});

test('given a checkout whose skills directory and AGENTS.md are symlinks to outside the checkout, when forge-dispatch runs, then neither is passed and the work-on skill they would bring is not found', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'forge-outside-'));
  mkdirSync(join(outside, 'skills', 'work-on'), { recursive: true });
  writeFileSync(join(outside, 'skills', 'work-on', 'SKILL.md'), SKILL);
  writeFileSync(join(outside, 'AGENTS.md'), 'Outside instructions\n');

  const { runs, pi } = await journaled(() =>
    dispatch({
      origin: originWith(
        {},
        {
          '.claude/skills': join(outside, 'skills'),
          'AGENTS.md': join(outside, 'AGENTS.md'),
        },
      ),
    }),
  ).then(({ result }) => result);

  assert.equal(pi, null);
  assert.equal(runs[0]?.error, "skill 'work-on' not found in the checkout");
});

test('given worker prompts using the {repo}, {issue} and {url} placeholders, with and without a leading skill command, when forge-dispatch runs, then each placeholder is filled for the ticket and only the leading command becomes a pi skill command', async () => {
  const withCommand = await dispatch({ prompt: '/work-on {repo}#{issue} at {url}' });
  const withoutCommand = await dispatch({ prompt: 'Build {repo}#{issue}: {url}' });

  assert.equal(
    withCommand.pi?.argv.at(-1),
    `/skill:work-on rameezk/forge#113 at ${TICKET_URL}`,
  );
  assert.equal(
    withoutCommand.pi?.argv.at(-1),
    `Build rameezk/forge#113: ${TICKET_URL}`,
  );
});

test('given a repository whose clone fails, when forge-dispatch runs, then pi never starts, the run records why git could not clone it, and the ticket fails because the run errored', async () => {
  const origin = { path: join(tmpdir(), 'forge-origin-missing'), tip: '' };

  const { code, runs, pi, dispatches } = await journaled(() =>
    dispatch({ origin, pullRequests: closing('no-pull-request') }),
  ).then(({ result }) => result);

  assert.equal(code, 1);
  assert.equal(pi, null);
  assert.equal(runs[0]?.status, 'error');
  assert.match(runs[0]?.error ?? '', /^git could not clone rameezk\/forge: /);
  assert.equal(dispatches[0]?.state, 'failed');
  assert.equal(dispatches[0]?.reason, 'errored');
  assert.equal(dispatches[0]?.detail, runs[0]?.error);
});

test('given an issue GitHub cannot find and a repository that is not declared, when forge-dispatch runs for each, then it fails naming the problem', async () => {
  await assert.rejects(
    dispatch({ issue: 99999, responses: { 99999: recorded('missing-ticket') } }),
    /GitHub rejected the Ticket query for rameezk\/forge#99999: Could not resolve to an Issue with the number of 99999\./,
  );
  await assert.rejects(
    dispatch({ repository: 'elsewhere' }),
    /unknown repository 'elsewhere'/,
  );
});

test('given an installed repository, when forge-dispatch runs, then every GitHub call forge makes uses a write token minted for that repository, and the workload gets its own token from a file and nothing else', async () => {
  const { requests, labelWrites, pi, app } = await dispatch();

  assert.deepEqual(
    new Set([...requests, ...labelWrites].map((request) => request.authorization)),
    new Set([`bearer ${WRITE_TOKEN}`, `bearer ${WRITE_TOKEN_AFTER}`]),
  );
  assert.ok(pi);
  assert.equal(pi.githubTokenFileContents, WORKLOAD_TOKEN);
  assert.equal(pi.githubToken, undefined);
  assert.equal(pi.nodeOptions, undefined);
  assert.deepEqual(
    app.mints.map(({ kind, repository }) => `${kind} ${repository}`),
    ['read rameezk/forge', 'write rameezk/forge', 'workload rameezk/forge', 'write rameezk/forge'],
  );
});

test('given a dispatched workload, when its token is minted, then it is scoped to its own repository alone with the workload permissions', async () => {
  const { app } = await dispatch();

  const [workload, ...others] = app.mints.filter((mint) => mint.kind === 'workload');
  assert.deepEqual(others, []);
  assert.deepEqual(workload?.body, {
    repositories: ['forge'],
    permissions: {
      contents: 'write',
      issues: 'write',
      pull_requests: 'write',
      workflows: 'write',
      checks: 'read',
      actions: 'read',
    },
  });
});

test('given a runner whose own environment holds its git config, the write-token file and more, when a ticket is dispatched, then the harness environment holds only the system settings, its HOME, the OpenRouter key, the path of the write-token file, the git identity and credential helper, the NixOS environment marker, and pi\'s own variables', async () => {
  const { bwrap } = await dispatch({
    env: { NODE_OPTIONS: '--require /var/lib/forge/planted.js' },
  });

  assert.ok(bwrap);
  assert.deepEqual(Object.keys(bwrap.env).sort(), [
    'FORGE_GITHUB_TOKEN_FILE',
    'FORGE_PI_REQUEST_RECORD_FD',
    'FORGE_PI_SUBAGENT_INVOCATION',
    'GIT_AUTHOR_EMAIL',
    'GIT_AUTHOR_NAME',
    'GIT_COMMITTER_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_KEY_1',
    'GIT_CONFIG_VALUE_0',
    'GIT_CONFIG_VALUE_1',
    'HOME',
    'OPENROUTER_API_KEY',
    'PATH',
    'PI_CODING_AGENT_DIR',
    '__NIXOS_SET_ENVIRONMENT_DONE',
  ]);
  assert.equal(bwrap.env.GIT_CONFIG_COUNT, '2');
  assert.equal(bwrap.env.GITHUB_TOKEN, undefined);
});

test('given a dispatched workload, when pi starts, then git authenticates with the write token read from a file the sandbox binds read-only, and the file is gone once the run ends', async () => {
  const { pi, bwrap } = await dispatch();

  assert.ok(pi);
  assert.ok(bwrap);
  assert.ok(pi.githubTokenFile);
  assert.equal(pi.githubTokenFileContents, WORKLOAD_TOKEN);
  assert.match(pi.credential ?? '', /^username=x-access-token$/m);
  assert.match(pi.credential ?? '', new RegExp(`^password=${WORKLOAD_TOKEN}$`, 'm'));
  const dir = dirname(pi.githubTokenFile);
  const binds = bwrap.argv.flatMap((arg, index) =>
    bwrap.argv[index - 1] === '--ro-bind' && bwrap.argv[index + 1] === dir ? [arg] : [],
  );
  assert.deepEqual(binds, [dir]);
  assert.equal(existsSync(dir), false);
});

test('given no GitHub App id, or no private key, when forge-dispatch runs, then it fails naming what is missing without asking GitHub for anything', async () => {
  for (const [scenario, missing] of [
    [{ appId: null }, /GitHub App id missing/],
    [{ privateKey: null }, /GitHub App private key missing/],
    [{ privateKey: '' }, /GitHub App private key missing/],
  ] as const) {
    await assert.rejects(dispatch(scenario), missing);
  }
});

test('given a repository the GitHub App is not installed on, when forge-dispatch runs, then it fails saying so, without claiming the ticket or starting a workload', async () => {
  const { failure, labelWrites, pi, app } = await dispatch({ installed: [], failing: true });

  assert.match(String(failure), /the GitHub App is not installed on rameezk\/forge/);
  assert.deepEqual(labelWrites, []);
  assert.equal(pi, null);
  assert.deepEqual(app.mints, []);
});

test('given a workload that outlives its token, when forge-dispatch runs, then the token file is replaced before the token expires, git authenticates with the newer token, and every token minted is redacted from the transcript', async () => {
  const first = tokenFor('workload', 'rameezk/forge', 1);
  const second = tokenFor('workload', 'rameezk/forge', 2);

  const { pi, piLater, app, transcript } = await dispatch({
    lifetimeSeconds: 2,
    piLingerMs: 3500,
  });

  assert.equal(pi?.githubTokenFileContents, first);
  assert.ok(piLater);
  assert.notEqual(piLater.githubTokenFileContents, first);
  assert.match(piLater.credential, new RegExp(`^password=${piLater.githubTokenFileContents}$`, 'm'));
  assert.ok(app.mints.filter((mint) => mint.kind === 'workload').length >= 2);
  assert.match(transcript, /token \[redacted\]/);
  assert.ok(!transcript.includes(first) && !transcript.includes(second));
});

test('given a runner whose inherited GIT_CONFIG_COUNT is not a count, when forge-dispatch runs, then it fails naming it without claiming the ticket or starting a workload', async () => {
  for (const count of ['two', '-1', '1.5', '01']) {
    const { failure, labelWrites, pi } = await dispatch({
      env: { GIT_CONFIG_COUNT: count },
      failing: true,
    });

    assert.match(String(failure), /GIT_CONFIG_COUNT/, count);
    assert.deepEqual(labelWrites, [], count);
    assert.equal(pi, null, count);
  }
});

test('given an agent that reads the GitHub token from the state directory and repeats it, when forge-dispatch runs, then the transcript carries it redacted', async () => {
  const piOutput = join(mkdtempSync(join(tmpdir(), 'forge-output-')), 'pi.jsonl');
  writeFileSync(
    piOutput,
    readFileSync(PI_OUTPUT, 'utf8').replaceAll('All done.', `All done. ${WORKLOAD_TOKEN}`),
  );

  const { transcript } = await dispatch({ piOutput });

  assert.match(transcript, /All done\. \[redacted\]/);
  assert.ok(!transcript.includes(WORKLOAD_TOKEN));
});

test('given work-on skill directories that pi would not load as work-on, because their frontmatter names another skill or gives no description, when forge-dispatch runs, then pi never starts and the skill is not found, while one naming itself only by its directory is found', async () => {
  for (const skill of [
    '---\nname: other\ndescription: Drive one ticket.\n---\n',
    '---\nname: work-on\n---\n',
    '---\nname: work-on\ndescription: ""\n---\n',
    'No frontmatter at all.\n',
  ]) {
    const { pi, runs } = await journaled(() =>
      dispatch({ origin: originWith({ '.claude/skills/work-on/SKILL.md': skill }) }),
    ).then(({ result }) => result);

    assert.equal(pi, null, skill);
    assert.equal(runs[0]?.error, "skill 'work-on' not found in the checkout", skill);
  }

  const { pi } = await dispatch({
    origin: originWith({
      '.claude/skills/work-on/SKILL.md': "---\ndescription: 'Drive one ticket.'\n---\n",
    }),
  });
  assert.equal(pi?.argv.at(-1), `/skill:work-on ${TICKET_URL}`);
});

test('given a checkout with two different files pi would load as work-on, from two skill directories, from a differently named directory, from a nested directory, from a markdown file at a skill directory root, or from below a SKILL.md an ignore file hides, when forge-dispatch runs, then pi never starts and the run names both files', async () => {
  const other = SKILL.replace('Work on it.', 'Work on it differently.');
  for (const [files, paths] of [
    [
      { '.claude/skills/work-on/SKILL.md': SKILL, '.pi/skills/work-on/SKILL.md': other },
      '.claude/skills/work-on/SKILL.md, .pi/skills/work-on/SKILL.md',
    ],
    [
      { '.claude/skills/work-on/SKILL.md': SKILL, '.agents/skills/drive/SKILL.md': other },
      '.agents/skills/drive/SKILL.md, .claude/skills/work-on/SKILL.md',
    ],
    [
      { '.claude/skills/work-on/SKILL.md': SKILL, '.claude/skills/team/drive/SKILL.md': other },
      '.claude/skills/team/drive/SKILL.md, .claude/skills/work-on/SKILL.md',
    ],
    [
      { '.claude/skills/work-on/SKILL.md': SKILL, '.pi/skills/work-on.md': other },
      '.claude/skills/work-on/SKILL.md, .pi/skills/work-on.md',
    ],
    [
      {
        '.claude/skills/.ignore': 'decoy/SKILL.md\n',
        '.claude/skills/decoy/SKILL.md': SKILL.replace('work-on', 'decoy'),
        '.claude/skills/decoy/real/SKILL.md': other,
        '.pi/skills/work-on/SKILL.md': SKILL,
      },
      '.claude/skills/decoy/real/SKILL.md, .pi/skills/work-on/SKILL.md',
    ],
  ] as const) {
    const { pi, runs } = await journaled(() =>
      dispatch({ origin: originWith(files) }),
    ).then(({ result }) => result);

    assert.equal(pi, null, paths);
    assert.equal(
      runs[0]?.error,
      `skill 'work-on' is ambiguous in the checkout: ${paths}`,
    );
  }
});

test('given a checkout whose work-on skill appears in two skill directories through a symlink to one file, once under a directory named differently from it, or beside a dot file pi skips that also names itself work-on, when forge-dispatch runs, then pi starts with /skill:work-on', async () => {
  for (const origin of [
    originWith(
      { '.agents/skills/work-on/SKILL.md': SKILL },
      { '.claude/skills/work-on': '../../.agents/skills/work-on' },
    ),
    originWith({ '.agents/skills/drive/SKILL.md': SKILL }),
    originWith({
      '.agents/skills/work-on/SKILL.md': SKILL,
      '.agents/skills/.draft.md': SKILL.replace('Work on it.', 'Draft.'),
    }),
  ]) {
    const { pi } = await dispatch({ origin });

    assert.equal(pi?.argv.at(-1), `/skill:work-on ${TICKET_URL}`);
  }
});

test('given a skill whose frontmatter name is a number, when forge-dispatch runs a prompt naming its directory, then pi starts with that skill command, as pi names it by its directory', async () => {
  const { pi } = await dispatch({
    origin: originWith({
      '.claude/skills/123/SKILL.md': '---\nname: 123\ndescription: Numbered.\n---\n',
    }),
    prompt: '/123 {url}',
  });

  assert.equal(pi?.argv.at(-1), `/skill:123 ${TICKET_URL}`);
});

test('given a checkout with a link under a skill directory that resolves outside the checkout, directly or through a directory elsewhere in the checkout, when forge-dispatch runs, then pi never starts and the run names the link', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'forge-outside-'));
  writeFileSync(join(outside, 'notes.md'), 'Outside notes\n');

  for (const [origin, link] of [
    [
      originWith(
        { '.claude/skills/work-on/SKILL.md': SKILL },
        { '.claude/skills/work-on/notes.md': join(outside, 'notes.md') },
      ),
      '.claude/skills/work-on/notes.md',
    ],
    [
      originWith(
        { '.claude/skills/work-on/SKILL.md': SKILL, 'docs/README.md': 'Docs\n' },
        {
          '.claude/skills/shared': '../../docs',
          'docs/outside': outside,
        },
      ),
      '.claude/skills/shared/outside',
    ],
  ] as const) {
    const { pi, runs } = await journaled(() => dispatch({ origin })).then(
      ({ result }) => result,
    );

    assert.equal(pi, null, link);
    assert.equal(
      runs[0]?.error,
      `'${link}' in the checkout's skills links outside the checkout`,
    );
  }
});

test('given a checkout whose skill directory links to a directory that itself holds a directory link, once or in a loop back to itself, when forge-dispatch runs, then pi never starts and the run names the inner link', async () => {
  for (const [origin, link] of [
    [
      originWith(
        {
          '.claude/skills/work-on/SKILL.md': SKILL,
          'docs/skills/review/SKILL.md': SKILL.replace('work-on', 'review'),
        },
        {
          '.claude/skills/shared': '../../docs/skills',
          'docs/skills/again': 'review',
        },
      ),
      '.claude/skills/shared/again',
    ],
    [
      originWith(
        { '.claude/skills/work-on/SKILL.md': SKILL },
        {
          '.claude/skills/loop/p': '..',
          '.claude/skills/loop/q': '..',
          '.claude/skills/loop/r': '..',
        },
      ),
      '.claude/skills/loop/p/loop/p',
    ],
  ] as const) {
    const { pi, runs } = await journaled(() => dispatch({ origin })).then(
      ({ result }) => result,
    );

    assert.equal(pi, null, link);
    assert.equal(
      runs[0]?.error,
      `'${link}' in the checkout's skills links to a directory from inside a linked directory`,
    );
  }
});

test('given a checkout where a second file named work-on is reached through two links, when forge-dispatch runs, then the run names each distinct file once', async () => {
  const { pi, runs } = await journaled(() =>
    dispatch({
      origin: originWith(
        {
          '.claude/skills/work-on/SKILL.md': SKILL,
          '.agents/skills/drive/SKILL.md': SKILL.replace('Work on it.', 'Drive it.'),
        },
        { '.pi/skills/drive': '../../.agents/skills/drive' },
      ),
    }),
  ).then(({ result }) => result);

  assert.equal(pi, null);
  assert.equal(
    runs[0]?.error,
    "skill 'work-on' is ambiguous in the checkout: .agents/skills/drive/SKILL.md, .claude/skills/work-on/SKILL.md",
  );
});

test('given a worker prompt whose skill command is followed by a newline rather than a space, when forge-dispatch runs, then pi never starts, as pi would not expand it', async () => {
  const { pi, runs } = await journaled(() =>
    dispatch({ prompt: '/work-on\n{url}' }),
  ).then(({ result }) => result);

  assert.equal(pi, null);
  assert.equal(
    runs[0]?.error,
    `skill 'work-on\n${TICKET_URL}' not found in the checkout`,
  );
});

test('given a checkout where two skill-directory links reach the same directory, or one reaches inside the other, when forge-dispatch runs, then pi never starts and the run names the second link', async () => {
  for (const [links, link] of [
    [
      {
        '.claude/skills/first': '../../docs/skills',
        '.claude/skills/second': '../../docs/skills',
      },
      '.claude/skills/second',
    ],
    [
      {
        '.claude/skills/first': '../../docs/skills',
        '.pi/skills/second': '../../docs/skills/review',
      },
      '.pi/skills/second',
    ],
  ] as const) {
    const { pi, runs } = await journaled(() =>
      dispatch({
        origin: originWith(
          {
            '.claude/skills/work-on/SKILL.md': SKILL,
            'docs/skills/review/SKILL.md': SKILL.replace('work-on', 'review'),
          },
          links,
        ),
      }),
    ).then(({ result }) => result);

    assert.equal(pi, null, link);
    assert.equal(
      runs[0]?.error,
      `'${link}' in the checkout's skills links to a directory another link already reaches`,
    );
  }
});

test('given a checkout whose .claude/skills links to .agents/skills, which links a skill in from elsewhere in the checkout, when forge-dispatch runs, then pi starts with that skill directory passed once', async () => {
  const { pi } = await dispatch({
    origin: originWith(
      { 'docs/work-on/SKILL.md': SKILL, '.agents/skills/README.md': 'Skills\n' },
      {
        '.claude/skills': '../.agents/skills',
        '.agents/skills/work-on': '../../docs/work-on',
      },
    ),
  });

  assert.equal(pi?.argv.at(-1), `/skill:work-on ${TICKET_URL}`);
  assert.deepEqual(
    pi?.argv.filter((arg, i) => pi.argv[i - 1] === '--skill').map((path) => relative(pi.cwd, path)),
    ['.claude/skills'],
  );
});

const runPage = async (stateDir: string, runId: string, view = ''): Promise<string> => {
  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    const app = createApp({
      store,
      transcripts: new FileTranscriptSource(join(stateDir, 'transcripts')),
      css: '',
      logo: '',
      idiomorph: '',
      client: '',
    });
    const response = await app.request(`/runs/${runId}${view}`);
    assert.equal(response.status, 200);
    return await response.text();
  } finally {
    store.close();
  }
};

const skillsOf = (page: string): [string, string][] =>
  [...page.matchAll(/<li[^>]*data-skill="([^"]+)"[^>]*>[\s\S]*?data-skill-where[^>]*>([^<]*)</g)].map(
    ([, name = '', where = '']) => [name, where.trim()],
  );

test('given a worker whose prompt starts /work-on, when the run finishes, then its run page lists work-on in the Skills section as loaded from the prompt', async () => {
  const { stateDir, runs } = await dispatch();

  const page = await runPage(stateDir, (runs[0] as RunRecord).id);

  assert.deepEqual(skillsOf(page), [['work-on', 'prompt']]);
});

const SKILL_LOADS = join(import.meta.dirname, 'fixtures', 'pi', 'skill-loads.jsonl');

const skillLoadsRun = (): Promise<Outcome> =>
  dispatch({
    origin: originWith(SKILL_FILES),
    prompt: REVIEWING_PROMPT,
    piOutput: SKILL_LOADS,
  });

test('given a parent that reads the same SKILL.md twice, then a file the skill references, and cats a SKILL.md through bash, when the run page is opened, then the skill shows one parent load and nothing else is a load', async () => {
  const { stateDir, runs } = await skillLoadsRun();

  const page = await runPage(stateDir, (runs[0] as RunRecord).id);

  assert.deepEqual(skillsOf(page), [
    ['code-review', '1 subagent'],
    ['security-review', '2 subagents'],
    ['work-on', 'parent'],
  ]);
});

test('given review subagents that read code-review once and a skill whose directory is not its frontmatter name in two separate subagents, when the run page is opened, then each skill shows the subagents that loaded it under its frontmatter name', async () => {
  const { stateDir, runs } = await skillLoadsRun();

  const page = await runPage(stateDir, (runs[0] as RunRecord).id);

  assert.deepEqual(skillsOf(page).slice(0, 2), [
    ['code-review', '1 subagent'],
    ['security-review', '2 subagents'],
  ]);
});

const SKILL_COVERAGE = join(import.meta.dirname, 'fixtures', 'pi', 'skill-coverage.jsonl');

const skillCoverageRun = (): Promise<Outcome> =>
  dispatch({
    origin: originWith(COVERAGE_SKILL_FILES),
    prompt: COVERAGE_PROMPT,
    piOutput: SKILL_COVERAGE,
  });

const partialsOf = (page: string): [string, string][] =>
  [...page.matchAll(/<li[^>]*data-skill="([^"]+)"[^>]*>[\s\S]*?<\/li>/g)].flatMap(
    ([item = '', name = '']) =>
      [...item.matchAll(/data-skill-partial[^>]*>([^<]*)</g)].map(
        ([, badge = '']): [string, string] => [name, badge.trim()],
      ),
  );

test('given a subagent that reads only the first 60 lines of a 142-line SKILL.md, when the run page is opened, then that load shows partial 60/142', async () => {
  const { stateDir, runs } = await skillCoverageRun();

  const page = await runPage(stateDir, (runs[0] as RunRecord).id);

  assert.deepEqual(partialsOf(page), [['code-review', 'partial · 60/142']]);
});

test('given a parent that reads a SKILL.md as lines 1-60 and then from line 61 to the end, when the run page is opened, then the skill shows one parent load with no partial badge', async () => {
  const { stateDir, runs } = await skillCoverageRun();

  const page = await runPage(stateDir, (runs[0] as RunRecord).id);

  assert.deepEqual(
    skillsOf(page).filter(([name]) => name === 'work-on'),
    [['work-on', 'parent']],
  );
  assert.equal(
    partialsOf(page).some(([name]) => name === 'work-on'),
    false,
  );
});

test('given a parent that reads a 2500-line SKILL.md in one call that pi cuts off at 2000 lines, when the run page is opened, then that load shows partial 2000/2500', async () => {
  const { stateDir, runs } = await dispatch({
    origin: originWith(TRUNCATED_SKILL_FILES),
    prompt: TRUNCATED_PROMPT,
    piOutput: join(import.meta.dirname, 'fixtures', 'pi', 'skill-truncated.jsonl'),
  });

  const page = await runPage(stateDir, (runs[0] as RunRecord).id);

  assert.deepEqual(partialsOf(page), [['work-on', 'partial · 2000/2500']]);
});

test('given a worker whose prompt starts /work-on, when the run page is opened, then work-on shows no partial badge', async () => {
  const { stateDir, runs } = await dispatch({
    origin: originWith(COVERAGE_SKILL_FILES),
  });

  const page = await runPage(stateDir, (runs[0] as RunRecord).id);

  assert.deepEqual(skillsOf(page), [['work-on', 'prompt']]);
  assert.deepEqual(partialsOf(page), []);
});

const subagentKinds = (page: string): string[][] =>
  (page.match(/<section[^>]*\sdata-subagent-call[\s>][\s\S]*?<\/section>/g) ?? []).map((card) =>
    [...card.slice(0, card.indexOf('</summary>')).matchAll(/data-subagent-kind>([^<]*)</g)].map(
      ([, kind = '']) => kind.trim(),
    ),
  );

test('given a run whose agent spawned one subagent reading code-review and two reading security-review, when the full transcript page is opened, then each subagent header carries the chip for its skill', async () => {
  const { stateDir, runs } = await skillLoadsRun();

  const page = await runPage(stateDir, (runs[0] as RunRecord).id, '/transcript');

  assert.deepEqual(subagentKinds(page), [
    ['code-review'],
    ['security-review'],
    ['security-review'],
  ]);
});

test('given a run whose subagents load no skill, when the full transcript page is opened, then each subagent header shows unclassified', async () => {
  const { stateDir, runs } = await dispatch({
    prompt: SUBAGENTS_PROMPT,
    piOutput: join(import.meta.dirname, 'fixtures', 'pi', 'subagents.jsonl'),
  });

  const page = await runPage(stateDir, (runs[0] as RunRecord).id, '/transcript');

  assert.deepEqual(subagentKinds(page), [['unclassified'], ['unclassified']]);
});

const fingerprintOf = ({ stateDir, runs }: Outcome): RunFingerprint | null => {
  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    return store.getFingerprint((runs[0] as RunRecord).id);
  } finally {
    store.close();
  }
};

test('given a ticket dispatched into a clone of a managed repository whose worker prompt has placeholders, when it runs, then its fingerprint holds the unfilled prompt template and a skills hash, and records the clone\'s commit as its base commit', async () => {
  const outcome = await dispatch({
    prompt: '/work-on {url}',
    env: { FORGE_GIT_SHA: 'abc1234' },
  });

  const recorded = fingerprintOf(outcome);

  assert.equal(recorded?.baseCommit, outcome.origin.tip);
  assert.equal(recorded?.forgeGitSha, 'abc1234');
  assert.equal(recorded?.fingerprint.promptTemplate, sha256('/work-on {url}'));
  assert.equal(typeof recorded?.fingerprint.skills, 'string');
});

test('given two repositories whose skill files differ in one skill, and a third whose skill files match the first, when each is dispatched, then the first and third share a fingerprint hash and the second differs', async () => {
  const skills = (extra: string) => ({
    '.claude/skills/work-on/SKILL.md': SKILL,
    '.claude/skills/work-on/notes.md': extra,
  });
  const first = fingerprintOf(await dispatch({ origin: originWith(skills('one\n')) }));
  const changed = fingerprintOf(await dispatch({ origin: originWith(skills('two\n')) }));
  const same = fingerprintOf(await dispatch({ origin: originWith(skills('one\n')) }));

  assert.ok(first && changed && same);
  assert.notEqual(first.hash, changed.hash);
  assert.equal(first.hash, same.hash);
});

test('given a checkout whose skills directory holds a dangling symlink, when the ticket is dispatched, then the workload runs and its fingerprint is recorded', async () => {
  const outcome = await dispatch({
    origin: originWith(
      { '.claude/skills/work-on/SKILL.md': SKILL },
      { '.claude/skills/dangling': '/nonexistent/skill' },
    ),
  });

  assert.equal(outcome.runs[0]?.status, 'success');
  assert.equal(typeof fingerprintOf(outcome)?.fingerprint.skills, 'string');
});

const polledTicket = (store: Store): void =>
  store.replaceFrontier({
    repository: 'forge',
    github: 'rameezk/forge',
    polledAt: new Date().toISOString(),
    requests: [],
    tickets: [
      { number: 113, title: 'Ticket', url: TICKET_URL, parent: null, createdAt: '2026-09-28T10:07:58Z', forgeReady: true, forHuman: false, blocked: false, blockedBy: [] },
    ],
  });

const workPage = async (stateDir: string): Promise<string> => {
  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    const app = createApp({
      store,
      transcripts: new FileTranscriptSource(join(stateDir, 'transcripts')),
      css: '',
      logo: '',
      idiomorph: '',
      client: '',
    });
    const response = await app.request('/');
    assert.equal(response.status, 200);
    return await response.text();
  } finally {
    store.close();
  }
};

const cardOf = (page: string, number: number): { html: string; text: string } => {
  const html = new RegExp(`<article[^>]*data-ticket="${number}"[\\s\\S]*?</article>`).exec(page)?.[0] ?? '';
  return { html, text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() };
};

const BAD_CREDENTIALS = 'GitHub answered 401: Bad credentials';

test('given a forge:ready ticket and a GitHub that answers the bot user lookup with 401 Bad credentials, when forge-dispatch runs for it, then the work page shows the ticket failed with Did not start and the error, with no run link and no attempts link', async () => {
  const { failure, stateDir, pi, runs } = await dispatch({
    rejectBotLookup: true,
    failing: true,
    seed: polledTicket,
  });

  const card = cardOf(await workPage(stateDir), 113);

  assert.match(String(failure), new RegExp(BAD_CREDENTIALS));
  assert.equal(pi, null);
  assert.deepEqual(runs, []);
  assert.match(card.text, new RegExp(`Did not start: ${BAD_CREDENTIALS}`));
  assert.doesNotMatch(card.html, /href="\/runs\/|data-attempts/);
});

test('given a ticket whose latest dispatch is a failed start, when forge-dispatch fails to start it again several times, then the work page still shows one failed dispatch reading Did not start with the count, the time of the last one and the latest error', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-dispatch-'));
  await dispatch({ stateDir, rejectBotLookup: true, failing: true, seed: polledTicket });
  assert.doesNotMatch(cardOf(await workPage(stateDir), 113).text, /times/);

  for (let attempt = 0; attempt < 2; attempt++) {
    await dispatch({ stateDir, rejectBotLookup: true, failing: true });
  }

  const board = await workPage(stateDir);
  const card = cardOf(board, 113);
  assert.equal(board.match(/data-ticket="113"/g)?.length, 1);
  assert.match(card.text, new RegExp(`Did not start \\(3 times, last \\S+(?: \\S+)? ago\\): ${BAD_CREDENTIALS}$`));
  assert.match(card.html, /data-elapsed-since="\d{4}-/);
  assert.doesNotMatch(card.html, /href="\/runs\/|data-attempts/);
});

test('given a ticket whose latest dispatch is a failed start, when the cause is fixed and forge-dispatch runs again, then the failed start is gone from the work page and the ticket links to its attempt', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-dispatch-'));
  await dispatch({ stateDir, rejectBotLookup: true, failing: true, seed: polledTicket });

  const { dispatches } = await dispatch({ stateDir });

  const card = cardOf(await workPage(stateDir), 113);
  assert.equal(dispatches.length, 1);
  assert.notEqual(dispatches[0]?.reason, 'not-started');
  assert.notEqual(dispatches[0]?.runId, null);
  assert.equal(dispatches[0]?.failedStarts, null);
  assert.doesNotMatch(card.text, /Did not start/);
  assert.match(card.html, /data-attempts/);
});

test('given a ticket that is no longer dispatchable when forge-dispatch checks it, when it runs for it, then no dispatch is recorded and the work page shows nothing new for it', async () => {
  const { code, dispatches, stateDir } = await dispatch({
    responses: { 113: recorded('frontier-ticket') },
    seed: polledTicket,
  });

  const card = cardOf(await workPage(stateDir), 113);

  assert.equal(code, 1);
  assert.deepEqual(dispatches, []);
  assert.doesNotMatch(card.text, /Did not start/);
});
