"""Rooms: players, turn flow, rules enforcement and per-player state views.

A Room is the single source of truth for one game. The Socket.IO layer in
app.py never touches game state directly; it calls the methods here and then
sends each player their own view of the result.

Game settings
-------------
Both settings can be changed by either player until the first turn has been
played (see ``Room.update_settings``); they are not chosen at room creation.

mode  (scoring and word checking)
  wild     The default. Every word is checked against the dictionary
           automatically (the live preview shows validity and invalid plays
           are rejected). Letters affected by a bonus keep it for good: a tile
           placed on a double/triple letter square keeps that multiplier, and
           every letter of a word that earned a double/triple word bonus keeps
           it too. Later words that use those letters score the improved
           values, but letters added to them later are not multiplied. A bingo
           doubles the main word instead of adding a flat 50 points.
  classic  Traditional Scrabble scoring: premium squares only count on the
           turn the tile is placed, and a bingo is worth a flat 50 points. Any
           geometrically legal play is accepted
           and the opponent may challenge it on their turn
           (``challenge_skip``): if a word is not in the dictionary the play is
           taken back and the player loses their turn; if all words are valid
           the challenger loses their own turn.

players (2-16): the game starts when that many have joined, or earlier when
        the host (first player) calls ``Room.start_now`` with at least two in.
        Only wild supports more than two; classic is two-player. Changeable
        until the game starts.

length  (tiles in the bag): short (50), medium (100, the standard set) or full (150).

timer   (per-turn clock): off, or 30s / 60s / 90s / 2m / 3m / 5m for each turn.
        The clock restarts on every turn.  Classic enforces it: when a player's clock runs
        out the server passes for them (``Room.expire_turn``).  In Wild it is only a
        reminder (as in Letter League): running out costs nothing, any player can pause or
        resume it (``pause_timer`` / ``resume_timer``) and, once it reached zero, the host
        may skip the player on turn (``skip_overtime``).

resign  (``Room.resign``): a player can give up at any time.  Their tiles go back into the
        bag and they leave the turn order; when one player is left that player wins.

Tile tracker: every view carries ``tiles`` - the tiles the player has not seen (the bag
        plus the other racks) with vowel / consonant / blank counts.  Once the bag is
        empty that is exactly the opponents' tiles.

Board layouts: Classic uses the standard premium squares; Wild uses the Letter League
        layout from ``wild_rules.txt`` (no triple-word squares, see game/scoring.py).

Staging (prep during the opponent's turn)
-----------------------------------------
A player who is *not* on turn can stage a word (``Room.stage_tiles``). It is
checked and scored live against the board as it is right now, and it is private:
nobody else ever sees it. Every time the room changes, staged tiles whose
squares were taken are dropped and the preview is recomputed. When the turn
reaches the player, the surviving staged tiles become their tentative
placement (``Player.pending``) with a fresh preview, ready for one click on
"Play word"; nothing is submitted automatically.
"""
import os
import random
import secrets
import threading
import time
from dataclasses import dataclass, field

from .board import BOARD_COLS, BOARD_ROWS, BOARD_SIZE, Board, GameError, Placement, classic_bounds, initial_bounds
from .scoring import BINGO_BONUS, PERIOD, PREMIUM, WILD_PREMIUM, letter_boost, score_move, word_factor
from .tiles import BLANK, LANGUAGES, RACK_SIZE, TILE_DISTRIBUTIONS, TILE_VALUES, VOWELS, new_bag, tile_value

ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I
ROOM_CODE_LENGTH = 8
MIN_PLAYERS = 2
MAX_PLAYERS = 16  # wild games; classic (challenge) rules stay strictly two-player
DEFAULT_PLAYERS = 2
MAX_NAME_LENGTH = 20
SKIP_GRACE = 30  # seconds a player on turn must be offline before the others may skip them
HISTORY_LIMIT = 60
SCORELESS_TURN_LIMIT = 6  # consecutive passes/swaps/failed challenges that end the game

# Game settings.  "wild" is the default mode.  Each mode implies a rule set for
# word checking: wild validates automatically ("strict"), classic uses
# challenges ("challenge").
MODES = ("wild", "classic")
DEFAULT_MODE = "wild"
MODE_RULES = {"wild": "strict", "classic": "challenge"}
# Tiles in the bag at the start of the game (racks are dealt from it).
LENGTHS = {"short": 50, "medium": 100, "full": 150}
DEFAULT_LENGTH = "medium"
RULES = tuple(MODE_RULES.values())
# Per-turn timer options: key -> seconds (0 = no timer).
TIMERS = {"off": 0, "30s": 30, "60s": 60, "90s": 90, "2m": 120, "3m": 180, "5m": 300}
DEFAULT_TIMER = "off"
DEFAULT_LANGUAGE = "en"
# Auto board expansion: the board starts as 27x19 and, when a tile lands within
# `expand_margin` rings of an edge, grows so that many empty rings surround all
# tiles.  The default margin equals the rack size, so a full-rack word can always
# be laid out away from any tile.  On by default in Wild only: Classic is the
# standard fixed 15x15 Scrabble board.  Either can be overridden explicitly.
DEFAULT_EXPAND_MARGIN = RACK_SIZE
MIN_EXPAND_MARGIN, MAX_EXPAND_MARGIN = 1, 10

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Everything the client needs to render the board that never changes.
CONFIG = {
    "size": BOARD_SIZE,
    "rows": BOARD_ROWS,
    "cols": BOARD_COLS,
    "bounds": initial_bounds(),  # Wild; Classic uses "classic_bounds"
    "classic_bounds": classic_bounds(),
    "premium_period": PERIOD,
    "rack_size": RACK_SIZE,
    "bingo_bonus": BINGO_BONUS,
    "center": [7, 7],
    "premiums": {f"{r},{c}": kind for (r, c), kind in PREMIUM.items()},
    "wild_premiums": {f"{r},{c}": kind for (r, c), kind in WILD_PREMIUM.items()},
    "values": {lang: dict(values) for lang, values in TILE_VALUES.items()},
    "alphabets": {lang: sorted(t for t in dist if t != BLANK) for lang, dist in TILE_DISTRIBUTIONS.items()},
    "default_language": DEFAULT_LANGUAGE,
    "modes": list(MODES),
    "default_mode": DEFAULT_MODE,
    "lengths": dict(LENGTHS),
    "default_length": DEFAULT_LENGTH,
    "timers": dict(TIMERS),
    "default_timer": DEFAULT_TIMER,
    "default_expand_margin": DEFAULT_EXPAND_MARGIN,
    "expand_margin_range": [MIN_EXPAND_MARGIN, MAX_EXPAND_MARGIN],
    "default_players": DEFAULT_PLAYERS,
    "player_range": [MIN_PLAYERS, MAX_PLAYERS],
}


