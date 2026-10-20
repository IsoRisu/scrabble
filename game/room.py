"""Rooms: players, turn flow, rules enforcement and per-player state views.

A Room is the single source of truth for one game. The Socket.IO layer in
app.py never touches game state directly; it calls the methods here and then
sends each player their own view of the result.

Rule sets
---------
strict     Every word is checked against the dictionary when a play is
           submitted; invalid plays are rejected and the player can try again.
challenge  Any geometrically legal play is accepted. The opponent may then
           challenge it on their turn (``challenge_skip``): if a word is not in
           the dictionary the play is taken back and the player loses their
           turn; if all words are valid the challenger loses their own turn.
"""
import os
import random
import secrets
import threading
import time
from dataclasses import dataclass, field

from .board import BOARD_SIZE, Board, GameError, Placement
from .scoring import BINGO_BONUS, PREMIUM, score_move
from .tiles import BLANK, RACK_SIZE, TILE_VALUES, new_bag, tile_value

ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I
ROOM_CODE_LENGTH = 8
MAX_PLAYERS = 2
MAX_NAME_LENGTH = 20
HISTORY_LIMIT = 60
SCORELESS_TURN_LIMIT = 6  # consecutive passes/swaps/failed challenges that end the game
RULES = ("strict", "challenge")

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Everything the client needs to render the board that never changes.
CONFIG = {
    "size": BOARD_SIZE,
    "rack_size": RACK_SIZE,
    "bingo_bonus": BINGO_BONUS,
    "center": [7, 7],
    "premiums": {f"{r},{c}": kind for (r, c), kind in PREMIUM.items()},
    "values": dict(TILE_VALUES),
}


# --------------------------------------------------------------------------
# Dictionary
# --------------------------------------------------------------------------
_words = None
_words_lock = threading.Lock()


def load_words(path=None):
    """Read a one-word-per-line file into an upper-case frozenset."""
    path = path or os.environ.get("WORDS_FILE") or os.path.join(ROOT_DIR, "words.txt")
    with open(path, encoding="utf-8") as handle:
        words = (line.strip().upper() for line in handle)
        return frozenset(w for w in words if w.isascii() and w.isalpha())


def get_words():
    global _words
    if _words is None:
        with _words_lock:
            if _words is None:
                _words = load_words()
    return _words


def set_words(words):
    """Replace the dictionary (used by tests)."""
    global _words
    _words = frozenset(w.upper() for w in words)


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
    rack: list = field(default_factory=list)
    score: int = 0
    pending: list = field(default_factory=list)  # tentative placements (see Room.place_tiles)
    preview: dict = None
    # What this player's browser has already been sent (see app.push_all).
    sent_view: dict = None
    sent_version: int = 0


