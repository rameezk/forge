export interface RepositoryConfig {
  github: string;
  worker?: string;
}

export interface FrontierConfig {
  repositories: Record<string, RepositoryConfig>;
}
