# Multiplayer Scrabble (Letter League style)

A real-time, browser-based word-tile game for 2-16 players. Flask + Flask-SocketIO on the
server (the single source of truth), vanilla JS/HTML/CSS on the client (a plain DOM grid, no
canvas, no build step). State lives in memory: no database, no accounts.

The UI is a colourful, desktop-first "Letter League" look with a fixed viewport, a zoomable
and pannable board, a tile-bag popover, turn-history navigation and a post-game victory screen.

## Features

**Gameplay**
- Server-authoritative board, 7-tile racks, scores and turn order. You see your own rack; others show a tile count only.
- Two scoring modes: **Wild** (25x25 board that grows as tiles near the edge, letter bonuses stay on the tile) and **Classic** (15x15, bonuses count once, two players).
- Premium squares: **2L** (light blue), **3L** (yellow), **2W** (green), **3W** (orange), purple star in the centre. 50-point bingo for using all 7 tiles.
- **Dictionary check (challenge feature)**: on = invalid words are rejected automatically; off = any legal placement is accepted and the next player may **challenge** it. A successful challenge removes the play; a failed one costs the challenger their turn.
- **Last turn**: when the bag runs out or a player plays their last tile, every other player gets exactly one final turn (passing allowed), then the game ends and scores are totalled. Everyone sees a "Last turn triggered!" toast.
- Resign at any time. Skip a player after 30 s offline. Six scoreless turns in a row end the game.
- Reconnect: the session token is kept in `localStorage`; reloading puts you back in your seat.

**Lobby and settings**
- Create a game with: scoring mode, **language**, **dictionary check**, **show tile distribution**, game length and turn timer.
- Inside the room the **Game settings** section lists the current values. Anyone can change them with *Edit settings* **until the first turn is played**, after which they lock (🔒).
- **Restart game** clears the board, resets scores and the turn timer, refills the bag and deals fresh racks, keeping the same players and settings.
- **Timer**: off or 30 s - 5 min per turn. Classic: the server passes the turn at zero. Wild: reminder only; anyone can pause, and the host can skip the player on turn once it ran out.

**Board and controls**
- Fixed desktop viewport (no page scrolling), board centred and responsive to any desktop resolution.
- **Mouse-wheel zoom** (scroll up = in, down = out, zooming around the cursor) and **drag-to-pan**. A drag counts only after moving more than 5 px, so panning never places or selects a tile by accident.
- Drag tiles from the rack (mouse or touch), or tap a tile and then a square. Blank tiles ask which letter they stand for. Live score preview while you place.
- **Aid markers** (purple dots on valid squares) appear on touch devices only; mouse users get a hover outline instead.
- **Turn history arrows** (top bar): step back and forward through the plays; the board shows that moment, with an overlay naming the word, score and player. Stepping forward past the latest play returns to the live game.
- **Word banner**: each accepted play shows a pill banner with the word and "+N points" that slides in, holds about 2 s and fades out.

