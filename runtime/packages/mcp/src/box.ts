import { FRONTIER_ROUTE, REPOSITORIES_ROUTE, repositoryRoute, RUNNING_ROUTE, ticketRoute, type FrontierView, type ManagedRepositoriesView, type RepositoryView, type RunningView, type TicketView } from '@forge/shared';

export interface Box {
  ticket(repository: string, number: number): Promise<TicketView>;
  running(): Promise<RunningView>;
  managedRepositories(): Promise<ManagedRepositoriesView>;
  frontier(): Promise<FrontierView>;
  repository(name: string): Promise<RepositoryView>;
  link(path: string): string;
}

export const BOX_ADDRESS_VARIABLE = 'FORGE_BOX_ADDRESS';

const FULL_NAME_FORM = '<hostname>.<tailnet>.ts.net';

export const boxAddressFrom = (value: string | undefined): string => {
  const address = value?.trim() ?? '';
  if (address === '') throw new Error(`${BOX_ADDRESS_VARIABLE} must name the box's full tailnet name, ${FULL_NAME_FORM}, such as forge-box.tailnet.ts.net`);
  if (/^https?:\/\//.test(address)) return address.replace(/\/+$/, '');
  const host = address.split(/[/:]/, 1)[0] ?? '';
  if (!host.includes('.')) throw new Error(`${BOX_ADDRESS_VARIABLE} is ${JSON.stringify(address)}, which is not the box's full tailnet name: use ${FULL_NAME_FORM}, because the box's certificate covers only that name`);
  return `https://${address}`.replace(/\/+$/, '');
};

const reasonFor = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause ?? error;
  if (!(cause instanceof Error)) return String(cause);
  const code = (cause as { code?: unknown }).code;
  const parts = [cause.message, typeof code === 'string' && !cause.message.includes(code) ? code : ''].filter((part) => part !== '');
  return parts.length === 0 ? error.message : parts.join(' ');
};

const LOCAL_PATH = /^\/(?![/\\])/;

const isDotSegment = (name: string): boolean => name === '.' || name === '..';

const notARepository = (name: string): Error => new Error(`${JSON.stringify(name)} is not a repository name`);

export class HttpBox implements Box {
  readonly #address: string;

  constructor(address: string) {
    this.#address = address;
  }

  ticket(repository: string, number: number): Promise<TicketView> {
    if (isDotSegment(repository)) return Promise.reject(notARepository(repository));
    return this.#get<TicketView>(ticketRoute(repository, number));
  }

  running(): Promise<RunningView> {
    return this.#get<RunningView>(RUNNING_ROUTE);
  }

  managedRepositories(): Promise<ManagedRepositoriesView> {
    return this.#get<ManagedRepositoriesView>(REPOSITORIES_ROUTE);
  }

  frontier(): Promise<FrontierView> {
    return this.#get<FrontierView>(FRONTIER_ROUTE);
  }

  repository(name: string): Promise<RepositoryView> {
    if (isDotSegment(name)) return Promise.reject(notARepository(name));
    return this.#get<RepositoryView>(repositoryRoute(name));
  }

  link(path: string): string {
    if (!LOCAL_PATH.test(path)) throw new Error(`the forge box sent a dashboard path that leaves the box: ${path}`);
    return `${this.#address}${path}`;
  }

  async #get<Body>(path: string): Promise<Body> {
    const url = this.link(path);
    let response: Response;
    try {
      response = await fetch(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new Error(`could not reach the forge box at ${this.#address}: ${reasonFor(error)}`);
    }
    if (!response.ok) throw new Error(`the forge box answered ${response.status} for ${path}`);
    return (await response.json()) as Body;
  }
}
