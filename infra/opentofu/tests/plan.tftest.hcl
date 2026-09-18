variables {
  config       = jsondecode(file("../config.example.json"))
  hcloud_token = "0000000000000000000000000000000000000000000000000000000000000000"
}

run "plan_reflects_config" {
  command = plan

  assert {
    condition     = hcloud_server.this.server_type == var.config.serverType
    error_message = "hcloud_server does not carry the configured serverType"
  }

  assert {
    condition     = hcloud_server.this.location == var.config.location
    error_message = "hcloud_server does not carry the configured location"
  }

  assert {
    condition     = hcloud_server.this.name == var.config.hostname
    error_message = "hcloud_server does not carry the configured hostname"
  }

  assert {
    condition     = hcloud_ssh_key.operator["0"].public_key == var.config.sshPublicKeys[0]
    error_message = "hcloud_ssh_key does not carry the configured SSH public key"
  }

  assert {
    condition     = contains(hcloud_server.this.ssh_keys, hcloud_ssh_key.operator["0"].name)
    error_message = "hcloud_server does not reference the configured SSH key"
  }
}
