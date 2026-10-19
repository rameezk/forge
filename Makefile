.PHONY: check check-no-vm flake-check flake-check-no-vm vm-tests tofu-test test-generic test-scaffold test-failed-build-log test-markdown-only

TESTS = tofu-test test-generic test-scaffold test-failed-build-log test-markdown-only

check: flake-check $(TESTS)

ifeq ($(shell uname -s),Darwin)
check: vm-tests
endif

check-no-vm: flake-check-no-vm $(TESTS)

flake-check:
	nix flake check

flake-check-no-vm:
	nix flake check --print-build-logs

vm-tests:
	nix build --print-build-logs --no-link $$(nix eval --json .#vmTests.aarch64-linux --apply builtins.attrNames | jq -r '.[] | ".#vmTests.aarch64-linux." + .') || { echo "If Nix found no Linux builder with KVM for the VM tests, see README.md#run-the-checks, or run 'make check-no-vm' and rely on CI." >&2; exit 1; }

tofu-test:
	cd infra/opentofu && tofu init -input=false >/dev/null && tofu test

test-generic:
	bash tests/repo-generic.sh

test-scaffold:
	bash tests/template-scaffold.sh

test-failed-build-log:
	bash tests/failed-build-log.sh

test-markdown-only:
	bash tests/markdown-only.sh
