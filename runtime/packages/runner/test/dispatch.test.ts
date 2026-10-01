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
import { Store, type DispatchRecord, type RunRecord } from '@forge/shared';
import { main } from '../src/dispatch-main.ts';
import { journaled, PI_CONTRACT, lockedPiPackage, writeFakePi } from './helpers.ts';

const GITHUB_FIXTURES = join(import.meta.dirname, 'fixtures', 'github');

const PI_OUTPUT = join(import.meta.dirname, 'fixtures', 'pi', 'success.jsonl');

const PROVIDER_ERROR = join(import.meta.dirname, 'fixtures', 'pi', 'provider-error.jsonl');

const EXTENSION = join(import.meta.dirname, '..', '..', 'pi-subagent', 'src');

const AGENT_DIR = '/nix/store/00000000000000000000000000000000-pi-agent-dir';

const GITHUB_TOKEN = 'github_pat_test';

const TICKET_URL = 'https://github.com/rameezk/forge/issues/113';

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
  piRecord: () => string,
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
  piPackage?: string;
  failing?: boolean;
  seed?: (store: Store) => void;
  prompt?: string;
  tokenFile?: string | null;
  piOutput?: string;
}

interface PiCall {
  argv: string[];
  cwd: string;
  subagentInvocation: string | undefined;
  githubToken: string | undefined;
  nodeOptions: string | undefined;
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
  requests: GraphqlRequest[];
  labelWrites: LabelWrite[];
}

