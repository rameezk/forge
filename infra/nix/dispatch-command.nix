{
  writeShellApplication,
  systemd,
}:
writeShellApplication {
  name = "forge-dispatch";
  runtimeInputs = [ systemd ];
  text = ''
    usage() {
      echo "usage: forge-dispatch <repository> <issue>" >&2
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
    unit="forge-dispatch@$1:$2.service"
    echo "forge-dispatch: dispatching $1#$2 as $unit; interrupting this command leaves it running, and journalctl -fu $unit follows it" >&2
    exec systemctl start "$unit"
  '';
  meta.description = "The box's forge-dispatch command: dispatches one ticket of a managed repository by starting its forge-dispatch@ unit and waiting for the workload to end.";
}
