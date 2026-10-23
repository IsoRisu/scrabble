# Changes

Unzip over your project (the zip holds `scrabble/...` with the same folder layout; unzip it next to your project
folder / merge it in). Only changed files are included.

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

## Rule files (wild_rules.txt, classic_rules.txt) - 23.10
Both files were compared with the code. Comments: none were left in the code, so nothing had to be removed.

Implemented
- **Wild board layout** (from `wild_rules.txt`): no triple-word squares. The corners are plain and the four
  edge-middle squares are triple letters; everything else is the classic pattern. Classic keeps the standard
  layout (it matches `classic_rules.txt`). `premium_at`, `letter_boost`, `word_factor`, `score_word` take a `mode`;
  the client gets `config.wild_premiums` and redraws the board when the mode changes. Tests read the board
  literals straight out of both rule files, so the layouts cannot drift from them.
- **"0 points? 0 points!"** easter egg in the move list when a play scores zero (a word made only of blanks).
- **Tile tracker** (`classic_rules.txt`, "Tile bag"): bag size, vowels, consonants, blanks and every unseen
  letter, shown in the side panel. Unseen = bag + other players' racks, so with an empty bag it is exactly the
  opponents' tiles. `view["tiles"]`, `tiles.VOWELS` (Finnish/Swedish count the umlauts and Y).
- **Resign** (`classic_rules.txt`): `Room.resign`, socket event `resign`, Resign button with confirmation. Two players:
  opponent wins. More players: tiles return to the bag, turn order skips the player, the game ends when one
  is left (that player wins whatever the scores). Resigned players can never win on points. Passing already asked
  for confirmation.
- **Move list definitions** (`classic_rules.txt`, "Turn history"): played words are links to Wiktionary in the
  room's language (history entries carry `words`).
- **Wild timer** (`wild_rules.txt`, "Timed Mission"): the timer is cosmetic in Wild: no automatic pass at zero, a
  reminder tone for the player on turn, any player can pause/resume (pausing silences the tone), and the host can
  skip the player once time is up (`pause_timer`, `resume_timer`, `skip_overtime`). Classic still passes
  automatically when the per-turn clock runs out.
- Tests: 163 now (`RulesFileTests`, `TileTrackerTests`, `ResignTests`, `WildTimerTests`). Two old tests were
  adjusted: the timer-expiry tests now use Classic, and the "language without a word list" test patches the
  word-list path (it relied on Swedish having no list, but `data/sv.txt` exists now).

Not implemented (needs a decision or data)
- Classic **game clock** (total time per player, -10 points on overtime, -10 per extra minute, forfeit when it is
  used up) and the **point** challenge rule / automatic word checking in Classic: Classic still has the per-turn
  timer and the "challenger loses their turn" rule. Both change the settings model; say if you want them.
- Letter League's **long-word dictionary** (17-21 letter words): `words.txt` stops at 15 letters and I cannot
  download a bigger list here. The engine has no length cap, so a longer list just works.
- Title-screen tiles, the talking tile bag and the "Nice!" messages are pure flavour and were skipped.

Files: app.py, game/room.py, game/scoring.py, game/tiles.py, static/app.js, static/style.css, templates/game.html,
tests/test_game.py, README.md, CHANGES.md.

Not tested here: Socket.IO, the browser client (only `node --check` for syntax) and pip install, as agreed. The
rules engine is covered by `python -m unittest discover -s tests` (163 tests pass).

## Frontend update
- Bouncy tile placement animation (respects reduced-motion).
- Play word / Recall tiles moved directly under the board; board scales to fit window height.
- Opponent sees dashed outlines of tiles being placed (server sends positions only, never letters).
- Smoother zoom (rAF-batched, correct anchoring, Ctrl/Cmd+wheel zoom on desktop).
- Larger premium labels and tile point values at fit-zoom.
- Wild mode: taking the last tile from the bag gives every other player one final turn, then the game ends.
