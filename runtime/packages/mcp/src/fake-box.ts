import { ticketPath, type RepositoriesView, type RunningView, type TicketView } from '@forge/shared';
import type { Box } from './box.ts';

export interface FakeBoxState {
  tickets?: TicketView[];
  running?: RunningView;
  repositories?: RepositoriesView;
}

export class FakeBox implements Box {
  readonly #tickets: TicketView[];
  readonly #running: RunningView;
  readonly #repositories: RepositoriesView;
  #failure: string | null = null;

  constructor({ tickets = [], running = { dispatches: [], revisions: [], conflictResolutions: [] }, repositories = [] }: FakeBoxState = {}) {
    this.#tickets = tickets;
    this.#running = running;
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

  async repositories(): Promise<RepositoriesView> {
    this.#check();
    return this.#repositories;
  }

  link(path: string): string {
    return `http://box.test${path}`;
  }

  #check(): void {
    if (this.#failure !== null) throw new Error(this.#failure);
  }
}
