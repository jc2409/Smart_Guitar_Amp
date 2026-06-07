# SF4 host automation. Run from src/host/.
#   make env       create .env from the template
#   make install   install dependencies (uv if available, else venv+pip)
#   make run       start the web app on $(HOST):$(PORT)
#   make dev       start with auto-reload
#   make cli ARGS="--demo overdrive"   bench-test the serial link
#   make flash     compile + upload the firmware (needs arduino-cli)

# Load .env so HOST/PORT/SF4_* are available to recipes (app also loads it itself).
-include .env
export

HOST ?= 127.0.0.1
PORT ?= 8000
FQBN ?= arduino:avr:uno
SKETCH ?= ../DSP_Pipeline
VENV := .venv

# Prefer uv; fall back to a plain venv + pip.
UV := $(shell command -v uv 2>/dev/null)
ifdef UV
  UVICORN   = uv run uvicorn
  SERIALCLI = uv run python sf4_serial.py
else
  UVICORN   = $(VENV)/bin/uvicorn
  SERIALCLI = $(VENV)/bin/python sf4_serial.py
endif

.DEFAULT_GOAL := help
.PHONY: help env install run dev cli flash clean

help:
	@grep -E '^#   make' Makefile | sed 's/^#   /  /'

env:
	@test -f .env || cp .env.example .env
	@echo ".env ready — set ANTHROPIC_API_KEY in it to enable chat."

install:
ifdef UV
	uv sync
else
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install -r requirements.txt
endif

run: env
	$(UVICORN) app.main:app --host $(HOST) --port $(PORT)

dev: env
	$(UVICORN) app.main:app --host $(HOST) --port $(PORT) --reload

cli:
	$(SERIALCLI) $(ARGS)

flash:
	@command -v arduino-cli >/dev/null || { echo "arduino-cli not installed"; exit 1; }
	arduino-cli compile --fqbn $(FQBN) $(SKETCH)
	@test -n "$(SF4_PORT)" || { echo "set SF4_PORT in .env to the board's port"; exit 1; }
	arduino-cli upload --fqbn $(FQBN) --port $(SF4_PORT) $(SKETCH)

clean:
	rm -rf $(VENV) app/__pycache__ __pycache__
	@echo "cleaned venv and caches"
