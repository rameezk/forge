export interface RepositoryConfig {
  github: string;
}

export interface FrontierConfig {
  repositories: Record<string, RepositoryConfig>;
}
