export interface RepositoryConfig {
  github: string;
  on?: { ticket?: string; feedback?: string };
}

export interface FrontierConfig {
  repositories: Record<string, RepositoryConfig>;
}