const dispatch = async (scenario: Scenario = {}): Promise<Outcome> => {
  const origin =
    scenario.origin ??
    originWith({ '.claude/skills/work-on/SKILL.md': SKILL });
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-dispatch-'));
  const record = join(stateDir, 'pi-call.json');
  const configPath = join(stateDir, 'runtime.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      harnesses: { pi: { command: writeFakePi(stateDir) } },
      workers: {
        builder: {
          harness: 'pi',
          model: 'z-ai/glm-5',
          prompt: scenario.prompt ?? '/work-on {url}',
        },
      },
      repositories: {
        forge: { github: 'rameezk/forge', worker: 'builder' },
      },
    }),
  );
  const tokenFile = join(stateDir, 'github-write.env');
  const tokenFileContents =
    scenario.tokenFile === undefined
      ? `GITHUB_TOKEN=${GITHUB_TOKEN}\n`
      : scenario.tokenFile;
  if (tokenFileContents !== null) {
    writeFileSync(tokenFile, tokenFileContents);
  }
  const github = fakeGithub(
    scenario.responses ?? {
      113: labelled(recorded('frontier-ticket'), FORGE_READY),
    },
    scenario.pullRequests ?? opened(closing('merged-pull-request')),
    scenario.running ?? labelledIssues([]),
    scenario.labelStatus ?? (() => 200),
    scenario.pullRequestsStatus ?? 200,
    () => record,
  );
  if (scenario.seed !== undefined) {
    const seeded = Store.open(join(stateDir, 'forge.db'));
    try {
      scenario.seed(seeded);
    } finally {
      seeded.close();
    }
  }

  let failure: unknown = null;
  const code = await main(
    [scenario.repository ?? 'forge', String(scenario.issue ?? 113)],
    {
      PATH: process.env.PATH,
      HOME: stateDir,
      FORGE_RUNTIME_CONFIG: configPath,
      FORGE_STATE_DIR: stateDir,
      FORGE_PI_SUBAGENT_EXTENSION: EXTENSION,
      FORGE_PI_AGENT_DIR: AGENT_DIR,
      FORGE_PI_PACKAGE: scenario.piPackage ?? lockedPiPackage(),
      FORGE_GITHUB_WRITE_TOKEN_FILE: tokenFile,
      GITHUB_TOKEN: 'github_pat_from_the_environment',
      OPENROUTER_API_KEY: 'sk-or-test',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${pathToFileURL(origin.path).href}.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/rameezk/forge.git',
      FAKE_PI_RECORD: record,
      FAKE_PI_OUTPUT: scenario.piOutput ?? PI_OUTPUT,
    },
    github.fetch,
  ).catch((error: unknown) => {
    if (scenario.failing !== true) throw error;
    failure = error;
    return 1;
  });

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
      requests: github.requests,
      labelWrites: github.labelWrites,
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
      authorization: `bearer ${GITHUB_TOKEN}`,
      variables: { owner: 'rameezk', name: 'forge', label: 'forge:running', first: 100, after: null },
    },
    {
      operation: 'Ticket',
      authorization: `bearer ${GITHUB_TOKEN}`,
      variables: { owner: 'rameezk', name: 'forge', number: 113 },
    },
    {
      operation: 'ClosingPullRequests',
      authorization: `bearer ${GITHUB_TOKEN}`,
      variables: { owner: 'rameezk', name: 'forge', number: 113 },
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

test('given a frontier ticket labelled forge:ready, when it is dispatched, then forge:running replaces forge:ready before the workload starts', async () => {
  const { labelWrites } = await dispatch();

  assert.deepEqual(labelWrites.slice(0, 2), [
    {
      method: 'POST',
      path: '/repos/rameezk/forge/issues/113/labels',
      authorization: `bearer ${GITHUB_TOKEN}`,
      body: { labels: ['forge:running'] },
      piStarted: false,
    },
    {
      method: 'DELETE',
      path: '/repos/rameezk/forge/issues/113/labels/forge%3Aready',
      authorization: `bearer ${GITHUB_TOKEN}`,
      body: null,
      piStarted: false,
    },
  ]);
});

const finalLabelWrites = (label: string): LabelWrite[] => [
  {
    method: 'POST',
    path: '/repos/rameezk/forge/issues/113/labels',
    authorization: `bearer ${GITHUB_TOKEN}`,
    body: { labels: [label] },
    piStarted: true,
  },
  {
    method: 'DELETE',
    path: '/repos/rameezk/forge/issues/113/labels/forge%3Arunning',
    authorization: `bearer ${GITHUB_TOKEN}`,
    body: null,
    piStarted: true,
  },
];

test('given a run after which an open pull request closes the ticket, when the run ends, whether it succeeded or errored, then the ticket becomes forge:done', async () => {
  for (const piOutput of [PI_OUTPUT, PROVIDER_ERROR]) {
    const { labelWrites, runs } = await dispatch({ piOutput });

    assert.deepEqual(labelWrites.slice(2), finalLabelWrites('forge:done'), piOutput);
    assert.equal(runs[0]?.status, piOutput === PI_OUTPUT ? 'success' : 'error');
  }
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

const forgeTicket = (number: number) => ({
  repository: 'forge',
  number,
  url: `https://github.com/rameezk/forge/issues/${number}`,
});

const interruptedLabelWrites = (number: number): LabelWrite[] => [
  {
    method: 'POST',
    path: `/repos/rameezk/forge/issues/${number}/labels`,
    authorization: `bearer ${GITHUB_TOKEN}`,
    body: { labels: ['forge:failed'] },
    piStarted: false,
  },
  {
    method: 'DELETE',
    path: `/repos/rameezk/forge/issues/${number}/labels/forge%3Arunning`,
    authorization: `bearer ${GITHUB_TOKEN}`,
    body: null,
    piStarted: false,
  },
  {
    method: 'DELETE',
    path: `/repos/rameezk/forge/issues/${number}/labels/forge%3Aready`,
    authorization: `bearer ${GITHUB_TOKEN}`,
    body: null,
    piStarted: false,
  },
];

test('given tickets labelled forge:running, one whose dispatch stopped beating, one with no dispatch in the store, and one with a live dispatch, when the next dispatch pass runs, then the first two become forge:failed with interrupted as the reason, losing any forge:ready a split claim left behind, and the live one is left alone', async () => {
  const { labelWrites, dispatches } = await dispatch({
    running: labelledIssues([114, 115, 123]),
    seed: (store) => {
      store.startDispatch(forgeTicket(114), 'run-stale', '2026-09-01T09:00:00.000Z');
      store.startDispatch(forgeTicket(123), 'run-live', new Date().toISOString());
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
        store.startDispatch(forgeTicket(113), 'run-live', new Date().toISOString());
      },
    }),
  );

  assert.equal(result.code, 1);
  assert.equal(result.pi, null);
  assert.deepEqual(result.runs, []);
  assert.deepEqual(result.labelWrites, []);
  assert.match(journal, /forge#113 is not dispatchable: it is already being dispatched/);
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
      const done = store.startDispatch(forgeTicket(114), 'run-114', at);
      const failed = store.startDispatch(forgeTicket(115), 'run-115', at);
      assert.ok(done !== null && failed !== null);
      store.endDispatch(done, { state: 'done' }, at);
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

test('given a ticket labelled forge:ready that has an open blocker, one that is closed, one that is not ready-for-agent, and a frontier ticket without the label, when forge-dispatch runs for each, then none starts a workload or clones, and each refusal names why', async () => {
  const cases = [
    { issue: 115, fixture: 'blocked-ticket', label: true, reason: /forge#115 is not dispatchable: it has open blockers/ },
    { issue: 109, fixture: 'closed-ticket', label: true, reason: /forge#109 is not dispatchable: it is closed/ },
    { issue: 112, fixture: 'spec-ticket', label: true, reason: /forge#112 is not dispatchable: it is not labelled ready-for-agent/ },
    { issue: 113, fixture: 'frontier-ticket', label: false, reason: /forge#113 is not dispatchable: it is not labelled forge:ready/ },
  ];
  for (const { issue, fixture, label, reason } of cases) {
    const response = label
      ? labelled(recorded(fixture), FORGE_READY)
      : recorded(fixture);
    const { result, journal } = await journaled(() =>
      dispatch({ issue, responses: { [issue]: response } }),
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

test('given a checkout root with .claude/skills, .pi/skills, AGENTS.md, CLAUDE.md and .pi/SYSTEM.md and no .agents/skills, when the workload starts, then pi and the subagent invocation get the two skill paths, the system prompt file, AGENTS.md framed as project instructions, and the unattended instruction, and nothing for what does not exist', async () => {
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
  const root = realpathSync(pi.cwd);
  const unattended = pi.argv[pi.argv.indexOf('-e') - 1] ?? '';
  assert.match(unattended, /no human will answer/);
  const flags = [
    ...PI_CONTRACT,
    '--skill',
    join(root, '.claude', 'skills'),
    '--skill',
    join(root, '.pi', 'skills'),
    '--system-prompt',
    join(root, '.pi', 'SYSTEM.md'),
    ...projectInstructions(join(root, 'AGENTS.md')),
    '--append-system-prompt',
    unattended,
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
  const flags = pi.argv.slice(PI_CONTRACT.length, pi.argv.indexOf('-e') - 2);
  assert.deepEqual(flags, [
    '--skill',
    join(root, '.agents', 'skills'),
    '--append-system-prompt',
    join(root, '.pi', 'APPEND_SYSTEM.md'),
    ...projectInstructions(join(root, 'CLAUDE.md')),
  ]);
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
    /GitHub found no ticket rameezk\/forge#99999: Could not resolve to an Issue with the number of 99999\./,
  );
  await assert.rejects(
    dispatch({ repository: 'elsewhere' }),
    /unknown repository 'elsewhere'/,
  );
});

test('given a GitHub write-token file that also sets NODE_OPTIONS and quotes the token, and a different GITHUB_TOKEN in the environment, when forge-dispatch runs, then every GitHub call uses the file token, and pi gets it as GITHUB_TOKEN and nothing else from the file', async () => {
  const { requests, labelWrites, pi } = await dispatch({
    tokenFile: `NODE_OPTIONS=--require /var/lib/forge/planted.js\n  GITHUB_TOKEN = "${GITHUB_TOKEN}"  \n`,
  });

  assert.deepEqual(
    new Set([...requests, ...labelWrites].map((request) => request.authorization)),
    new Set([`bearer ${GITHUB_TOKEN}`]),
  );
  assert.ok(pi);
  assert.equal(pi.githubToken, GITHUB_TOKEN);
  assert.equal(pi.nodeOptions, undefined);
});

test('given no GitHub write-token file, or one that sets no token, when forge-dispatch runs, then it fails naming the missing write token without asking GitHub', async () => {
  for (const tokenFile of [null, 'OTHER=value\n']) {
    await assert.rejects(dispatch({ tokenFile }), /GitHub write token missing/);
  }
});

test('given an agent that reads the GitHub token from the state directory and repeats it, when forge-dispatch runs, then the transcript carries it redacted', async () => {
  const piOutput = join(mkdtempSync(join(tmpdir(), 'forge-output-')), 'pi.jsonl');
  writeFileSync(
    piOutput,
    readFileSync(PI_OUTPUT, 'utf8').replaceAll('All done.', `All done. ${GITHUB_TOKEN}`),
  );

  const { transcript } = await dispatch({ piOutput });

  assert.match(transcript, /All done\. \[redacted\]/);
  assert.ok(!transcript.includes(GITHUB_TOKEN));
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

test('given a skill whose frontmatter name is a number, when forge-dispatch runs a prompt naming its directory, then pi never starts and the skill is not found, as pi names it by the number', async () => {
  const { pi, runs } = await journaled(() =>
    dispatch({
      origin: originWith({
        '.claude/skills/123/SKILL.md': '---\nname: 123\ndescription: Numbered.\n---\n',
      }),
      prompt: '/123 {url}',
    }),
  ).then(({ result }) => result);

  assert.equal(pi, null);
  assert.equal(runs[0]?.error, "skill '123' not found in the checkout");
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