**Tile bag and definitions**
- The orange bag shows a live badge with the tiles left in the bag. Clicking it opens a popover with two tabs:
  - **Tile bag**: every letter with its point value and how many are still unseen (bag plus opponents' racks), plus the bag total. With *Show tile distribution* off, only totals are shown (enforced by the server).
  - **Definitions**: look up the words played (English via the Free Dictionary API, other languages via Wiktionary). In games with the dictionary check off, this tab is locked until you use a challenge, and then covers the words you challenged.
- The **Stats** tracker in the menu lists unseen tiles and respects the same distribution setting.

**After the game**
- A **victory screen** with confetti: dimmed board on the left, leaderboard in the middle (ties share a rank: 1, 2, 2, 3), winner with a crown plus Top Turn, Longest Word (drawn with real tiles) and *Your score* on the right. On phones it stacks into one scrollable column with a sticky button.
- **Start next game** clears the room back to the waiting lobby (board, scores, racks, bag and move list reset); the host then starts the next game.

## Languages

English is always available (`data/en.txt`). Finnish, Swedish, French and Spanish have tile sets and values in `game/tiles.py`; a language becomes selectable once `data/<code>.txt` exists (`fi`, `sv`, `fr`, `es`; UTF-8, one word per line, accents kept). Every tile is one character, so Spanish has no CH/LL/RR tiles.

Finnish uses the standard 101-tile set (2 blanks; A10 I10 N9 T9 E8 S7; K5 L5 O5 Ä5; U4 M3; H J P R V Y 2 each; D Ö B F G W C 1 each). Bag lengths are **Short 50, Medium 100, Full 150** tiles; for any length that is not a whole set, letter counts are scaled proportionally (largest remainder) so the language's real letter mix is kept.

The bundled word lists are trimmed approximations, not official dictionaries (Finnish especially has no complete list). For Finnish, switch the dictionary check off and use challenges, or point `WORDS_FILE` at a fuller list.

## Project layout

```
app.py              Flask routes + Socket.IO events
game/
  tiles.py          tile distributions, letter values, proportional bag builder
  board.py          board state, placement legality, word extraction
  scoring.py        premium squares, word/move scoring, Wild letter boosts, bingo
  room.py           Room (settings, turns, last turn, restart, views), RoomRegistry, word lists
static/
  app.js            client: rendering, drag/zoom/pan, bag popover, history, victory screen
  style.css         base styles
  shell.css         Letter League shell: top bar, menus, bag popover, banners, victory screen
  board.css         board grid, premium tiles, zoom/pan styling
templates/          index.html (lobby), game.html (game)
tests/              unit tests for the rules engine
data/               word lists (en, fi, sv, fr, es)
gunicorn.conf.py    gunicorn settings (single eventlet worker)
```

## Run locally

Requires Python 3.10+ (3.11 recommended).

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5000, click **Create game**, and send the `/join/<code>` link to friends (or open a second window to play both sides). Set `PORT` / `HOST` to change the address (`HOST=0.0.0.0` for LAN play).

Run the tests:

```bash
python -m unittest discover -s tests -v
```

## Tests

- `tests/test_app.py`: Covers HTTP smoke tests and health check endpoints.
- `tests/test_game.py`: Covers comprehensive unit tests for the Scrabble rules engine, rooms, scoring, and multiplayer flow.
- `tests/test_wild_board.py`: Covers Wild-board specific tests including layout properties, premium squares, and board growth.

The browser loads the Socket.IO client from a CDN and the UI font from Google Fonts (with fallbacks), so the page needs internet access. Definitions also need internet access.

## HTTP API

| Route | Notes |
|---|---|
| `GET /` | Lobby |
| `POST /create` | Body (all optional): `{mode, length, timer, language, auto_check, show_distribution, auto_expand, expand_margin, max_players}`. Returns `{code, path, url, ...}`; 400 on an invalid value. |
| `GET /join/<code>` | Join page |
| `GET /api/room/<code>` | `{exists, status, players, mode, length}` |
| `GET /healthz` | Health check |

## Socket events

Client to server (acked with `{ok, ...}` or an error message):

| Event | Payload | Notes |
|---|---|---|
| `join` | `{room, token?, name?}` | Returns `{token, seat}`; a valid `token` rejoins your seat. |
| `update_settings` | `{mode?, length?, timer?, language?, auto_check?, show_distribution?, auto_expand?, expand_margin?, max_players?}` | Any player, **before the first turn only**. |
| `start_game` | `{}` | Host starts a waiting room (needs 2+ players). |
| `restart_game` | `{}` | Clears board, scores and timer; refills the bag; redeals. |
| `new_game` | `{}` | After a finished game: reset the room to the waiting lobby. |
| `place_tiles` / `stage_tiles` | `{placements: [{rack_index, row, col, letter?}]}` | Tentative placement (on turn) / staged word (off turn). |
| `submit_word` | `{}` | Validate, score, draw, pass the turn (may start the last turn). |
| `pass` | `{}` | Pass, or accept a final play. |
| `swap_tiles` | `{indices: [...]}` | Needs at least 7 tiles in the bag. |
| `challenge_skip` | `{}` | Challenge the last play (dictionary check off). |
| `resign`, `skip_player` | `{}` | Give up / skip an offline player. |
| `pause_timer`, `resume_timer`, `skip_overtime` | `{}` | Wild timer controls. |

Server to client: `state` (full snapshot `{version, config, state}`) and `state_diff` (`{base, version, patch}`); a diff whose `base` does not match triggers a rejoin for a fresh snapshot.

Notable view fields: `status` (`waiting`/`playing`/`finished`), `board`, `rack`, `players`, `bag_count`, `tiles` (unseen tracker), `letter_values`, `auto_check`, `rules`, `language`, `show_distribution`, `settings_locked`, `final_round` (seats still owed a last turn), `plays` (plays on the board, for history and the victory stats), `definitions_locked`, `definition_words`, `winner`, `final`.

## Deploy (Railway / Render)

The app **must run as exactly one worker process** because rooms live in that process's memory; concurrency comes from eventlet green threads.

```
web: gunicorn -c gunicorn.conf.py -k eventlet -w 1 app:app
```

- **Railway**: push to GitHub, create a project from the repo, generate a domain.
- **Render**: Web Service, build `pip install -r requirements.txt`, start with the command above, health check `/healthz`.

| Variable | Meaning |
|---|---|
| `PORT` | Listen port (set by the platform) |
| `CORS_ALLOWED_ORIGINS` | Unset = same origin only; `*` or a comma-separated list otherwise |
| `WORDS_FILE` | Path to an alternative English word list |
| `LOG_LEVEL` | gunicorn log level |

A redeploy or restart ends all games, and free tiers that sleep drop idle games.

## Known limitations

- In-memory state, one worker; a restart loses all games.
- Socket.IO client, web font and definition lookups depend on external services.
- The Finnish, Swedish, French and Spanish word lists are not complete dictionaries.
- Turn-history arrows step through plays only (passes and swaps are skipped).

## TODO

- [ ] Persist rooms (SQLite/Redis) and support multiple workers.
- [ ] Accounts instead of anonymous session tokens; player avatars.
- [ ] In-game chat, spectators, GCG move-log export.
- [ ] Fuller official dictionaries per language.
- [ ] Self-host the Socket.IO client; add Playwright and Socket.IO integration tests.
