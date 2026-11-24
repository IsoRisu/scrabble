"""Premium squares and move scoring."""
from dataclasses import dataclass

from .tiles import RACK_SIZE

BINGO_BONUS = 50

_TRIPLE_WORD = [(0, 0), (0, 7), (0, 14), (7, 0), (7, 14), (14, 0), (14, 7), (14, 14)]
_DOUBLE_WORD = [
    (1, 1), (2, 2), (3, 3), (4, 4), (1, 13), (2, 12), (3, 11), (4, 10),
    (10, 4), (11, 3), (12, 2), (13, 1), (10, 10), (11, 11), (12, 12), (13, 13),
    (7, 7),  # the centre star counts as a double word score
]
_TRIPLE_LETTER = [
    (1, 5), (1, 9), (5, 1), (5, 5), (5, 9), (5, 13),
    (9, 1), (9, 5), (9, 9), (9, 13), (13, 5), (13, 9),
]
_DOUBLE_LETTER = [
    (0, 3), (0, 11), (2, 6), (2, 8), (3, 0), (3, 7), (3, 14), (6, 2), (6, 6),
    (6, 8), (6, 12), (7, 3), (7, 11), (8, 2), (8, 6), (8, 8), (8, 12),
    (11, 0), (11, 7), (11, 14), (12, 6), (12, 8), (14, 3), (14, 11),
]

# (row, col) -> "TW" | "DW" | "TL" | "DL"   (the classic Scrabble layout)
PREMIUM = {}
for _kind, _squares in (
    ("TW", _TRIPLE_WORD), ("DW", _DOUBLE_WORD), ("TL", _TRIPLE_LETTER), ("DL", _DOUBLE_LETTER),
):
    for _square in _squares:
        PREMIUM[_square] = _kind

# The Wild layout is a 25x25 matrix with its start square at (12, 12) (no bonus).
# Rows are given for 0-6; rows 7-12 mirror rows 5-0 and rows 13-24 mirror rows 11-0.
# Columns are mirror-symmetric, so column 24 equals column 0 and the pattern repeats
# every WILD_PERIOD = 24 squares when the board grows past 25x25.
WILD_SIZE = 25
WILD_CENTER = (12, 12)
WILD_PERIOD = 24
_WILD_HALF = [
    {"DW": [2, 6, 10, 14, 18, 22]},
    {"TL": [1, 11, 13, 23], "DL": [6, 18]},
    {"DW": [3, 9, 15, 21]},
    {"DL": [2, 5, 7, 10, 14, 17, 19, 22]},
    {"DL": [0, 12, 24], "DW": [4, 8, 16, 20]},
    {"DL": [3, 9, 15, 21], "TL": [5, 7, 17, 19]},
    {"DW": [0, 12, 24], "DL": [1, 11, 13, 23], "TW": [6, 18]},
]


def _wild_row(r: int) -> dict[str, list[int]]:
    r = r if r <= 12 else 24 - r
    return _WILD_HALF[r if r <= 6 else 12 - r]


# (row, col) -> kind for the 24x24 repeating tile (row/col 24 wrap onto 0).
WILD_PREMIUM = {
    (r, c): kind
    for r in range(WILD_PERIOD)
    for kind, cols in _wild_row(r).items()
    for c in cols
    if c < WILD_PERIOD
}


# The premium pattern repeats every PERIOD squares in both directions (the classic
# 15x15 pattern shares its outer rows/columns), so the board can grow forever and
# new squares still get bonuses.  Python's modulo handles negative coordinates.
PERIOD = 14


def premium_at(row: int, col: int, mode: str = "classic") -> str | None:
    """"TW" | "DW" | "TL" | "DL" for any square on the (unbounded) board, or None.

    `mode` picks the layout: "classic" (standard 15x15) or "wild" (25x25 matrix).
    """
    if mode == "wild":
        return WILD_PREMIUM.get((row % WILD_PERIOD, col % WILD_PERIOD))
    return PREMIUM.get((row % PERIOD, col % PERIOD))


def letter_boost(row: int, col: int, mode: str = "classic") -> int:
    """The letter multiplier a tile earns by landing on (row, col): 2, 3 or 1."""
    return {"DL": 2, "TL": 3}.get(premium_at(row, col, mode), 1)


def word_factor(word, mode: str = "classic") -> int:
    """The word multiplier earned by the new tiles of `word` (DW = 2, TW = 3, stacking)."""
    factor = 1
    for cell in word.cells:
        if cell.new:
            premium = premium_at(cell.row, cell.col, mode)
            if premium == "DW":
                factor *= 2
            elif premium == "TW":
                factor *= 3
    return factor


@dataclass(frozen=True)
class MoveScore:
    total: int
    word_scores: tuple  # one score per word, in the same order as the words
    bingo: bool
    bonus: int = 0  # what the bingo added on top of the word scores


def score_word(word, lang: str = "en", mode: str = "classic") -> int:
    """Score one word. Premium squares only apply to tiles placed this turn.

    Tiles already on the board count at their face value times the boost they
    earned earlier (always 1 in Classic, 2 or 3 in Wild for tiles that were
    placed on a letter premium).
    """
    letters = 0
    for cell in word.cells:
        value = 0 if cell.blank else tile_value(cell.letter, lang) * cell.boost
        if cell.new:
            premium = premium_at(cell.row, cell.col, mode)
            if premium == "DL":
                value *= 2
            elif premium == "TL":
                value *= 3
        letters += value
    return letters * word_factor(word, mode)


def score_move(words, tiles_placed: int, lang: str = "en", mode: str = "classic") -> MoveScore:
    """Total score for a play: every word formed plus the bingo bonus.

    Using all seven tiles is a bingo.  Classic scoring adds a flat 50 points.  Wild
    scoring doubles the value of the main word (the first one) instead; the
    perpendicular words are unaffected.
    """
    word_scores = tuple(score_word(word, lang, mode) for word in words)
    bingo = tiles_placed == RACK_SIZE
    bonus = 0
    if bingo:
        bonus = word_scores[0] if mode == "wild" else BINGO_BONUS
    return MoveScore(total=sum(word_scores) + bonus, word_scores=word_scores, bingo=bingo, bonus=bonus)
