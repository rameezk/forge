variable "config" {
  description = "Host configuration object, matching the operator's committed config.json. Forge reads no config file of its own; the caller supplies this so both tools consume the same config."
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
