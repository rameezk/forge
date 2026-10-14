{
  writeShellApplication,
  systemd,
}:
writeShellApplication {
  name = "forge-revise";
  runtimeInputs = [ systemd ];
  text = ''
    usage() {
      echo "usage: forge-revise <repository> <pull-request>" >&2
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
    unit="forge-revise@$1:$2.service"
    echo "forge-revise: revising $1#$2 as $unit; interrupting this command leaves it running, and journalctl -fu $unit follows it" >&2
    exec systemctl start "$unit"
  '';
  meta.description = "The box's forge-revise command: revises one pull request of a managed repository by starting its forge-revise@ unit and waiting for the workload to end.";
}
