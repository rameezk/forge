variable "config_file" {
  type        = string
  default     = "config.json"
  description = "Name of the per-host config file, resolved relative to the infra directory."

  validation {
    condition     = can(regex("^[^/]+$", var.config_file))
    error_message = "config_file must be a bare filename with no path separators."
  }
}

variable "hcloud_token" {
  type        = string
  default     = null
  sensitive   = true
  description = "Hetzner Cloud API token. Read from the HCLOUD_TOKEN environment variable when left unset."
}
