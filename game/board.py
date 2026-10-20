"""Board state, placement legality and word extraction.

The board only knows about geometry: it checks that a set of new tiles forms a
legal placement and works out which words that placement creates. Whether the
words are in the dictionary, and what they score, is decided elsewhere.
"""
from collections import namedtuple
from dataclasses import dataclass

BOARD_SIZE = 15
CENTER = (7, 7)


class GameError(Exception):
    """A rule violation or bad request. The message is safe to show to players."""


# A tile being placed. For a blank tile `letter` is the letter the player
# chose and `blank` is True.
Placement = namedtuple("Placement", "row col letter blank")

# A tile that is on the board.
Tile = namedtuple("Tile", "letter blank")


@dataclass(frozen=True)
class WordCell:
    row: int
    col: int
    letter: str
    blank: bool
    new: bool  # placed this turn (premium squares only count for new tiles)


@dataclass(frozen=True)
class Word:
    cells: tuple

    @property
    def text(self):
        return "".join(cell.letter for cell in self.cells)


class Board:
    def __init__(self):
        self.grid = [[None] * BOARD_SIZE for _ in range(BOARD_SIZE)]
        self.tile_count = 0

    # ---- basic access ------------------------------------------------
    @staticmethod
    def in_bounds(row, col):
        return 0 <= row < BOARD_SIZE and 0 <= col < BOARD_SIZE

    def get(self, row, col):
        if not self.in_bounds(row, col):
            return None
        return self.grid[row][col]

    def is_empty(self):
        return self.tile_count == 0

    def place_all(self, placements):
        for p in placements:
            if self.grid[p.row][p.col] is not None:
                raise GameError("That square is already taken.")
            self.grid[p.row][p.col] = Tile(p.letter, p.blank)
            self.tile_count += 1

    def remove_all(self, placements):
        """Take tiles back off the board (used when a challenge succeeds)."""
        for p in placements:
            if self.grid[p.row][p.col] is not None:
                self.grid[p.row][p.col] = None
                self.tile_count -= 1

    def to_dict(self):
        """JSON-friendly snapshot: {"row,col": {"l": letter, "b": is_blank}}."""
        return {
            f"{r},{c}": {"l": tile.letter, "b": tile.blank}
            for r, row in enumerate(self.grid)
            for c, tile in enumerate(row)
            if tile is not None
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
            if self.grid[p.row][p.col] is not None:
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
                cells.append(WordCell(row, col, tile.letter, tile.blank, (row, col) in new))
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
