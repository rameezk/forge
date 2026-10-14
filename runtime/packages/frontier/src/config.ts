export interface RepositoryConfig {
  github: string;
  on?: { ticket?: string };
}

export interface FrontierConfig {
  repositories: Record<string, RepositoryConfig>;
}
