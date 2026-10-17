export interface RepositoryConfig {
  github: string;
  on?: { ticket?: string; feedback?: string; conflict?: string };
}

export interface FrontierConfig {
  repositories: Record<string, RepositoryConfig>;
}
