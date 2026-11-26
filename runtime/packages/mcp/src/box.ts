import { REPOSITORIES_ROUTE, RUNNING_ROUTE, ticketRoute, type RepositoriesView, type RunningView, type TicketView } from '@forge/shared';

export interface Box {
  ticket(repository: string, number: number): Promise<TicketView>;
  running(): Promise<RunningView>;
  repositories(): Promise<RepositoriesView>;
  link(path: string): string;
}

export const BOX_ADDRESS_VARIABLE = 'FORGE_BOX_ADDRESS';

export const boxAddressFrom = (value: string | undefined): string => {
  const address = value?.trim() ?? '';
  if (address === '') throw new Error(`${BOX_ADDRESS_VARIABLE} must name the box's tailnet address, such as forge-box or forge-box.tailnet.ts.net`);
  const withScheme = /^https?:\/\//.test(address) ? address : `http://${address}`;
  return withScheme.replace(/\/+$/, '');
};

const LOCAL_PATH = /^\/(?![/\\])/;

export class HttpBox implements Box {
  readonly #address: string;

  constructor(address: string) {
    this.#address = address;
  }

  ticket(repository: string, number: number): Promise<TicketView> {
    if (repository === '.' || repository === '..') return Promise.reject(new Error(`${JSON.stringify(repository)} is not a repository name`));
    return this.#get<TicketView>(ticketRoute(repository, number));
  }

  running(): Promise<RunningView> {
    return this.#get<RunningView>(RUNNING_ROUTE);
  }

  repositories(): Promise<RepositoriesView> {
    return this.#get<RepositoriesView>(REPOSITORIES_ROUTE);
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
      throw new Error(`could not reach the forge box at ${this.#address}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(`the forge box answered ${response.status} for ${path}`);
    return (await response.json()) as Body;
  }
}
