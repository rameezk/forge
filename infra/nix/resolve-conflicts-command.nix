{
  writeShellApplication,
  systemd,
}:
writeShellApplication {
  name = "forge-resolve-conflicts";
  runtimeInputs = [ systemd ];
  text = ''
    usage() {
      echo "usage: forge-resolve-conflicts <repository> <pull-request>" >&2
      exit 2
    }
    if [ "$#" -ne 2 ]; then
      usage
    fi
    case "$1" in
      "" | *[!A-Za-z0-9_-]*) usage ;;
    esac
    case "$2" in
      "" | 0* | *[!0-9]*) usage ;;
    esac
    unit="forge-resolve-conflicts@$1:$2.service"
    echo "forge-resolve-conflicts: resolving conflicts on $1#$2 as $unit; interrupting this command leaves it running, and journalctl -fu $unit follows it" >&2
    exec systemctl start "$unit"
  '';
  meta.description = "The box's forge-resolve-conflicts command: resolves the merge conflicts on one pull request of a managed repository by starting its forge-resolve-conflicts@ unit and waiting for the workload to end.";
}
