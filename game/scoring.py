"""Premium squares and move scoring."""
from dataclasses import dataclass

from .tiles import RACK_SIZE, tile_value

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

# The Wild (Letter League) layout from wild_rules.txt: there are no triple word
# squares.  The four edge-centre TW squares become triple letters and the corners are
# plain squares; everything else is the classic pattern.
WILD_PREMIUM = {}
for _square, _kind in PREMIUM.items():
    if _kind == "TW":
        if _square in ((0, 0), (0, 14), (14, 0), (14, 14)):
            continue
        _kind = "TL"
    WILD_PREMIUM[_square] = _kind


# The premium pattern repeats every PERIOD squares in both directions (the classic
# 15x15 pattern shares its outer rows/columns), so the board can grow forever and
# new squares still get bonuses.  Python's modulo handles negative coordinates.
PERIOD = 14


def premium_at(row, col, mode="classic"):
    """"TW" | "DW" | "TL" | "DL" for any square on the (unbounded) board, or None.

    `mode` picks the layout: "classic" (standard Scrabble) or "wild" (no triple word squares).
    """
    table = WILD_PREMIUM if mode == "wild" else PREMIUM
    return table.get((row % PERIOD, col % PERIOD))


def letter_boost(row, col, mode="classic"):
    """The letter multiplier a tile earns by landing on (row, col): 2, 3 or 1."""
    return {"DL": 2, "TL": 3}.get(premium_at(row, col, mode), 1)


def word_factor(word, mode="classic"):
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


def score_word(word, lang="en", mode="classic"):
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


def score_move(words, tiles_placed, lang="en", mode="classic"):
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
