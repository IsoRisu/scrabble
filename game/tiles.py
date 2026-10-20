"""Tile distribution and letter values for standard English Scrabble."""
import random

RACK_SIZE = 7
BLANK = "?"

# Number of each tile in the 100-tile bag (including the two blanks).
TILE_DISTRIBUTION = {
    "A": 9, "B": 2, "C": 2, "D": 4, "E": 12, "F": 2, "G": 3, "H": 2, "I": 9,
    "J": 1, "K": 1, "L": 4, "M": 2, "N": 6, "O": 8, "P": 2, "Q": 1, "R": 6,
    "S": 4, "T": 6, "U": 4, "V": 2, "W": 2, "X": 1, "Y": 2, "Z": 1,
    BLANK: 2,
}

# Face value of each tile. A blank is worth nothing, even after it has been
# given a letter (that is tracked on the board, not here).
TILE_VALUES = {
    "A": 1, "B": 3, "C": 3, "D": 2, "E": 1, "F": 4, "G": 2, "H": 4, "I": 1,
    "J": 8, "K": 5, "L": 1, "M": 3, "N": 1, "O": 1, "P": 3, "Q": 10, "R": 1,
    "S": 1, "T": 1, "U": 1, "V": 4, "W": 4, "X": 8, "Y": 4, "Z": 10,
    BLANK: 0,
}

TOTAL_TILES = sum(TILE_DISTRIBUTION.values())  # 100


def tile_value(tile):
    """Points for a rack tile: a letter 'A'-'Z' or BLANK."""
    return TILE_VALUES.get(tile, 0)


def new_bag(rng=None):
    """Return a freshly shuffled bag containing all 100 tiles."""
    rng = rng or random.Random()
    bag = [tile for tile, count in TILE_DISTRIBUTION.items() for _ in range(count)]
    rng.shuffle(bag)
    return bag
