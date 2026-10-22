# Changes

Unzip over your project (same folder layout). Only changed files are included.

## Board
- Wild: starts 27 columns x 19 rows around the centre star (7,7); coordinates may go negative. Classic: the standard fixed 15x15 board.
- Grows whenever a tile gets within `expand_margin` squares of an edge (default 7 = rack size,
  so a full-rack word always fits). Wild only. The client now rebuilds the grid from
  `state.bounds`, so expansion actually shows up (it was hard-wired to 15x15 before).
- The premium-square pattern repeats every 14 squares, so new squares keep getting bonuses.
- Zoom button works on every screen size; phones start zoomed.

## Scoring
- Wild: letters hit by a bonus keep it for good (DL/TL on the tile, DW/TW on every letter of the
  word); later letters added to that word are not multiplied. Boosted tiles are coloured in.
  A bingo doubles the main word; cross words are unaffected.
- Classic: bonuses only on the turn they are covered, flat 50-point bingo.
- English set: L = 2 points, sixth N replaced by a second K.
- Lengths: short 50, medium 100 (the full set), full 150. Default is medium.

## Multiplayer
- 2-16 players (Wild; the game length must hold a 7-tile rack each: short 7, medium 14, full 21; Classic stays two-player): player count in Game Settings, host "Start now"
  button, every seat gets its own colour (cards, move history); more than four seats use a compact two-column player list.
- Unplayed (tentative) tiles are no longer sent to other players at all.

## Rack
- Drag tiles left/right to reorder your rack (private, visual only).

## Files
game/board.py, game/scoring.py, game/tiles.py, game/room.py, app.py (docs only),
templates/game.html, templates/index.html, static/app.js, static/style.css, tests/test_game.py

## Follow-ups (23.10 comments implemented)
- Board: shrinks back after a successful Classic challenge (`Board.shrink_to_margin`).
- Lengths: raising the player count without choosing a length auto-raises the length; the settings dialog greys out lengths that cannot fit the players. `POST /create` accepts `max_players`, returns 400 (not 503) for impossible combinations; the landing page has a players select.
- Offline players: after 30 s offline, others get a "Skip (offline)" button (`skip_player` socket event, `Room.skip_player`).
- Client: mouse drag-to-pan, pinch zoom (remembered), minimap, Shuffle rack button, rack order persisted per room, per-seat colours, x4+ badge on boosted tiles.
- Tests: new `FollowUpTests`.
- Not changed (comments removed, no code change): Wild word-multiplier rule, "full" length, premium layout outside 15x15, 3+ player Classic, forfeit/kick.

Files also changed: templates/game.html, templates/index.html, static/style.css.
