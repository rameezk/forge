locals {
  ssh_public_keys = var.config.sshPublicKeys
  hostname        = var.config.hostname
  server_type     = var.config.serverType
  location        = var.config.location
  base_image      = var.config.baseImage
}

provider "hcloud" {
  token = var.hcloud_token
}

resource "hcloud_ssh_key" "operator" {
  for_each = { for idx, key in local.ssh_public_keys : tostring(idx) => key }

  name       = "${local.hostname}-key-${each.key}"
  public_key = each.value
}

resource "hcloud_server" "this" {
  name        = local.hostname
  server_type = local.server_type
  location    = local.location
  image       = local.base_image
  ssh_keys    = [for key in hcloud_ssh_key.operator : key.name]
}
