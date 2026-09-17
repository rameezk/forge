variables {
  config_file  = "config.example.json"
  hcloud_token = "0000000000000000000000000000000000000000000000000000000000000000"
}

run "plan_reflects_config" {
  command = plan

  assert {
    condition     = hcloud_server.this.server_type == "cx22"
    error_message = "hcloud_server does not carry the configured serverType"
  }

  assert {
    condition     = hcloud_server.this.location == "nbg1"
    error_message = "hcloud_server does not carry the configured location"
  }

  assert {
    condition     = hcloud_ssh_key.operator["0"].public_key == "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExamplePlaceholderKeyReplaceWithYourOwn operator@example"
    error_message = "hcloud_ssh_key does not carry the configured SSH public key"
  }

  assert {
    condition     = contains(hcloud_server.this.ssh_keys, hcloud_ssh_key.operator["0"].name)
    error_message = "hcloud_server does not reference the configured SSH key"
  }
}

run "rejects_config_file_path_traversal" {
  command = plan

  variables {
    config_file = "../../etc/passwd"
  }

  expect_failures = [
    var.config_file,
  ]
}
