locals {
  config = jsondecode(file("${path.module}/../${var.config_file}"))

  ssh_public_keys = local.config.sshPublicKeys
  hostname        = local.config.hostname
  server_type     = local.config.serverType
  location        = local.config.location
  base_image      = try(local.config.baseImage, "debian-12")
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
