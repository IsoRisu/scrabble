# Multiplayer Scrabble

Two-player Scrabble in the browser, played over the network. Flask + Flask-SocketIO
on the server (the single source of truth), vanilla JS/HTML/CSS on the client
(a plain DOM grid, no canvas). Game state lives in memory - no database, no auth.

## Features

- Server-authoritative 15x15 board, standard 100-tile bag, 7-tile racks, scores, turn order.
- Rooms: `POST /create` returns an 8-character code and a shareable `/join/<code>` URL.
- Placement rules (first word covers the centre, later words connect, one line, no gaps),
  dictionary check, premium squares (DL/TL/DW/TW), 50-point bingo for using all 7 tiles.
- Per-player state: you see your own rack; the opponent's rack is a tile count only.
  After the first snapshot the server sends **diffs** on every change.
- Drag tiles from the rack to the board (mouse or touch), or tap a tile then a square.
  Blank tiles ask which letter they stand for. Live score preview while you place.
- Play / Recall / Swap / Pass buttons, live scores, turn banner, move history.
- Reconnect: the session token is kept in `localStorage`; reloading the page or
  dropping the connection puts you back in your seat.
- Two rule sets, chosen when the game is created:
  - **strict** - invalid words are rejected automatically.
  - **challenge** - any geometrically legal play is accepted; the opponent may
    `challenge_skip` it. A successful challenge removes the play; a failed one
    costs the challenger their turn.

## Project layout

```
app.py              Flask routes + Socket.IO events
game/
  tiles.py          tile distribution and letter values
  board.py          board state, placement legality, word extraction
  scoring.py        premium squares, word/move scoring, bingo
  room.py           Room (rules, turns, views), RoomRegistry, dictionary loading
static/             app.js, style.css
templates/          index.html (home), game.html (board)
tests/              unit tests for the rules engine
words.txt           bundled word list, one word per line
Procfile            gunicorn -k eventlet entry for Railway/Render
gunicorn.conf.py    gunicorn settings (single eventlet worker)
requirements.txt
```

## Run locally

Requires Python 3.10+ (3.11 recommended).

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5000, click **Create game**, and send the link to your
opponent (or open it in a second browser window to play both sides).
Set `PORT` / `HOST` to change the address (`HOST=0.0.0.0` to play on your LAN).

Run the tests:

```bash
python -m unittest discover -s tests -v
```

The browser loads the Socket.IO client from `cdn.socket.io`, so the page needs
internet access (see TODO).

## Socket events

| Event | Payload | Notes |
|---|---|---|
| `join` | `{room, token?, name?}` | Acks `{ok, token, seat}`. A valid `token` rejoins your seat. |
| `place_tiles` | `{placements: [{rack_index, row, col, letter?}]}` | Replaces your tentative placement; `letter` is required for blanks. |
| `submit_word` | `{}` | Validates, scores, draws tiles, passes the turn. |
| `pass` | `{}` | Pass (or accept a final play in challenge rules). |
| `swap_tiles` | `{indices: [...]}` | Needs at least 7 tiles in the bag. |
| `challenge_skip` | `{}` | Challenge rules only. |

Server to client: `state` (full snapshot `{version, config, state}`) and
`state_diff` (`{base, version, patch}`). If a client sees a diff whose `base` is
not its current version it rejoins to get a fresh snapshot.

## Deploy (Railway / Render)

The app **must run as exactly one worker process**, because rooms are held in
that process's memory. Concurrency comes from eventlet green threads.
`Procfile` and `gunicorn.conf.py` already encode this:

```
web: gunicorn -c gunicorn.conf.py -k eventlet -w 1 app:app
```

**Railway**
1. Push this folder to a GitHub repo.
2. New Project, Deploy from GitHub repo. Railway detects Python and uses the `Procfile`.
3. In Settings, Networking, Generate Domain. Done - no environment variables are required.

**Render**
1. New, Web Service, connect the repo.
2. Build command: `pip install -r requirements.txt`
3. Start command: `gunicorn -c gunicorn.conf.py -k eventlet -w 1 app:app`
4. Optionally set `PYTHON_VERSION=3.11.9`. Health check path: `/healthz`.

Environment variables (all optional):

| Variable | Meaning |
|---|---|
| `PORT` | Listen port (set by the platform). |
| `CORS_ALLOWED_ORIGINS` | Unset = same origin only; `*` or a comma-separated list otherwise. |
| `WORDS_FILE` | Path to an alternative word list. |
| `LOG_LEVEL` | gunicorn log level. |

Because state is in memory, a redeploy or restart ends all games, and free tiers
that sleep will drop idle games.

## Word list

`words.txt` holds about 111,000 words (2-15 letters, lower case, one per line). It
is a **trimmed approximation** of a Scrabble dictionary, not an official one: it
omits some valid words and may differ from TWL/NWL/Collins in places. For serious
play, point `WORDS_FILE` at the full ENABLE or TWL list (any one-word-per-line
text file; non-alphabetic lines are ignored).

## Known limitations

- In-memory state only; one worker; a restart loses all games.
- Two players per room. No accounts, chat, timers or AI opponent.
- The client depends on the Socket.IO CDN script.

## TODO

- [ ] Persist rooms (SQLite/Redis) and support multiple workers with a Socket.IO message queue.
- [ ] Accounts / auth instead of anonymous session tokens.
- [ ] In-game chat.
- [ ] AI opponent.
- [ ] 3-4 player rooms.
- [ ] Full official dictionary, selectable per room.
- [ ] Turn timers and automatic forfeits.
- [ ] Rematch, spectators, GCG move-log export.
- [ ] Rate limiting for socket events and room creation.
- [ ] Self-host the socket.io client; add Playwright and Socket.IO integration tests.
