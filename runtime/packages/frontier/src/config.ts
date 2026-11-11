export interface RepositoryConfig {
  github: string;
  on?: { ticket?: string; feedback?: string; conflict?: string };
  grading?: boolean;
}

export interface FrontierConfig {
  repositories: Record<string, RepositoryConfig>;
}
