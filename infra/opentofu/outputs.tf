output "server_ipv4" {
  description = "Public IPv4 address of the provisioned server, used as the nixos-anywhere install target."
  value       = hcloud_server.this.ipv4_address
}

output "server_name" {
  description = "Name of the provisioned server, matching the configured hostname."
  value       = hcloud_server.this.name
}

output "ssh_public_keys" {
  description = "SSH public keys the plan will register on the server, in config order, for cross-tool divergence checks."
  value       = local.ssh_public_keys
}
