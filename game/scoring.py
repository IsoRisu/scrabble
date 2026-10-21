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

# (row, col) -> "TW" | "DW" | "TL" | "DL"
PREMIUM = {}
for _kind, _squares in (
    ("TW", _TRIPLE_WORD), ("DW", _DOUBLE_WORD), ("TL", _TRIPLE_LETTER), ("DL", _DOUBLE_LETTER),
):
    for _square in _squares:
        PREMIUM[_square] = _kind


def letter_boost(row, col):
    """The letter multiplier a tile earns by landing on (row, col): 2, 3 or 1."""
    return {"DL": 2, "TL": 3}.get(PREMIUM.get((row, col)), 1)


@dataclass(frozen=True)
class MoveScore:
    total: int
    word_scores: tuple  # one score per word, in the same order as the words
    bingo: bool


def score_word(word, lang="en"):
    """Score one word. Premium squares only apply to tiles placed this turn.

    Tiles already on the board count at their face value times the boost they
    earned earlier (always 1 in Classic, 2 or 3 in Wild for tiles that were
    placed on a letter premium).
    """
    letters = 0
    word_multiplier = 1
    for cell in word.cells:
        value = 0 if cell.blank else tile_value(cell.letter, lang) * cell.boost
        if cell.new:
            premium = PREMIUM.get((cell.row, cell.col))
            if premium == "DL":
                value *= 2
            elif premium == "TL":
                value *= 3
            elif premium == "DW":
                word_multiplier *= 2
            elif premium == "TW":
                word_multiplier *= 3
        letters += value
    return letters * word_multiplier


def score_move(words, tiles_placed, lang="en"):
    """Total score for a play: every word formed plus the 50-point bingo bonus."""
    word_scores = tuple(score_word(word, lang) for word in words)
    bingo = tiles_placed == RACK_SIZE
    total = sum(word_scores) + (BINGO_BONUS if bingo else 0)
    return MoveScore(total=total, word_scores=word_scores, bingo=bingo)
