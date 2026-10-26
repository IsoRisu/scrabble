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
- **Resign** at any time (with a confirmation). Two players: the opponent wins. More: your tiles go back
  into the bag and the others play on; the last player standing wins.
- **Tile tracker**: bag size, vowels, consonants and blanks you have not seen, plus a per-letter list (the
  bag plus your opponents' racks). Once the bag is empty it shows your opponents' exact tiles.
- Words in the move list link to an online dictionary (Wiktionary, in the room's language).
- Game settings, changeable by **either player inside the room until the first turn is played**
  (rooms are created with the defaults, **Wild** and **Full**):
  - **Mode**
    - **Wild** (default) - uses the Letter League board layout from `wild_rules.txt`: no triple word
      squares (corners are plain, the four edge middles are triple letters). Every word is checked against the dictionary automatically
      (the live preview shows validity and invalid plays are rejected). A tile placed on a
      double or triple letter square **keeps its multiplier for the rest of the game**, so
      later words that reuse it score the improved value. Boosted tiles are shown with
      their multiplied value on the board.
    - **Classic** - traditional scoring (premium squares only count on the turn the tile is
      placed). Any geometrically legal play is accepted and the opponent may `challenge_skip`
      it. A successful challenge removes the play; a failed one costs the challenger their turn.
  - **Length** - how many tiles are in the bag: Short (50), Medium (75) or Full (100).
  - **Timer** - off (default) or 30s / 60s / 90s / 2m / 3m / 5m per turn. The clock restarts every turn.
    In **Classic** the server owns the clock: when it runs out the player's turn is passed automatically
    (running out of time on a final play accepts it). In **Wild** the timer is only a reminder: nothing
    happens at zero except a reminder tone for the player on turn; any player can pause or resume it
    (pausing silences the tone), and once it reached zero the host may skip the player on turn.
- **Edit Game Settings** button (side panel) opens the settings dialog; the **i** button in the top
  bar opens Game Info with the rules. Swap sits above the rack; Pass Turn sits under the timer.
- The number on each tile is what it scores on the square it is on, so a tentative tile on a
  double/triple letter square shows its multiplied value (also while dragging). In Wild, the live
  preview marks every word with a tick or cross, and multiplied tiles are coloured in on the board.

## Languages

English is always available (`words.txt`). Finnish, Swedish, French and Spanish have tile sets and
values in `game/tiles.py`, but a language only becomes selectable (create / settings dialog) once its
word list exists as `data/<code>.txt` (`fi`, `sv`, `fr`, `es`; UTF-8, one word per line, accents kept).
Every tile is one character, so Spanish has no CH/LL/RR tiles.

## Project layout

```
app.py              Flask routes + Socket.IO events
game/
  tiles.py          tile distribution and letter values
  board.py          board state, placement legality, word extraction
  scoring.py        premium squares, word/move scoring, Wild letter boosts, bingo
  room.py           Room (mode, length, turns, views), RoomRegistry, dictionary loading
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

Open http://127.0.0.1:5000, click **Create game**, optionally pick the mode and
length in the room, and send the link to your opponent (or open it in a second browser window to play both sides).
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
| `update_settings` | `{mode?, length?, timer?}` | `mode`: `wild` or `classic`; `length`: `short`, `medium` or `full`; `timer`: `off`, `30s`, `60s`, `90s`, `2m`, `3m` or `5m`. Either player, before the first turn only. Changing the length re-deals the racks. |
| `place_tiles` | `{placements: [{rack_index, row, col, letter?}]}` | Replaces your tentative placement; `letter` is required for blanks. |
| `submit_word` | `{}` | Validates, scores, draws tiles, passes the turn. |
| `pass` | `{}` | Pass (or accept a final play in Classic mode). |
| `swap_tiles` | `{indices: [...]}` | Needs at least 7 tiles in the bag. |
| `challenge_skip` | `{}` | Classic mode only. |
| `resign` | `{}` | Give up (any time while the game is running). |
| `pause_timer` / `resume_timer` | `{}` | Wild only, any player, needs a timer. |
| `skip_overtime` | `{}` | Wild only: the host skips the player on turn once the timer reached zero. |

HTTP: `POST /create` takes an optional JSON body `{mode?, length?, timer?}` (same values as
`update_settings`; defaults Wild / full / off; 400 on an unknown value) and returns `{code, path, url, mode, length, timer}`;
`GET /api/room/<code>` returns `{exists, status, players, mode, length}`. Board cells in
the state view are `{l: letter, b: is_blank, m: letter_boost}`, and the view carries
`tiles` (unseen-tile tracker), `host`, `timer_paused`, a `resigned` flag per player,
`mode`, `length`, `timer`, `turn_ms_left`, `rules` (`strict` for Wild, `challenge` for Classic) and `settings_locked`.

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
- The client depends on the Socket.IO CDN script.

## TODO

- [ ] Persist rooms (SQLite/Redis) and support multiple workers with a Socket.IO message queue.
- [ ] Accounts / auth instead of anonymous session tokens.
- [ ] In-game chat.
- [ ] AI opponent.
- [ ] Full official dictionary, selectable per room.
- [ ] Automatic forfeits for abandoned games.
- [ ] Rematch, spectators, GCG move-log export.
- [ ] Rate limiting for socket events and room creation.
- [ ] Self-host the socket.io client; add Playwright and Socket.IO integration tests.
P3DR0 was here