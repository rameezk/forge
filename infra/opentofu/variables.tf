variable "config" {
  description = "Host configuration."
  type = object({
    sshPublicKeys = list(string)
    hostname      = string
    serverType    = string
    location      = string
    baseImage     = optional(string, "debian-12")
  })
}

variable "hcloud_token" {
  type        = string
  default     = null
  sensitive   = true
  description = "Hetzner Cloud API token. Read from the HCLOUD_TOKEN environment variable when left unset."
}