# --------------------------------------------------------------------------
# Dictionary
# --------------------------------------------------------------------------
_words = {}  # language code -> frozenset of upper-case words
_words_lock = threading.Lock()


def dictionary_path(lang):
    """Word-list file for a language: words.txt for English, data/<lang>.txt for the rest."""
    if lang == DEFAULT_LANGUAGE:
        return os.environ.get("WORDS_FILE") or os.path.join(ROOT_DIR, "words.txt")
    return os.path.join(ROOT_DIR, "data", f"{lang}.txt")


def available_languages():
    """Languages that can be played: those with tiles and a bundled word list."""
    return [lang for lang in LANGUAGES if os.path.exists(dictionary_path(lang))]


def check_language(lang):
    if lang not in LANGUAGES:
        raise GameError("Unknown language.")
    if lang not in available_languages():
        raise GameError("No word list is installed for that language yet.")


def load_words(lang=DEFAULT_LANGUAGE):
    """Read a one-word-per-line file into an upper-case frozenset."""
    with open(dictionary_path(lang), encoding="utf-8") as handle:
        words = (line.strip().upper() for line in handle)
        return frozenset(w for w in words if w.isalpha())


def get_words(lang=DEFAULT_LANGUAGE):
    if lang not in _words:
        with _words_lock:
            if lang not in _words:
                _words[lang] = load_words(lang)
    return _words[lang]


def set_words(words, lang=DEFAULT_LANGUAGE):
    """Replace a language's dictionary (used by tests)."""
    with _words_lock:
        _words[lang] = frozenset(w.upper() for w in words)


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def clean_name(raw):
    """Normalise a player-supplied display name ('' if nothing usable)."""
    if not isinstance(raw, str):
        return ""
    printable = "".join(ch for ch in raw if ch.isprintable())
    return " ".join(printable.split())[:MAX_NAME_LENGTH]


def new_room_code():
    return "".join(secrets.choice(ROOM_CODE_ALPHABET) for _ in range(ROOM_CODE_LENGTH))


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def check_expand_margin(value):
    if not _is_int(value) or not MIN_EXPAND_MARGIN <= value <= MAX_EXPAND_MARGIN:
        raise GameError(f"Board margin must be a whole number from {MIN_EXPAND_MARGIN} to {MAX_EXPAND_MARGIN}.")


def check_capacity(length, players):
    """Every player needs a full rack from the bag, so the game length caps the player count."""
    if players * RACK_SIZE > LENGTHS[length]:
        raise GameError(
            f"A {length} game has {LENGTHS[length]} tiles, not enough for {players} players. "
            "Choose a longer game or fewer players."
        )


def length_for_players(players, preferred=DEFAULT_LENGTH):
    """The shortest game length that can deal every player a full rack (never shorter than `preferred`)."""
    order = sorted(LENGTHS, key=LENGTHS.get)
    for key in order[order.index(preferred):]:
        if players * RACK_SIZE <= LENGTHS[key]:
            return key
    return order[-1]


def check_players(mode, count):
    """Validate a room's player count for the given mode."""
    if not _is_int(count) or not MIN_PLAYERS <= count <= MAX_PLAYERS:
        raise GameError(f"A game needs {MIN_PLAYERS} to {MAX_PLAYERS} players.")
    if mode == "classic" and count != 2:
        raise GameError("Classic games are for two players. Use Wild for more.")


def diff_views(old, new):
    """Patch that turns view `old` into view `new` ({} if they are identical).

    Top-level keys are compared whole, except for the board which is patched
    cell by cell: {"board": {"set": {"r,c": tile}, "del": ["r,c"]}}.
    """
    patch = {}
    for key, value in new.items():
        if key != "board" and old.get(key) != value:
            patch[key] = value
    old_board, new_board = old.get("board", {}), new.get("board", {})
    changed = {k: v for k, v in new_board.items() if old_board.get(k) != v}
    removed = [k for k in old_board if k not in new_board]
    if changed or removed:
        patch["board"] = {"set": changed, "del": removed}
    return patch


@dataclass
class Player:
    token: str
    name: str
    seat: int
    sid: str = None
    connected: bool = False
    left_at: float = None  # room clock() value when the player's last socket dropped
    rack: list = field(default_factory=list)
    score: int = 0
    pending: list = field(default_factory=list)  # tentative placements (see Room.place_tiles)
    preview: dict = None
    staged: list = field(default_factory=list)  # word prepared off-turn (see Room.stage_tiles); private
    staged_preview: dict = None
    stage_note: str = None  # one-line explanation after staged tiles were loaded or blocked
    resigned: bool = False  # gave up: out of the turn order, tiles back in the bag
    # What this player's browser has already been sent (see app.push_all).
    sent_view: dict = None
    sent_version: int = 0


