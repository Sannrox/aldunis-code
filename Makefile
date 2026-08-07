# Makefile for the Aldunis Code workbench.
# Targets delegate to scripts/make-targets, keeping the workflow explicit and
# independent of any agent or editor hooks.

.EXPORT_ALL_VARIABLES:

WHAT ?=

.PHONY: all
all:
	./scripts/make-targets/build.sh $(WHAT)

.PHONY: validate
validate:
	./scripts/make-targets/validate.sh

.PHONY: update
update:
	./scripts/make-targets/update.sh

.PHONY: test
test:
	./scripts/make-targets/test.sh $(WHAT)

.PHONY: test-integration
test-integration:
	./scripts/make-targets/test-integration.sh $(WHAT)

.PHONY: coverage
coverage:
	./scripts/make-targets/coverage.sh
