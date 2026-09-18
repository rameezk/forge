locals {
  config = jsondecode(file("${path.module}/../../config.json"))
}

variable "hcloud_token" {
  type        = string
  default     = null
  sensitive   = true
  description = "Hetzner Cloud API token. Read from the HCLOUD_TOKEN environment variable when left unset."
}

module "forge" {
  source = "github.com/rameezk/forge//infra/opentofu?ref=main"

  config       = local.config
  hcloud_token = var.hcloud_token
}

output "server_ipv4" {
  description = "Public IPv4 address of the provisioned server, used as the nixos-anywhere install target."
  value       = module.forge.server_ipv4
}

output "server_name" {
  description = "Name of the provisioned server, matching the configured hostname."
  value       = module.forge.server_name
}

output "ssh_public_keys" {
  description = "SSH public keys the plan will register, for the cross-tool divergence check."
  value       = module.forge.ssh_public_keys
}