# --------------------------------------------------------------------------
# Room
# --------------------------------------------------------------------------
class Room:
    def __init__(self, code, mode=DEFAULT_MODE, length=DEFAULT_LENGTH, timer=DEFAULT_TIMER, rng=None, clock=None,
                 auto_expand=None, expand_margin=DEFAULT_EXPAND_MARGIN, max_players=DEFAULT_PLAYERS,
                 language=DEFAULT_LANGUAGE):
        if mode not in MODES:
            raise GameError("Unknown game type.")
        if length not in LENGTHS:
            raise GameError("Unknown game length.")
        if timer not in TIMERS:
            raise GameError("Unknown timer setting.")
        if auto_expand is not None and not isinstance(auto_expand, bool):
            raise GameError("Auto-expand must be on or off.")
        check_expand_margin(expand_margin)
        check_players(mode, max_players)
        check_capacity(length, max_players)
        check_language(language)
        self._auto_expand = auto_expand  # None = follow the mode's default
        self.expand_margin = expand_margin
        self.max_players = max_players  # the game starts when this many have joined
        self.code = code
        self.mode = mode
        self.length = length
        self.timer = timer
        self.language = language
        self.clock = clock or time.time  # injectable so tests can move time
        self.turn_deadline = None  # clock() value at which the current turn expires
        self.timer_paused_left = None  # seconds left on a paused (Wild) turn timer, else None
        self._clock_sig = None
        self._skippable_seen = None
        self.turns_played = 0  # plays, passes, swaps and challenges so far
        self.rng = rng or random.Random()
        self.created = self.last_active = time.time()
        self.lock = threading.RLock()

        self.players = []
        self.board = Board(classic=mode == "classic")
        self.bag = new_bag(self.language, self.rng, LENGTHS[self.length])
        self.status = "waiting"  # waiting -> playing -> finished
        self.current = 0  # seat whose turn it is
        self.scoreless_turns = 0
        self.last_move = None  # the play the opponent may still challenge
        self.awaiting_final = False  # challenge rules: a player went out and may be challenged
        self.final_round = None  # wild: seats that still get one last turn after the bag ran out
        self.winner = None  # seat, "tie" or None
        self.final = None
        self.history = []
        self._history_count = 0
        self.version = 0

    @property
    def rules(self):
        """How words are checked: 'strict' (automatic) or 'challenge'."""
        return MODE_RULES[self.mode]

    def active_players(self):
        """Players still in the game (everyone who has not resigned)."""
        return [p for p in self.players if not p.resigned]

    @property
    def scoreless_limit(self):
        """Consecutive scoreless turns that end the game: three full rounds."""
        return SCORELESS_TURN_LIMIT // 2 * max(len(self.active_players()), 2)

    def _next_seat(self, seat):
        """The next seat in turn order, skipping players who resigned."""
        count = len(self.players)
        nxt = (seat + 1) % count
        for _ in range(count):
            if not self.players[nxt].resigned:
                return nxt
            nxt = (nxt + 1) % count
        return (seat + 1) % count

    def host_seat(self):
        """The host: the first player who is still in the game."""
        for p in self.players:
            if not p.resigned:
                return p.seat
        return 0

    @property
    def auto_expand(self):
        """Whether the board grows automatically (explicit choice, else on for Wild only)."""
        if self._auto_expand is not None:
            return self._auto_expand
        return self.mode == "wild"

    @property
    def settings_locked(self):
        return self.turns_played > 0 or self.status == "finished"

    # ---- settings ----------------------------------------------------
    def update_settings(self, player, mode=None, length=None, timer=None, auto_expand=None, expand_margin=None,
                        max_players=None, language=None):
        """Change game type, length, timer, board expansion, and language. Only possible before the first turn."""
        if self.settings_locked:
            raise GameError("Settings can only be changed before the first turn is played.")
        if mode is not None and mode not in MODES:
            raise GameError("Unknown game type.")
        if length is not None and length not in LENGTHS:
            raise GameError("Unknown game length.")
        if timer is not None and timer not in TIMERS:
            raise GameError("Unknown timer setting.")
        if language is not None:
            check_language(language)
        if auto_expand is not None and not isinstance(auto_expand, bool):
            raise GameError("Auto-expand must be on or off.")
        if expand_margin is not None:
            check_expand_margin(expand_margin)
        length_arg = length
        mode = mode or self.mode
        length = length or self.length
        timer = timer or self.timer
        language = language or self.language
        expand_margin = expand_margin if expand_margin is not None else self.expand_margin
        new_max = max_players if max_players is not None else self.max_players
        if max_players is None and mode == "classic" and new_max != 2:
            new_max = 2  # classic is two-player only
        check_players(mode, new_max)
        auto_length = None
        if length_arg is None and new_max * RACK_SIZE > LENGTHS[length]:
            # The player count outgrew the bag and no length was chosen: pick one that fits.
            auto_length = length = length_for_players(new_max, length)
        check_capacity(length, new_max)
        if new_max != self.max_players and self.status != "waiting":
            raise GameError("The number of players can only be changed before the game starts.")
        if new_max < len(self.players):
            raise GameError("More players than that have already joined.")
        expand_before = (self.auto_expand, self.expand_margin)
        if auto_expand is not None:
            self._auto_expand = auto_expand
        if (mode, length, timer, expand_margin, new_max, language) == (
            self.mode, self.length, self.timer, self.expand_margin, self.max_players, self.language
        ) and self.auto_expand == expand_before[0]:
            return
        length_changed = length != self.length
        language_changed = language != self.language
        self.mode, self.length, self.timer = mode, length, timer
        if self.board.is_empty():  # settings are locked once a tile is down
            self.board = Board(classic=mode == "classic")
        self.expand_margin = expand_margin
        self.max_players = new_max
        self.language = language
        if (length_changed or language_changed) and self.status == "playing":
            self._deal()  # nobody has moved yet, so a fresh deal is fair
        for p in self.players:
            p.preview = self._preview(p)  # validity display depends on the mode
        label = {"wild": "Wild", "classic": "Classic"}[mode]
        clock = "no timer" if not TIMERS[timer] else f"{TIMERS[timer]}s per turn"
        grow = f"board grows with {self.expand_margin}-ring margin" if self.auto_expand else "fixed board"
        self._log(
            "system",
            f"{player.name} set the game to {label} scoring, {length} length "
            f"({LENGTHS[length]} tiles), {clock}, {grow}, {self.max_players} players, language {language}.",
        )
        if auto_length:
            self._log("system", f"The game length was raised to {length} so every player gets a full rack.")
        self.maybe_start()  # lowering the player count may make the room full

    # ---- players -----------------------------------------------------
    def add_player(self, name):
        if len(self.players) >= self.max_players:
            raise GameError("This room is full.")
        seat = len(self.players)
        name = clean_name(name) or f"Player {seat + 1}"
        if any(p.name.lower() == name.lower() for p in self.players):
            name = f"{name[: MAX_NAME_LENGTH - 2]} 2"
        player = Player(token=secrets.token_urlsafe(18), name=name, seat=seat)
        self.players.append(player)
        return player

    def player_by_token(self, token):
        if not isinstance(token, str) or not token:
            return None
        candidate = token.encode("utf-8")
        for player in self.players:
            if secrets.compare_digest(player.token.encode("ascii"), candidate):
                return player
        return None

    def touch(self):
        """Record a change: bumps the version and the activity clock."""
        self.version += 1
        self.last_active = time.time()
        self._sync_clock()  # a new turn gets a fresh clock the moment the action lands
        self._reconcile_staged()  # revalidate prepared words / load them when their turn starts

    def player_joined(self, player, sid):
        """Bind a (new) socket to the player and mark them online."""
        player.sid = sid
        player.connected = True
        player.left_at = None

    def player_left(self, player):
        """The player's socket dropped; remember when, so an abandoned turn can be skipped."""
        player.connected = False
        player.sid = None
        player.left_at = self.clock()

    def skippable_seat(self):
        """Seat of the player on turn if they have been offline long enough to be skipped, else None."""
        if self.status != "playing":
            return None
        player = self.players[self.current]
        if player.connected or player.left_at is None:
            return None
        return player.seat if self.clock() - player.left_at >= SKIP_GRACE else None

    def skip_player(self, requester, seat):
        """Pass for an abandoned player (offline for SKIP_GRACE seconds) so the game can go on."""
        if self.status != "playing":
            raise GameError("The game is not in progress.")
        target = self.skippable_seat()
        if target is None or seat != target:
            raise GameError(f"A player can only be skipped after being offline for {SKIP_GRACE} seconds.")
        if requester.seat == target:
            raise GameError("You cannot skip yourself.")
        away = self.players[target]
        self._log("system", f"{requester.name} skipped {away.name}, who is offline.")
        self.pass_turn(away)  # also accepts a final play while one awaits a challenge
        return {}

    def connected_count(self):
        return sum(1 for p in self.players if p.connected)

    def start(self):
        """Deal racks and pick who goes first (called once both players are in)."""
        self._deal()
        self.current = self.rng.randrange(len(self.players))
        self.status = "playing"
        self._sync_clock()
        self._log("system", f"Game started - {self.players[self.current].name} goes first.")

    def maybe_start(self):
        """Start automatically once the room is full. True if the game started."""
        if self.status == "waiting" and MIN_PLAYERS <= len(self.players) == self.max_players:
            self.start()
            return True
        return False

    def start_now(self, player):
        """The host (first player) starts a wild game before the room is full."""
        if self.status != "waiting":
            raise GameError("The game has already started.")
        if player.seat != 0:
            raise GameError("Only the host can start the game.")
        if len(self.players) < MIN_PLAYERS:
            raise GameError("Waiting for at least one more player.")
        self.max_players = len(self.players)  # nobody else can join after this
        self.start()

    def _deal(self):
        """Fill the bag for the chosen length and deal fresh racks."""
        self.bag = new_bag(self.language, self.rng, LENGTHS[self.length])
        self.final_round = None
        for player in self.players:
            self._clear_pending(player)
            self._clear_staged(player)
            player.rack = self._draw(RACK_SIZE)

    # ---- turn clock --------------------------------------------------
    def _sync_clock(self):
        """(Re)start the turn clock whenever the turn, status or timer changed."""
        sig = (self.status, self.current, self.turns_played, self.awaiting_final, self.timer)
        if sig == self._clock_sig:
            return
        self._clock_sig = sig
        self.timer_paused_left = None  # every turn starts with a running clock
        seconds = TIMERS[self.timer]
        if self.status == "playing" and seconds:
            self.turn_deadline = self.clock() + seconds
        else:
            self.turn_deadline = None

    def expire_turn(self):
        """Pass for the player on turn if their clock has run out. True if something happened."""
        with self.lock:
            self._sync_clock()
            # The "skip" option appears once a player has been away long enough; tell the caller to push it.
            skippable = self.skippable_seat()
            flipped = skippable != self._skippable_seen
            self._skippable_seen = skippable
            if self.status != "playing" or self.turn_deadline is None:
                return flipped
            if self.mode == "wild":
                return flipped  # Wild: the timer is only a reminder, running out costs nothing
            if self.clock() < self.turn_deadline:
                return flipped
            player = self.players[self.current]
            self._log("system", f"{player.name} ran out of time.")
            self.pass_turn(player)  # also accepts a final play while one awaits a challenge
            self._sync_clock()
            return True

    # Wild: the turn timer is cosmetic.  Anybody can pause or resume it, and once it has
    # run out the host may skip the player on turn.
    def _require_wild_timer(self, player):
        if self.status != "playing":
            raise GameError("The game is not in progress.")
        if self.mode != "wild":
            raise GameError("The timer can only be paused in Wild games.")
        if not TIMERS[self.timer]:
            raise GameError("There is no timer in this game.")
        if player.resigned:
            raise GameError("You have resigned.")
        self._sync_clock()

    def pause_timer(self, player):
        self._require_wild_timer(player)
        if self.timer_paused_left is not None:
            raise GameError("The timer is already paused.")
        self.timer_paused_left = max(0.0, self.turn_deadline - self.clock())
        self.turn_deadline = None
        return {}

    def resume_timer(self, player):
        self._require_wild_timer(player)
        if self.timer_paused_left is None:
            raise GameError("The timer is not paused.")
        self.turn_deadline = self.clock() + self.timer_paused_left
        self.timer_paused_left = None
        return {}

    def timer_overtime(self):
        """True while a Wild turn timer is running past zero."""
        return (
            self.status == "playing" and self.mode == "wild" and self.turn_deadline is not None
            and self.clock() >= self.turn_deadline
        )

    def skip_overtime(self, requester):
        """The host skips the player on turn after their (Wild) turn timer ran out."""
        self._require_wild_timer(requester)
        if requester.seat != self.host_seat():
            raise GameError("Only the host can skip a player.")
        if not self.timer_overtime():
            raise GameError("That player's time is not up yet.")
        away = self.players[self.current]
        self._log("system", f"{requester.name} skipped {away.name}, whose time ran out.")
        self.pass_turn(away)
        return {}

    # ---- internal helpers --------------------------------------------
    def _draw(self, count):
        return [self.bag.pop() for _ in range(min(count, len(self.bag)))]

    def _log(self, kind, text, seat=None, words=None):
        """Add a move-history line.  `words` (plays only) lets the client link each word to a definition."""
        self._history_count += 1
        entry = {"n": self._history_count, "kind": kind, "seat": seat, "text": text}
        if words:
            entry["words"] = list(words)
        self.history.append(entry)
        del self.history[:-HISTORY_LIMIT]

    def _require_turn(self, player):
        if self.status == "waiting":
            raise GameError("Waiting for an opponent to join.")
        if self.status == "finished":
            raise GameError("The game is over.")
        if player.seat != self.current:
            raise GameError("It is not your turn.")

    def _require_free_turn(self, player):
        """Like _require_turn, but also refuses plays while a final play awaits a challenge."""
        self._require_turn(player)
        if self.awaiting_final:
            raise GameError(
                "Your opponent has gone out. Challenge their last play, or pass to accept it."
            )

    def _clear_pending(self, player):
        player.pending = []
        player.preview = None
        player.stage_note = None

    def _clear_staged(self, player):
        player.staged = []
        player.staged_preview = None

    @staticmethod
    def _to_placements(items):
        return [Placement(p["row"], p["col"], p["letter"], p["blank"]) for p in items]

    def _placements(self, player):
        return self._to_placements(player.pending)

    def _end_turn_scoreless(self, player):
        """Common tail of pass/swap: count the scoreless turn and move on."""
        self.scoreless_turns += 1
        self.last_move = None
        if self.scoreless_turns >= self.scoreless_limit:
            self._finish(out_seat=None)
        else:
            self.current = self._next_seat(player.seat)
            self._advance_final_round(player)

    def _advance_final_round(self, player):
        """Wild: once the last tile is drawn everyone else gets one last turn, then the game ends."""
        if self.final_round is None or self.status != "playing":
            return
        self.final_round.discard(player.seat)
        if not self.final_round:
            self._log("system", "Everyone has had their last turn.")
            self._finish(out_seat=None)

    # ---- tentative placement -----------------------------------------
    def place_tiles(self, player, items):
        """Set the player's tentative placement (replaces any previous one).

        `items` is a list of {"rack_index", "row", "col", "letter"}; `letter`
        is only needed for blank tiles. Only basic sanity is enforced here so
        that tiles can be dragged around freely; full legality is checked on
        submit and reported through the live `preview`.
        """
        self._require_free_turn(player)
        pending = self._parse_placements(player, items)
        player.stage_note = None
        player.pending = pending
        player.preview = self._preview(player)

    def stage_tiles(self, player, items):
        """Prepare a word while it is somebody else's turn (replaces any previous one).

        Same input and sanity checks as `place_tiles`, but it is stored apart
        from the tentative placement, checked against the board as it is now,
        and never shown to anyone else. When the turn reaches the player the
        staged tiles move into `pending` (see `_reconcile_staged`).
        """
        if self.status == "waiting":
            raise GameError("Waiting for an opponent to join.")
        if self.status == "finished":
            raise GameError("The game is over.")
        if player.resigned:
            raise GameError("You have resigned.")
        if player.seat == self.current:
            raise GameError("It is your turn - place your tiles directly.")
        if not player.rack:
            raise GameError("You have no tiles left to stage.")
        staged = self._parse_placements(player, items)
        player.stage_note = None
        player.staged = staged
        player.staged_preview = self._preview_items(staged)

    def _parse_placements(self, player, items):
        """Validate raw placement items against the board and the player's rack."""
        if not isinstance(items, list):
            raise GameError("Invalid placement.")
        if len(items) > len(player.rack):
            raise GameError("You are placing more tiles than you hold.")

        pending, used_tiles, used_squares = [], set(), set()
        for item in items:
            if not isinstance(item, dict):
                raise GameError("Invalid placement.")
            index, row, col = item.get("rack_index"), item.get("row"), item.get("col")
            if not (_is_int(index) and _is_int(row) and _is_int(col)):
                raise GameError("Invalid placement.")
            if not 0 <= index < len(player.rack):
                raise GameError("That tile is not on your rack.")
            if not self.board.in_bounds(row, col):
                raise GameError("That square is off the board.")
            if index in used_tiles:
                raise GameError("A tile can only be placed once.")
            if (row, col) in used_squares:
                raise GameError("Two tiles cannot share a square.")
            if self.board.get(row, col) is not None:
                raise GameError("That square is already taken.")
            raw = player.rack[index]
            if raw == BLANK:
                letter = item.get("letter")
                letter = letter.upper() if isinstance(letter, str) else ""
                if len(letter) != 1 or letter not in TILE_DISTRIBUTIONS[self.language] or letter == BLANK:
                    raise GameError("Choose a letter for the blank tile.")
                blank = True
            else:
                letter, blank = raw, False
            used_tiles.add(index)
            used_squares.add((row, col))
            pending.append(
                {"rack_index": index, "row": row, "col": col, "letter": letter, "blank": blank}
            )
        return pending

    def _reconcile_staged(self):
        """Keep every player's staged word in step with the room (runs on each change).

        * Game not running: staged words are discarded.
        * Not on turn: tiles whose square was just taken are dropped and the
          preview is recomputed against the new board.
        * On turn (and free to play): the surviving tiles become the tentative
          placement, with a fresh preview, and the staged word is emptied.
        """
        for player in self.players:
            if not player.staged:
                player.staged_preview = None
                continue
            if self.status != "playing":
                self._clear_staged(player)
                continue
            kept = [
                item for item in player.staged
                if 0 <= item["rack_index"] < len(player.rack)
                and self.board.in_bounds(item["row"], item["col"])
                and self.board.get(item["row"], item["col"]) is None
            ]
            dropped = len(player.staged) - len(kept)
            blocked = ""
            if dropped:
                noun = "tile was" if dropped == 1 else "tiles were"
                blocked = f"{dropped} staged {noun} blocked by the last play and removed."
            if player.seat == self.current and not self.awaiting_final:
                player.pending = kept
                player.preview = self._preview(player)
                self._clear_staged(player)
                loaded = "Your staged word is loaded - check it, then play it." if kept else ""
                player.stage_note = " ".join(part for part in (loaded, blocked) if part) or None
            else:
                player.staged = kept
                player.staged_preview = self._preview_items(kept)
                if blocked:
                    player.stage_note = blocked

    def _preview(self, player):
        """What the current tentative placement would do, for the live score display."""
        return self._preview_items(player.pending)

    def _preview_items(self, items):
        """What playing `items` (tentative or staged placements) would do on the board right now."""
        if not items:
            return None
        try:
            placements = self._to_placements(items)
            words = self.board.analyze(placements)
        except GameError as exc:
            return {"ok": False, "error": str(exc), "words": [], "total": None, "bingo": False}
        result = score_move(words, len(placements), self.language, self.mode)
        entries = []
        for word, points in zip(words, result.word_scores):
            # In challenge mode validity is deliberately not revealed.
            valid = (word.text in get_words(self.language)) if self.rules == "strict" else None
            entries.append({"word": word.text, "score": points, "valid": valid})
        bad = [e["word"] for e in entries if e["valid"] is False]
        return {
            "ok": not bad,
            "error": ("Not in the dictionary: " + ", ".join(bad) + ".") if bad else None,
            "words": entries,
            "total": result.total,
            "bingo": result.bingo,
            "bingo_bonus": result.bonus,
        }

    # ---- turn actions ------------------------------------------------
    def submit(self, player):
        """Commit the tentative placement as this player's move."""
        self._require_free_turn(player)
        if not player.pending:
            raise GameError("Place at least one tile first.")
        placements = self._placements(player)
        words = self.board.analyze(placements)
        if self.rules == "strict":
            bad = sorted({w.text for w in words if w.text not in get_words(self.language)})
            if bad:
                raise GameError("Not in the dictionary: " + ", ".join(bad) + ".")
        score = score_move(words, len(placements), self.language, self.mode)

        # Take the tiles off the rack, draw replacements, put them on the board.
        used_indices = sorted({p["rack_index"] for p in player.pending})
        used_tiles = [player.rack[i] for i in used_indices]
        for index in reversed(used_indices):
            del player.rack[index]
        drawn = self._draw(len(used_indices))
        player.rack.extend(drawn)
        # Wild scoring: letters affected by a bonus keep it for good.  A new tile on a
        # letter premium keeps that multiplier, and every letter of a word that got a
        # word multiplier (old tiles included) keeps it as well.  Tiles added to those
        # words later are not multiplied.
        boosts = {}
        if self.mode == "wild":
            boosts = {(p.row, p.col): letter_boost(p.row, p.col, self.mode) for p in placements}
        self.board.place_all(placements, boosts)
        if self.mode == "wild":
            factors = {}
            for word in words:
                factor = word_factor(word, self.mode)
                if factor > 1:
                    for cell in word.cells:
                        key = (cell.row, cell.col)
                        factors[key] = factors.get(key, 1) * factor
            self.board.multiply_boosts(factors)
        grew = self.auto_expand and self.board.expand_to_margin(self.expand_margin)
        self.turns_played += 1
        player.score += score.total
        self._clear_pending(player)

        texts = [w.text for w in words]
        message = f"{player.name} played {', '.join(texts)} for {score.total}"
        message += f" (bingo, +{score.bonus}!)." if score.bingo else "."
        if score.total == 0:
            message += " 0 points? 0 points!"  # Letter League easter egg: a word made only of blanks
        self._log("play", message, seat=player.seat, words=texts)
        if grew:
            self._log("system", "The board expanded.")

        self.last_move = {
            "seat": player.seat,
            "placements": placements,
            "words": texts,
            "score": score.total,
            "drawn": drawn,
            "used_tiles": used_tiles,
            "prev_scoreless": self.scoreless_turns,
        }
        self.scoreless_turns = 0

        if not player.rack:  # went out (the bag must be empty too)
            if self.rules == "challenge":
                # Give the opponent a chance to challenge before the game ends.
                self.awaiting_final = True
                self.current = self._next_seat(player.seat)
                self._log("system", f"{player.name} played every tile. Challenge or pass to accept.")
            else:
                self._finish(out_seat=player.seat)
        else:
            self.current = self._next_seat(player.seat)
            if self.mode == "wild":
                if self.final_round is None and not self.bag and drawn:
                    self.final_round = {p.seat for p in self.active_players() if p.seat != player.seat}
                    self._log("system", "The last tile was taken - every other player gets one final turn.")
                    if not self.final_round:
                        self._finish(out_seat=None)
                else:
                    self._advance_final_round(player)
        return {"score": score.total, "words": texts, "bingo": score.bingo, "bingo_bonus": score.bonus}

    def pass_turn(self, player):
        self._require_turn(player)
        self._clear_pending(player)
        self.turns_played += 1
        if self.awaiting_final:
            self._log("system", f"{player.name} accepted the final play.")
            self._finish(out_seat=self.last_move["seat"])
            return {}
        self._log("pass", f"{player.name} passed.", seat=player.seat)
        self._end_turn_scoreless(player)
        return {}

    def swap(self, player, indices):
        """Exchange the tiles at the given rack indices with the bag."""
        self._require_free_turn(player)
        if not isinstance(indices, list) or not indices:
            raise GameError("Select the tiles you want to swap.")
        if not all(_is_int(i) and 0 <= i < len(player.rack) for i in indices):
            raise GameError("Invalid tile selection.")
        if len(set(indices)) != len(indices):
            raise GameError("Invalid tile selection.")
        if len(self.bag) < RACK_SIZE:
            raise GameError(f"Fewer than {RACK_SIZE} tiles are left in the bag, so you cannot swap.")

        self._clear_pending(player)
        self.turns_played += 1
        chosen = set(indices)
        returned = [t for i, t in enumerate(player.rack) if i in chosen]
        kept = [t for i, t in enumerate(player.rack) if i not in chosen]
        player.rack = kept + self._draw(len(returned))  # draw first, then return
        self.bag.extend(returned)
        self.rng.shuffle(self.bag)
        noun = "tile" if len(returned) == 1 else "tiles"
        self._log("swap", f"{player.name} swapped {len(returned)} {noun}.", seat=player.seat)
        self._end_turn_scoreless(player)
        return {}

    def challenge(self, player):
        """Challenge the opponent's last play (challenge rules only)."""
        self._require_turn(player)
        if self.rules != "challenge":
            raise GameError("Challenges are only available in challenge mode. Words are checked automatically here.")
        move = self.last_move
        if move is None or move["seat"] == player.seat:
            raise GameError("There is no play to challenge.")
        mover = self.players[move["seat"]]
        self._clear_pending(player)
        self.turns_played += 1
        invalid = [w for w in move["words"] if w not in get_words(self.language)]

        if invalid:
            # Challenge succeeded: take the play back. It is the challenger's
            # turn already, so the mover simply loses theirs.
            self.board.remove_all(move["placements"])
            if self.auto_expand:
                self.board.shrink_to_margin(self.expand_margin)  # undo any growth the play caused
            mover.score -= move["score"]
            if move["drawn"]:
                del mover.rack[len(mover.rack) - len(move["drawn"]):]
            mover.rack.extend(move["used_tiles"])
            self._clear_staged(mover)  # their rack was reshuffled by the take-back
            self.bag.extend(move["drawn"])
            self.rng.shuffle(self.bag)
            self.last_move = None
            self.awaiting_final = False
            self.scoreless_turns = move["prev_scoreless"] + 1
            self._log(
                "challenge",
                f"{player.name} challenged and won: {', '.join(invalid)} "
                f"{'is' if len(invalid) == 1 else 'are'} not valid. "
                f"{mover.name}'s play is removed and they lose their turn.",
                seat=player.seat,
            )
            if self.scoreless_turns >= self.scoreless_limit:
                self._finish(out_seat=None)
            return {"success": True, "invalid": invalid}

        # Challenge failed: every word is fine, so the challenger loses their turn.
        self.last_move = None
        self._log(
            "challenge",
            f"{player.name} challenged {', '.join(move['words'])}, which is valid. "
            f"{player.name} loses their turn.",
            seat=player.seat,
        )
        if self.awaiting_final:
            # The player who went out was right, so the game ends now.
            self._finish(out_seat=mover.seat)
        else:
            self.scoreless_turns += 1
            if self.scoreless_turns >= self.scoreless_limit:
                self._finish(out_seat=None)
            else:
                self.current = mover.seat
        return {"success": False, "invalid": []}

    def resign(self, player):
        """Give up (at any time during the game).

        The player's tiles go back into the bag and they drop out of the turn order.  When only
        one player is left that player wins; otherwise the game goes on without the quitter.
        """
        if self.status == "waiting":
            raise GameError("The game has not started yet.")
        if self.status == "finished":
            raise GameError("The game is over.")
        if player.resigned:
            raise GameError("You have already resigned.")
        was_on_turn = player.seat == self.current
        player.resigned = True
        self._clear_pending(player)
        self._clear_staged(player)
        if player.rack:
            self.bag.extend(player.rack)
            self.rng.shuffle(self.bag)
            player.rack = []
        self.turns_played += 1
        self._log("system", f"{player.name} resigned.", seat=player.seat)
        if len(self.active_players()) <= 1:
            self._finish(out_seat=None, by_resignation=True)
            return {}
        if self.last_move is not None and self.last_move["seat"] == player.seat:
            self.last_move = None  # nobody can challenge a play that has left the game
        if was_on_turn:
            self.awaiting_final = False
            self.current = self._next_seat(player.seat)
        if self.final_round is not None:
            self.final_round.discard(player.seat)
            if self.bag:  # tiles went back into the bag: not the last round any more
                self.final_round = None
            elif not self.final_round:
                self._finish(out_seat=None)
        return {}

    # ---- end of game -------------------------------------------------
    def _finish(self, out_seat, by_resignation=False):
        """End the game. `out_seat` is the player who emptied their rack, if any.

        With `by_resignation` everybody else gave up: the last player standing wins and no
        unplayed-tile adjustments are made.
        """
        self.status = "finished"
        self.awaiting_final = False
        self.turn_deadline = None
        self.timer_paused_left = None
        for player in self.players:
            self._clear_pending(player)
            self._clear_staged(player)
        left = [sum(tile_value(t, self.language) for t in p.rack) for p in self.players]
        adjustments = [0] * len(self.players)
        if by_resignation:
            pass
        elif out_seat is None:
            for seat, points in enumerate(left):
                adjustments[seat] = -points
        else:
            for seat, points in enumerate(left):
                if seat != out_seat:
                    adjustments[seat] = -points
                    adjustments[out_seat] += points
        for player, delta in zip(self.players, adjustments):
            player.score += delta

        contenders = self.active_players() or self.players  # a resigned player cannot win
        if by_resignation:
            winners = [contenders[0].seat]
        else:
            best = max(p.score for p in contenders)
            winners = [p.seat for p in contenders if p.score == best]
        self.winner = winners[0] if len(winners) == 1 else "tie"
        self.final = {
            "out_seat": out_seat,
            "winners": winners,
            "adjustments": adjustments,
            "racks": [list(p.rack) for p in self.players],
        }
        if by_resignation:
            result = f"{self.players[self.winner].name} wins - everyone else resigned!"
        elif self.winner == "tie":
            tied = " and ".join(self.players[s].name for s in winners)
            result = "It's a tie!" if len(self.players) == 2 else f"It's a tie between {tied}!"
        else:
            result = f"{self.players[self.winner].name} wins!"
        self._log("system", f"Game over. {result}")

    # ---- views -------------------------------------------------------
    def tile_tracker(self, player):
        """The tiles `player` has not seen: the bag plus every other player's rack.

        Once the bag is empty this is exactly the opponents' tiles.
        """
        unseen = list(self.bag)
        for other in self.players:
            if other is not player:
                unseen.extend(other.rack)
        letters = {}
        for tile in unseen:
            letters[tile] = letters.get(tile, 0) + 1
        vowels = sum(n for t, n in letters.items() if t in VOWELS[self.language])
        blanks = letters.get(BLANK, 0)
        return {
            "letters": letters,
            "vowels": vowels,
            "consonants": len(unseen) - vowels - blanks,
            "blanks": blanks,
            "total": len(unseen),
        }

    def view_for(self, player):
        """Everything `player` is allowed to see, as plain JSON-able data."""
        self._sync_clock()
        playing = self.status == "playing"
        mover = self.players[self.current] if playing else None
        ms_left = None
        if playing and self.turn_deadline is not None:
            ms_left = max(0, int((self.turn_deadline - self.clock()) * 1000))
        elif playing and self.timer_paused_left is not None:
            ms_left = int(self.timer_paused_left * 1000)

        # Tentative (unplayed) tiles are private: only the player who placed them sees them.
        pending = []
        if mover is not None and mover is player:
            for p in mover.pending:
                pending.append({
                    "row": p["row"], "col": p["col"], "letter": p["letter"], "blank": p["blank"],
                    "rack_index": p["rack_index"],
                })

        # The opponent sees WHERE tiles are being placed, never which letters.
        opp_pending = []
        if mover is not None and mover is not player:
            opp_pending = [[p["row"], p["col"]] for p in mover.pending]

        last = None
        if self.last_move is not None:
            last = {
                "seat": self.last_move["seat"],
                "cells": [[p.row, p.col] for p in self.last_move["placements"]],
                "words": list(self.last_move["words"]),
                "score": self.last_move["score"],
            }

        can_challenge = (
            self.rules == "challenge"
            and playing
            and player.seat == self.current
            and self.last_move is not None
            and self.last_move["seat"] != player.seat
        )
        return {
            "room": self.code,
            "rules": self.rules,
            "mode": self.mode,
            "length": self.length,
            "timer": self.timer,
            "language": self.language,
            "max_players": self.max_players,
            "skippable": self.skippable_seat() if player.seat != self.skippable_seat() else None,
            "can_start": self.status == "waiting" and player.seat == 0 and len(self.players) >= MIN_PLAYERS,
            "auto_expand": self.auto_expand,
            "expand_margin": self.expand_margin,
            "bounds": self.board.bounds(),
            "turn_ms_left": ms_left,
            "timer_paused": playing and self.timer_paused_left is not None,
            "host": self.host_seat(),
            "tiles": self.tile_tracker(player),
            "settings_locked": self.settings_locked,
            "status": self.status,
            "you": player.seat,
            "current": self.current if playing else None,
            "players": [
                {
                    "seat": p.seat,
                    "name": p.name,
                    "score": p.score,
                    "rack_count": len(p.rack),
                    "connected": p.connected,
                    "resigned": p.resigned,
                }
                for p in self.players
            ],
            "bag_count": len(self.bag),
            "board": self.board.to_dict(),
            "pending": pending,
            "opp_pending": opp_pending,
            "final_round": sorted(self.final_round) if self.final_round is not None and playing else None,
            "preview": player.preview if mover is player else None,
            # Prepared off-turn; only ever included in the owner's own view.
            "staged": [
                {"row": p["row"], "col": p["col"], "letter": p["letter"], "blank": p["blank"],
                 "rack_index": p["rack_index"]}
                for p in player.staged
            ] if playing else [],
            "staged_preview": player.staged_preview if playing else None,
            "stage_note": player.stage_note,
            "rack": list(player.rack),
            "last_move": last,
            "can_challenge": can_challenge,
            "awaiting_final": self.awaiting_final,
            "history": list(self.history),
            "winner": self.winner,
            "final": self.final,
        }


