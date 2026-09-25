.PHONY: check flake-check tofu-test test-generic test-scaffold

check: flake-check tofu-test test-generic test-scaffold

flake-check:
	nix flake check

tofu-test:
	cd infra/opentofu && tofu init -input=false >/dev/null && tofu test

test-generic:
	bash tests/repo-generic.sh

test-scaffold:
	bash tests/template-scaffold.sh
