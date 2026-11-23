# Handoff (for AI assistants and new contributors)

Project facts live in `README.md`. This file only holds what an assistant needs to continue the work.

## State
- Wild uses the 25x25 matrix in `game/scoring.py` (centre (12,12), period 24 for growth). Classic is the fixed 15x15 board (centre (7,7)).
- `Board(classic=..., center=None)` picks the start square per mode; `CONFIG` exposes `wild_center` / `wild_period`; the client (`static/app.js`) uses `centerOf()` and the mode-aware `premiumAt()`.
- English word list: `data/en.txt` (large, not in the zip/repo snapshots). `WORDS_FILE` overrides it. Other languages: `data/<code>.txt`.
- Tests and CI: `python -m unittest discover -s tests`; CI in `.github/workflows/ci.yml`. Tests stub the English list, so no data files are needed. `tests/test_app.py` skips if Flask-SocketIO is missing.
- `make_room()` in tests defaults to Classic (coordinates around (7,7)); Wild tests pass `"wild"` and use coordinates around (12,12).

## Not done / ideas
- Classic game clock and point-challenge rule; long-word (17+ letters) dictionary; see README TODO.
- Socket.IO and browser client have no automated tests (only syntax checked).

## Conventions
- Keep the project documentation in README.md; keep this file short.
- Do not commit `__pycache__`, `.aistudio/` or word lists over a few MB.