# --------------------------------------------------------------------------
# Registry
# --------------------------------------------------------------------------
class RoomRegistry:
    """All live rooms, held in memory. A restart forgets every game (see README TODOs)."""

    def __init__(self, max_rooms=2000, idle_ttl=24 * 3600, abandoned_ttl=2 * 3600):
        self._rooms = {}
        self._lock = threading.Lock()
        self.max_rooms = max_rooms
        self.idle_ttl = idle_ttl
        self.abandoned_ttl = abandoned_ttl

    def __len__(self):
        return len(self._rooms)

    @staticmethod
    def normalize(code):
        if not isinstance(code, str):
            return ""
        code = code.strip().upper()
        if len(code) != ROOM_CODE_LENGTH or any(ch not in ROOM_CODE_ALPHABET for ch in code):
            return ""
        return code

    def create(self, mode=DEFAULT_MODE, length=DEFAULT_LENGTH, timer=DEFAULT_TIMER,
               auto_expand=None, expand_margin=DEFAULT_EXPAND_MARGIN, max_players=DEFAULT_PLAYERS, language=DEFAULT_LANGUAGE):
        """Create a room. Settings default to Wild / full / no timer and can still be
        changed inside the room until the first turn is played."""
        with self._lock:
            self._purge_locked()
            if len(self._rooms) >= self.max_rooms:
                raise GameError("The server is busy right now. Please try again later.")
            code = new_room_code()
            while code in self._rooms:
                code = new_room_code()
            room = Room(code, mode=mode, length=length, timer=timer,
                        auto_expand=auto_expand, expand_margin=expand_margin, max_players=max_players,
                        language=language)
            self._rooms[code] = room
            return room

    def rooms(self):
        """Snapshot of all live rooms (used by the turn-clock loop)."""
        with self._lock:
            return list(self._rooms.values())

    def get(self, code):
        return self._rooms.get(self.normalize(code))

    def purge(self):
        with self._lock:
            self._purge_locked()

    def _purge_locked(self):
        now = time.time()
        for code, room in list(self._rooms.items()):
            idle = now - room.last_active
            abandoned = room.connected_count() == 0 and idle > self.abandoned_ttl
            if idle > self.idle_ttl or abandoned:
                del self._rooms[code]
