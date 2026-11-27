import { ticketPath, type FrontierView, type RepositoryFrontierView, type RepositoryView, type RunningView, type TicketView } from '@forge/shared';
import type { Box } from './box.ts';

export interface FakeBoxState {
  tickets?: TicketView[];
  running?: RunningView;
  frontier?: RepositoryFrontierView[];
  repositories?: RepositoryView[];
}

export class FakeBox implements Box {
  readonly #tickets: TicketView[];
  readonly #running: RunningView;
  readonly #frontier: RepositoryFrontierView[];
  readonly #repositories: RepositoryView[];
  #failure: string | null = null;

  constructor({ tickets = [], running = { dispatches: [], revisions: [], conflictResolutions: [] }, frontier = [], repositories = [] }: FakeBoxState = {}) {
    this.#tickets = tickets;
    this.#running = running;
    this.#frontier = frontier;
    this.#repositories = repositories;
  }

  fail(message: string): void {
    this.#failure = message;
  }

  async ticket(repository: string, number: number): Promise<TicketView> {
    this.#check();
    return (
      this.#tickets.find((ticket) => ticket.repository === repository && ticket.number === number) ?? {
        repository,
        number,
        url: null,
        dashboard: ticketPath(repository, number),
        outcome: null,
        failureReason: null,
        failureDetail: null,
        pullRequest: null,
        diagnosis: null,
        attempts: [],
      }
    );
  }

  async running(): Promise<RunningView> {
    this.#check();
    return this.#running;
  }

  async frontier(): Promise<FrontierView> {
    this.#check();
    return { repositories: this.#frontier };
  }

  async repository(name: string): Promise<RepositoryView> {
    this.#check();
    const repository = this.#repositories.find((known) => known.repository === name);
    if (repository === undefined) throw new Error(`the forge box answered 404 for repository ${name}`);
    return repository;
  }

  link(path: string): string {
    return `http://box.test${path}`;
  }

  #check(): void {
    if (this.#failure !== null) throw new Error(this.#failure);
  }
}
