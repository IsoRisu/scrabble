"""Tile distribution and letter values for standard Scrabble."""
import random

RACK_SIZE = 7
BLANK = "?"

# Language-specific tile distributions (100 tiles total except FR=102).
TILE_DISTRIBUTIONS = {
    "en": {
        "A": 9, "B": 2, "C": 2, "D": 4, "E": 12, "F": 2, "G": 3, "H": 2, "I": 9,
        "J": 1, "K": 1, "L": 4, "M": 2, "N": 6, "O": 8, "P": 2, "Q": 1, "R": 6,
        "S": 4, "T": 6, "U": 4, "V": 2, "W": 2, "X": 1, "Y": 2, "Z": 1,
        BLANK: 2,
    },
    "fi": {
        "A": 10, "B": 1, "C": 1, "D": 1, "E": 8, "F": 1, "G": 1, "H": 2, "I": 10,
        "J": 2, "K": 5, "L": 5, "M": 3, "N": 9, "O": 5, "P": 2, "R": 2, "S": 7,
        "T": 9, "U": 4, "V": 2, "Y": 2, "Ä": 5, "Ö": 1,
        BLANK: 2,
    },
    "fr": {
        "A": 9, "B": 2, "C": 2, "D": 3, "E": 15, "F": 2, "G": 2, "H": 2, "I": 8,
        "J": 1, "K": 1, "L": 5, "M": 3, "N": 6, "O": 6, "P": 2, "Q": 1, "R": 6,
        "S": 6, "T": 6, "U": 6, "V": 2, "W": 1, "X": 1, "Y": 1, "Z": 1,
        BLANK: 2,
    },
    "es": {
        "A": 12, "B": 2, "C": 4, "CH": 1, "D": 5, "E": 12, "F": 1, "G": 2, "H": 2, "I": 6,
        "J": 1, "L": 4, "LL": 1, "M": 2, "N": 5, "Ñ": 1, "O": 9, "P": 2, "Q": 1, "R": 5,
        "RR": 1, "S": 6, "T": 4, "U": 5, "V": 1, "X": 1, "Y": 1, "Z": 1,
        BLANK: 2,
    },
    "sv": {
        "A": 8, "B": 2, "C": 1, "D": 5, "E": 7, "F": 2, "G": 3, "H": 2, "I": 5,
        "J": 1, "K": 3, "L": 5, "M": 3, "N": 6, "O": 5, "P": 2, "R": 8,
        "S": 8, "T": 8, "U": 3, "V": 2, "X": 1, "Y": 1, "Z": 1, "Å": 2, "Ä": 2, "Ö": 2,
        BLANK: 2,
    },
}

# Face value of each tile.
TILE_VALUES = {
    "en": {
        "A": 1, "B": 3, "C": 3, "D": 2, "E": 1, "F": 4, "G": 2, "H": 4, "I": 1,
        "J": 8, "K": 5, "L": 1, "M": 3, "N": 1, "O": 1, "P": 3, "Q": 10, "R": 1,
        "S": 1, "T": 1, "U": 1, "V": 4, "W": 4, "X": 8, "Y": 4, "Z": 10,
        BLANK: 0,
    },
    "fi": {
        "A": 1, "B": 8, "C": 10, "D": 7, "E": 1, "F": 8, "G": 8, "H": 4, "I": 1,
        "J": 4, "K": 2, "L": 2, "M": 3, "N": 1, "O": 2, "P": 4, "R": 4, "S": 1,
        "T": 1, "U": 3, "V": 4, "Y": 4, "Ä": 2, "Ö": 7,
        BLANK: 0,
    },
    "fr": {
        "A": 1, "B": 3, "C": 3, "D": 2, "E": 1, "F": 4, "G": 2, "H": 4, "I": 1,
        "J": 8, "K": 10, "L": 1, "M": 2, "N": 1, "O": 1, "P": 3, "Q": 8, "R": 1,
        "S": 1, "T": 1, "U": 1, "V": 4, "W": 10, "X": 10, "Y": 10, "Z": 10,
        BLANK: 0,
    },
    "es": {
        "A": 1, "B": 3, "C": 3, "CH": 5, "D": 2, "E": 1, "F": 4, "G": 2, "H": 4, "I": 1,
        "J": 8, "L": 1, "LL": 8, "M": 3, "N": 1, "Ñ": 8, "O": 1, "P": 3, "Q": 5, "R": 1,
        "RR": 8, "S": 1, "T": 1, "U": 1, "V": 4, "X": 8, "Y": 4, "Z": 10,
        BLANK: 0,
    },
    "sv": {
        "A": 1, "B": 3, "C": 8, "D": 1, "E": 1, "F": 3, "G": 2, "H": 2, "I": 1,
        "J": 7, "K": 2, "L": 1, "M": 2, "N": 1, "O": 2, "P": 3, "R": 1,
        "S": 1, "T": 1, "U": 3, "V": 3, "X": 8, "Y": 7, "Z": 8, "Å": 4, "Ä": 3, "Ö": 4,
        BLANK: 0,
    },
}

def tile_value(tile, lang="en"):
    """Points for a rack tile: a letter, or BLANK."""
    return TILE_VALUES.get(lang, TILE_VALUES["en"]).get(tile, 0)


def new_bag(lang="en", rng=None):
    """Return a freshly shuffled bag containing all tiles for a language."""
    rng = rng or random.Random()
    dist = TILE_DISTRIBUTIONS.get(lang, TILE_DISTRIBUTIONS["en"])
    bag = [tile for tile, count in dist.items() for _ in range(count)]
    rng.shuffle(bag)
    return bag
