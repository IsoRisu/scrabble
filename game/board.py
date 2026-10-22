"""Board state, placement legality and word extraction.

The board only knows about geometry: it checks that a set of new tiles forms a
legal placement and works out which words that placement creates. Whether the
words are in the dictionary, and what they score, is decided elsewhere.
"""
from collections import namedtuple
from dataclasses import dataclass

BOARD_SIZE = 15  # the classic grid the premium-square pattern is drawn on
# The playing area starts as 27 columns x 19 rows around the centre star and grows
# as tiles get close to an edge (see Board.expand_to_margin).
BOARD_ROWS, BOARD_COLS = 19, 27
CENTER = (7, 7)


def initial_bounds():
    """Playing area of a fresh board: {"top", "bottom", "left", "right"} (inclusive)."""
    top = CENTER[0] - (BOARD_ROWS - 1) // 2
    left = CENTER[1] - (BOARD_COLS - 1) // 2
    return {"top": top, "bottom": top + BOARD_ROWS - 1, "left": left, "right": left + BOARD_COLS - 1}


def classic_bounds():
    """The standard 15x15 Scrabble grid."""
    return {"top": 0, "bottom": BOARD_SIZE - 1, "left": 0, "right": BOARD_SIZE - 1}


class GameError(Exception):
    """A rule violation or bad request. The message is safe to show to players."""


# A tile being placed. For a blank tile `letter` is the letter the player
# chose and `blank` is True.
Placement = namedtuple("Placement", "row col letter blank")

# A tile that is on the board. `boost` is the letter multiplier the tile
# earned when it was placed (Wild scoring keeps it; Classic always uses 1).
Tile = namedtuple("Tile", "letter blank boost", defaults=(1,))


@dataclass(frozen=True)
class WordCell:
    row: int
    col: int
    letter: str
    blank: bool
    new: bool  # placed this turn (premium squares only count for new tiles)
    boost: int = 1  # permanent letter multiplier already earned by an old tile


@dataclass(frozen=True)
class Word:
    cells: tuple

    @property
    def text(self):
        return "".join(cell.letter for cell in self.cells)