# --------------------------------------------------------------------------
# Room
# --------------------------------------------------------------------------
class Room:
    def __init__(self, code, rules="strict", rng=None):
        if rules not in RULES:
            raise GameError("Unknown rules.")
        self.code = code
        self.rules = rules
        self.rng = rng or random.Random()
        self.created = self.last_active = time.time()
        self.lock = threading.RLock()

        self.players = []
        self.board = Board()
        self.bag = []
        self.status = "waiting"  # waiting -> playing -> finished
        self.current = 0  # seat whose turn it is
        self.scoreless_turns = 0
        self.last_move = None  # the play the opponent may still challenge
        self.awaiting_final = False  # challenge rules: a player went out and may be challenged
        self.winner = None  # seat, "tie" or None
        self.final = None
        self.history = []
        self._history_count = 0
        self.version = 0

    # ---- players -----------------------------------------------------
    def add_player(self, name):
        if len(self.players) >= MAX_PLAYERS:
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

    def connected_count(self):
        return sum(1 for p in self.players if p.connected)

    def start(self):
        """Deal racks and pick who goes first (called once both players are in)."""
        self.bag = new_bag(self.rng)
        for player in self.players:
            player.rack = self._draw(RACK_SIZE)
        self.current = self.rng.randrange(len(self.players))
        self.status = "playing"
        self._log("system", f"Game started - {self.players[self.current].name} goes first.")

    # ---- internal helpers --------------------------------------------
    def _draw(self, count):
        return [self.bag.pop() for _ in range(min(count, len(self.bag)))]

    def _log(self, kind, text, seat=None):
        self._history_count += 1
        self.history.append({"n": self._history_count, "kind": kind, "seat": seat, "text": text})
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

    def _placements(self, player):
        return [Placement(p["row"], p["col"], p["letter"], p["blank"]) for p in player.pending]

    def _end_turn_scoreless(self, player):
        """Common tail of pass/swap: count the scoreless turn and move on."""
        self.scoreless_turns += 1
        self.last_move = None
        if self.scoreless_turns >= SCORELESS_TURN_LIMIT:
            self._finish(out_seat=None)
        else:
            self.current = 1 - player.seat

    # ---- tentative placement -----------------------------------------
    def place_tiles(self, player, items):
        """Set the player's tentative placement (replaces any previous one).

        `items` is a list of {"rack_index", "row", "col", "letter"}; `letter`
        is only needed for blank tiles. Only basic sanity is enforced here so
        that tiles can be dragged around freely; full legality is checked on
        submit and reported through the live `preview`.
        """
        self._require_free_turn(player)
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
                if len(letter) != 1 or not "A" <= letter <= "Z":
                    raise GameError("Choose a letter for the blank tile.")
                blank = True
            else:
                letter, blank = raw, False
            used_tiles.add(index)
            used_squares.add((row, col))
            pending.append(
                {"rack_index": index, "row": row, "col": col, "letter": letter, "blank": blank}
            )

        player.pending = pending
        player.preview = self._preview(player)

    def _preview(self, player):
        """What the current tentative placement would do, for the live score display."""
        if not player.pending:
            return None
        try:
            placements = self._placements(player)
            words = self.board.analyze(placements)
        except GameError as exc:
            return {"ok": False, "error": str(exc), "words": [], "total": None, "bingo": False}
        result = score_move(words, len(placements))
        entries = []
        for word, points in zip(words, result.word_scores):
            # In challenge mode validity is deliberately not revealed.
            valid = (word.text in get_words()) if self.rules == "strict" else None
            entries.append({"word": word.text, "score": points, "valid": valid})
        bad = [e["word"] for e in entries if e["valid"] is False]
        return {
            "ok": not bad,
            "error": ("Not in the dictionary: " + ", ".join(bad) + ".") if bad else None,
            "words": entries,
            "total": result.total,
            "bingo": result.bingo,
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
            bad = sorted({w.text for w in words if w.text not in get_words()})
            if bad:
                raise GameError("Not in the dictionary: " + ", ".join(bad) + ".")
        score = score_move(words, len(placements))

        # Take the tiles off the rack, draw replacements, put them on the board.
        used_indices = sorted({p["rack_index"] for p in player.pending})
        used_tiles = [player.rack[i] for i in used_indices]
        for index in reversed(used_indices):
            del player.rack[index]
        drawn = self._draw(len(used_indices))
        player.rack.extend(drawn)
        self.board.place_all(placements)
        player.score += score.total
        self._clear_pending(player)

        texts = [w.text for w in words]
        message = f"{player.name} played {', '.join(texts)} for {score.total}"
        message += f" (bingo, +{BINGO_BONUS}!)." if score.bingo else "."
        self._log("play", message, seat=player.seat)

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
                self.current = 1 - player.seat
                self._log("system", f"{player.name} played every tile. Challenge or pass to accept.")
            else:
                self._finish(out_seat=player.seat)
        else:
            self.current = 1 - player.seat
        return {"score": score.total, "words": texts, "bingo": score.bingo}

    def pass_turn(self, player):
        self._require_turn(player)
        self._clear_pending(player)
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
        invalid = [w for w in move["words"] if w not in get_words()]

        if invalid:
            # Challenge succeeded: take the play back. It is the challenger's
            # turn already, so the mover simply loses theirs.
            self.board.remove_all(move["placements"])
            mover.score -= move["score"]
            if move["drawn"]:
                del mover.rack[len(mover.rack) - len(move["drawn"]):]
            mover.rack.extend(move["used_tiles"])
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
            if self.scoreless_turns >= SCORELESS_TURN_LIMIT:
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
            if self.scoreless_turns >= SCORELESS_TURN_LIMIT:
                self._finish(out_seat=None)
            else:
                self.current = mover.seat
        return {"success": False, "invalid": []}

    # ---- end of game -------------------------------------------------
    def _finish(self, out_seat):
        """End the game. `out_seat` is the player who emptied their rack, if any."""
        self.status = "finished"
        self.awaiting_final = False
        for player in self.players:
            self._clear_pending(player)
        left = [sum(tile_value(t) for t in p.rack) for p in self.players]
        adjustments = [0] * len(self.players)
        if out_seat is None:
            for seat, points in enumerate(left):
                adjustments[seat] = -points
        else:
            for seat, points in enumerate(left):
                if seat != out_seat:
                    adjustments[seat] = -points
                    adjustments[out_seat] += points
        for player, delta in zip(self.players, adjustments):
            player.score += delta

        scores = [p.score for p in self.players]
        if scores[0] == scores[1]:
            self.winner = "tie"
        else:
            self.winner = 0 if scores[0] > scores[1] else 1
        self.final = {
            "out_seat": out_seat,
            "adjustments": adjustments,
            "racks": [list(p.rack) for p in self.players],
        }
        result = "It's a tie!" if self.winner == "tie" else f"{self.players[self.winner].name} wins!"
        self._log("system", f"Game over. {result}")

    # ---- views -------------------------------------------------------
    def view_for(self, player):
        """Everything `player` is allowed to see, as plain JSON-able data."""
        playing = self.status == "playing"
        mover = self.players[self.current] if playing else None

        pending = []
        if mover is not None:
            for p in mover.pending:
                entry = {"row": p["row"], "col": p["col"], "letter": p["letter"], "blank": p["blank"]}
                if mover is player:
                    entry["rack_index"] = p["rack_index"]
                pending.append(entry)

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
                }
                for p in self.players
            ],
            "bag_count": len(self.bag),
            "board": self.board.to_dict(),
            "pending": pending,
            "preview": player.preview if mover is player else None,
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

    def create(self, rules="strict"):
        with self._lock:
            self._purge_locked()
            if len(self._rooms) >= self.max_rooms:
                raise GameError("The server is busy right now. Please try again later.")
            code = new_room_code()
            while code in self._rooms:
                code = new_room_code()
            room = Room(code, rules)
            self._rooms[code] = room
            return room

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
