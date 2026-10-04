import shlex

UNIT_SUCCEEDED = "7ad2d189f7e94e70a38c781354912448"
UNIT_FAILED = "d9b373ed55a64feb8242e02dbe79a49c"


def cursor(machine):
    export = machine.succeed("journalctl -q -n 1 -o export")
    return next(line.removeprefix("__CURSOR=") for line in export.splitlines() if line.startswith("__CURSOR="))


def wait_until_oneshot_succeeded(machine, unit, after, timeout=900):
    def records(message_id):
        return machine.succeed(
            f"journalctl -q -o cat --after-cursor={shlex.quote(after)} _PID=1 UNIT={shlex.quote(unit)} MESSAGE_ID={message_id}"
        ).strip()

    def succeeded(_last_try):
        failure = records(UNIT_FAILED)
        if failure:
            raise Exception(failure)
        return records(UNIT_SUCCEEDED) != ""

    retry(succeeded, timeout)
