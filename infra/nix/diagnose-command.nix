{
  writeShellApplication,
  systemd,
  diagnosisWorker ? null,
}:
writeShellApplication {
  name = "forge-diagnose";
  runtimeInputs = [ systemd ];
  text = ''
    usage() {
      echo "usage: forge-diagnose <run> [--worker <name>]" >&2
      exit 2
    }
    valid() {
      case "$1" in
        "" | *[!A-Za-z0-9_-]*) return 1 ;;
      esac
    }
    if [ "$#" -ne 1 ] && [ "$#" -ne 3 ]; then
      usage
    fi
    run="$1"
    valid "$run" || usage
    worker=${if diagnosisWorker == null then "\"\"" else "\"${diagnosisWorker}\""}
    if [ "$#" -eq 3 ]; then
      [ "$2" = "--worker" ] || usage
      worker="$3"
      valid "$worker" || usage
    fi
    if [ -z "$worker" ]; then
      echo "forge-diagnose: no diagnosis worker is configured: set forge.runtime.diagnosis.worker, or pick one with --worker" >&2
      exit 1
    fi
    unit="forge-diagnose@$run:$worker.service"
    echo "forge-diagnose: diagnosing $run with $worker as $unit; interrupting this command leaves it running, and journalctl -fu $unit follows it" >&2
    exec systemctl start "$unit"
  '';
  meta.description = "The box's forge-diagnose command: diagnoses one run with the diagnosis worker, or the worker named with --worker, by starting its forge-diagnose@ unit and waiting for the diagnosis to end.";
}
