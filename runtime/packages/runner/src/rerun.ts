import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { errorMessage, GITHUB_REST_API, type Fetch } from '@forge/shared';

export const RERUN_SOCKET_ENV = 'FORGE_RERUN_SOCKET';

export const RERUN_LIMIT = 2;

const SOCKET_FILE = 'rerun.sock';

const MAX_BODY_BYTES = 256;

const GITHUB_TIMEOUT_MS = 30_000;

const ASK_TIMEOUT_FACTOR = 2;

const FAILED_CONCLUSIONS = ['failure', 'startup_failure', 'timed_out', 'cancelled'];

export interface RerunAnswer {
  rerun: boolean;
  message: string;
}

export interface RerunPolicy {
  github: string;
  fetch: Fetch;
  token: () => Promise<string>;
  pullRequest: () => Promise<number | null>;
  timeoutMs?: number;
}

interface PullRequestResponse {
  head?: { sha?: unknown; ref?: unknown };
}

interface RunResponse {
  head_sha?: unknown;
  head_branch?: unknown;
  status?: unknown;
  conclusion?: unknown;
}

const refusal = (message: string): RerunAnswer => ({ rerun: false, message: `refused: ${message}` });

const limitReached = (): RerunAnswer =>
  refusal(`this workload has already re-run ${RERUN_LIMIT} runs, the limit of ${RERUN_LIMIT}`);

const githubRequest = async (
  policy: RerunPolicy,
  token: string,
  method: string,
  path: string,
  abandoned: AbortSignal,
): Promise<Response> =>
  policy.fetch(`${GITHUB_REST_API}/repos/${policy.github}${path}`, {
    method,
    signal: AbortSignal.any([abandoned, AbortSignal.timeout(policy.timeoutMs ?? GITHUB_TIMEOUT_MS)]),
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  });

export class RerunDecider {
  readonly #policy: RerunPolicy;
  #rerun = 0;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(policy: RerunPolicy) {
    this.#policy = policy;
  }

  ask(run: unknown): Promise<RerunAnswer> {
    const answer = this.#queue.then(() => this.#bounded((abandoned) => this.#decide(run, abandoned)));
    this.#queue = answer.catch(() => undefined);
    return answer.catch(
      (error: unknown): RerunAnswer => ({
        rerun: false,
        message: `could not re-run the run: ${errorMessage(error)}`,
      }),
    );
  }

  #bounded(decide: (abandoned: AbortSignal) => Promise<RerunAnswer>): Promise<RerunAnswer> {
    const limit = (this.#policy.timeoutMs ?? GITHUB_TIMEOUT_MS) * ASK_TIMEOUT_FACTOR;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('the ask took too long'));
      }, limit);
    });
    const decision = decide(controller.signal);
    decision.catch(() => undefined);
    return Promise.race([decision, late]).finally(() => clearTimeout(timer));
  }

  async #decide(run: unknown, abandoned: AbortSignal): Promise<RerunAnswer> {
    if (typeof run !== 'number' || !Number.isSafeInteger(run) || run < 1) {
      return refusal('ask for one run by its number');
    }
    if (this.#rerun >= RERUN_LIMIT) {
      return limitReached();
    }
    const number = await this.#policy.pullRequest();
    abandoned.throwIfAborted();
    if (number === null) {
      return refusal('this workload has no open pull request yet, so no run is on its head');
    }
    const token = await this.#policy.token();
    abandoned.throwIfAborted();
    const pullRequestResponse = await githubRequest(this.#policy, token, 'GET', `/pulls/${number}`, abandoned);
    if (!pullRequestResponse.ok) {
      return refusal(`GitHub answered ${pullRequestResponse.status} for pull request #${number}`);
    }
    const { head } = (await pullRequestResponse.json()) as PullRequestResponse;
    const runResponse = await githubRequest(this.#policy, token, 'GET', `/actions/runs/${run}`, abandoned);
    if (runResponse.status === 404) {
      return refusal(`${this.#policy.github} has no run ${run}`);
    }
    if (!runResponse.ok) {
      return refusal(`GitHub answered ${runResponse.status} for run ${run}`);
    }
    const found = (await runResponse.json()) as RunResponse;
    if (
      typeof head?.sha !== 'string' ||
      typeof head.ref !== 'string' ||
      found.head_sha !== head.sha ||
      found.head_branch !== head.ref
    ) {
      return refusal(`run ${run} is not on the head of pull request #${number}`);
    }
    if (
      found.status !== 'completed' ||
      typeof found.conclusion !== 'string' ||
      !FAILED_CONCLUSIONS.includes(found.conclusion)
    ) {
      return refusal(`run ${run} has not failed`);
    }
    abandoned.throwIfAborted();
    if (this.#rerun >= RERUN_LIMIT) {
      return limitReached();
    }
    this.#rerun += 1;
    const response = await githubRequest(this.#policy, token, 'POST', `/actions/runs/${run}/rerun`, abandoned);
    if (!response.ok) {
      return { rerun: false, message: `GitHub answered ${response.status} when re-running run ${run}` };
    }
    return { rerun: true, message: `re-ran run ${run}` };
  }
}

const readBody = async (request: IncomingMessage): Promise<string | null> => {
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > MAX_BODY_BYTES) return null;
  }
  return body;
};

const parsedRun = (body: string | null): unknown => {
  try {
    return (JSON.parse(body ?? '') as { run?: unknown }).run;
  } catch {
    return undefined;
  }
};

const reply = (response: ServerResponse, status: number, answer: RerunAnswer): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(answer));
};

export class RerunChannel {
  readonly #server: Server;
  readonly path: string;

  private constructor(server: Server, path: string) {
    this.#server = server;
    this.path = path;
  }

  static async open(dir: string, policy: RerunPolicy): Promise<RerunChannel> {
    const decider = new RerunDecider(policy);
    const server = createServer((request, response) => {
      if (request.method !== 'POST' || request.url !== '/rerun') {
        request.resume();
        reply(response, 404, { rerun: false, message: 'refused: only POST /rerun is served' });
        return;
      }
      readBody(request)
        .then(async (body) => {
          reply(response, 200, await decider.ask(parsedRun(body)));
        })
        .catch(() => response.destroy());
    });
    const path = join(dir, SOCKET_FILE);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    return new RerunChannel(server, path);
  }

  get environment(): Record<string, string> {
    return { [RERUN_SOCKET_ENV]: this.path };
  }

  close(): Promise<void> {
    this.#server.closeAllConnections();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }
}
