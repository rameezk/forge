.PHONY: check check-no-vm flake-check flake-check-no-vm vm-tests tofu-test test-generic test-scaffold test-check-selection

TESTS = tofu-test test-generic test-scaffold test-check-selection

check: flake-check $(TESTS)

ifeq ($(shell uname -s),Darwin)
check: vm-tests
endif

check-no-vm: flake-check-no-vm $(TESTS)

flake-check:
	nix flake check

flake-check-no-vm:
	nix flake check --no-build
	scripts/checks.sh build no-vm "$$(nix eval --raw --impure --expr builtins.currentSystem)"

vm-tests:
	scripts/checks.sh build vm aarch64-linux || { echo "If Nix found no Linux builder with KVM for the VM tests, see README.md#run-the-checks, or run 'make check-no-vm' and rely on CI." >&2; exit 1; }

tofu-test:
	cd infra/opentofu && tofu init -input=false >/dev/null && tofu test

test-generic:
	bash tests/repo-generic.sh

test-scaffold:
	bash tests/template-scaffold.sh

test-check-selection:
	bash tests/check-selection.sh
