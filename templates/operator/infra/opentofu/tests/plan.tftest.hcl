variables {
  hcloud_token = "0000000000000000000000000000000000000000000000000000000000000000"
}

run "plan_reflects_config" {
  command = plan

  assert {
    condition     = module.forge.server_name == local.config.hostname
    error_message = "planned server name does not match config.json hostname"
  }

  assert {
    condition     = module.forge.ssh_public_keys == tolist(local.config.sshPublicKeys)
    error_message = "planned SSH keys do not match config.json sshPublicKeys"
  }
}