class Board:
    def __init__(self, classic=False):
        # Sparse grid: (row, col) -> Tile.  Coordinates never shift; the
        # playable area is the rectangle below, which starts as 27x19 and grows
        # in any direction (negative coordinates are valid) when auto-expansion is on.
        self.grid = {}
        # Classic is the standard 15x15 Scrabble grid; Wild starts 27x19 and grows.
        start = self._start = classic_bounds() if classic else initial_bounds()
        self.top, self.left = start["top"], start["left"]
        self.bottom, self.right = start["bottom"], start["right"]

    @property
    def tile_count(self):
        return len(self.grid)

    # ---- basic access ------------------------------------------------
    def in_bounds(self, row, col):
        return self.top <= row <= self.bottom and self.left <= col <= self.right

    def bounds(self):
        return {"top": self.top, "bottom": self.bottom, "left": self.left, "right": self.right}

    def get(self, row, col):
        return self.grid.get((row, col))

    def is_empty(self):
        return not self.grid

    def expand_to_margin(self, margin):
        """Make sure at least `margin` empty rings surround every placed tile.

        A side only grows when a tile is within `margin` rings of it, and it
        grows exactly far enough to restore the margin.  It only shrinks again
        through shrink_to_margin (a successful challenge).  Returns True if any side grew.
        """
        if not self.grid:
            return False
        rows = [r for r, _ in self.grid]
        cols = [c for _, c in self.grid]
        new = (
            min(self.top, min(rows) - margin),
            min(self.left, min(cols) - margin),
            max(self.bottom, max(rows) + margin),
            max(self.right, max(cols) + margin),
        )
        changed = new != (self.top, self.left, self.bottom, self.right)
        self.top, self.left, self.bottom, self.right = new
        return changed

    def shrink_to_margin(self, margin):
        """Undo growth that is no longer needed (after tiles were taken back).

        The area is the starting rectangle plus `margin` rings around the remaining
        tiles - exactly what expand_to_margin would have built from scratch.
        Returns True if any side shrank.
        """
        start = self._start
        top, left, bottom, right = start["top"], start["left"], start["bottom"], start["right"]
        if self.grid:
            rows = [r for r, _ in self.grid]
            cols = [c for _, c in self.grid]
            top, left = min(top, min(rows) - margin), min(left, min(cols) - margin)
            bottom, right = max(bottom, max(rows) + margin), max(right, max(cols) + margin)
        changed = (top, left, bottom, right) != (self.top, self.left, self.bottom, self.right)
        self.top, self.left, self.bottom, self.right = top, left, bottom, right
        return changed

    def place_all(self, placements, boosts=None):
        """Put tiles on the board. `boosts` maps (row, col) -> permanent letter multiplier."""
        boosts = boosts or {}
        for p in placements:
            if (p.row, p.col) in self.grid:
                raise GameError("That square is already taken.")
            self.grid[(p.row, p.col)] = Tile(p.letter, p.blank, boosts.get((p.row, p.col), 1))

    def multiply_boosts(self, factors):
        """Multiply the permanent boost of tiles already on the board: {(row, col): factor}."""
        for key, factor in factors.items():
            tile = self.grid.get(key)
            if tile is not None and factor != 1:
                self.grid[key] = tile._replace(boost=tile.boost * factor)

    def remove_all(self, placements):
        """Take tiles back off the board (used when a challenge succeeds)."""
        for p in placements:
            self.grid.pop((p.row, p.col), None)

    def to_dict(self):
        """JSON-friendly snapshot: {"row,col": {"l": letter, "b": is_blank, "m": boost}}."""
        return {
            f"{r},{c}": {"l": tile.letter, "b": tile.blank, "m": tile.boost}
            for (r, c), tile in self.grid.items()
        }

    # ---- move analysis -----------------------------------------------
    def _touches_existing(self, row, col):
        """True if (row, col) is orthogonally next to a tile already on the board."""
        return any(
            self.get(row + dr, col + dc) is not None
            for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1))
        )

    def analyze(self, placements):
        """Check that `placements` is a legal play and return the words it forms.

        Raises GameError with a player-friendly message if it is not legal.
        The main word (or, for a single tile, the horizontal word first) comes
        first, followed by any cross words.  Dictionary checks are the
        caller's job.
        """
        if not placements:
            raise GameError("Place at least one tile.")

        new = {}
        for p in placements:
            if not self.in_bounds(p.row, p.col):
                raise GameError("A tile is off the board.")
            if (p.row, p.col) in new:
                raise GameError("Two tiles cannot share a square.")
            if (p.row, p.col) in self.grid:
                raise GameError("That square is already taken.")
            new[(p.row, p.col)] = Tile(p.letter, p.blank)

        rows = {r for r, _ in new}
        cols = {c for _, c in new}
        if len(rows) > 1 and len(cols) > 1:
            raise GameError("Tiles must all be placed in a single row or column.")

        first_move = self.is_empty()
        if first_move:
            if CENTER not in new:
                raise GameError("The first word must cover the centre star.")
            if len(new) < 2:
                raise GameError("The first word must be at least two letters long.")

        def at(r, c):
            if (r, c) in new:
                return new[(r, c)]
            return self.get(r, c)

        # No gaps: every square between the outermost new tiles must be filled
        # (by a new tile or by one already on the board).
        if len(new) > 1:
            if len(rows) == 1:
                row = next(iter(rows))
                span = [(row, c) for c in range(min(cols), max(cols) + 1)]
            else:
                col = next(iter(cols))
                span = [(r, col) for r in range(min(rows), max(rows) + 1)]
            if any(at(r, c) is None for r, c in span):
                raise GameError("Tiles must form one continuous word with no gaps.")

        # After the first move the play has to hook onto what is already there.
        if not first_move and not any(self._touches_existing(r, c) for r, c in new):
            raise GameError("Your word must connect to tiles already on the board.")

        def run(row, col, dr, dc):
            """The maximal line of tiles through (row, col) in direction (dr, dc)."""
            while at(row - dr, col - dc) is not None:
                row, col = row - dr, col - dc
            cells = []
            while at(row, col) is not None:
                tile = at(row, col)
                cells.append(
                    WordCell(row, col, tile.letter, tile.blank, (row, col) in new, tile.boost)
                )
                row, col = row + dr, col + dc
            return Word(tuple(cells))

        words = []
        if len(new) == 1:
            (row, col), = new
            for dr, dc in ((0, 1), (1, 0)):
                word = run(row, col, dr, dc)
                if len(word.cells) >= 2:
                    words.append(word)
        else:
            horizontal = len(rows) == 1
            first = next(iter(new))
            main_dir = (0, 1) if horizontal else (1, 0)
            cross_dir = (1, 0) if horizontal else (0, 1)
            words.append(run(first[0], first[1], *main_dir))
            for row, col in sorted(new):
                cross = run(row, col, *cross_dir)
                if len(cross.cells) >= 2:
                    words.append(cross)

        if not words:
            raise GameError("Your tiles must form a word of at least two letters.")
        return words
