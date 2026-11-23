"""Extra Wild-board checks: layout properties, scoring on specific squares, growth."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from game.board import Board, GameError, Placement, initial_bounds
from game.scoring import WILD_CENTER, WILD_PERIOD, WILD_SIZE, letter_boost, premium_at, score_move


def P(r, c, ch):
    return Placement(r, c, ch, False)


class WildLayoutTests(unittest.TestCase):
    def grid(self):
        return [[premium_at(r, c, "wild") for c in range(WILD_SIZE)] for r in range(WILD_SIZE)]

    def test_mirror_symmetry(self):
        g = self.grid()
        for r in range(WILD_SIZE):
            for c in range(WILD_SIZE):
                self.assertEqual(g[r][c], g[r][24 - c])
                self.assertEqual(g[r][c], g[24 - r][c])

    def test_square_counts(self):
        flat = [k for row in self.grid() for k in row if k]
        self.assertEqual(flat.count("TW"), 4)
        self.assertEqual(flat.count("TL"), 32)
        self.assertEqual(flat.count("DW"), 56)
        self.assertEqual(flat.count("DL"), 76)

    def test_repeats_with_negative_and_large_coordinates(self):
        for r, c in ((6, 6), (3, 5), (12, 12), (0, 2)):
            kind = premium_at(r, c, "wild")
            for dr, dc in ((-24, 0), (0, 24), (48, -24), (-24, -24)):
                self.assertEqual(premium_at(r + dr, c + dc, "wild"), kind)
        self.assertEqual(WILD_PERIOD, 24)

    def test_centre_plain_and_letter_boost(self):
        self.assertIsNone(premium_at(*WILD_CENTER, "wild"))
        self.assertEqual(letter_boost(5, 5, "wild"), 3)
        self.assertEqual(letter_boost(3, 2, "wild"), 2)
        self.assertEqual(letter_boost(12, 12, "wild"), 1)


class WildBoardTests(unittest.TestCase):
    def test_start_square_and_bounds(self):
        b = Board()
        self.assertEqual(b.center, (12, 12))
        self.assertEqual(b.bounds(), {"top": 0, "bottom": 24, "left": 0, "right": 24})
        self.assertEqual(Board(classic=True).center, (7, 7))

    def test_first_word_must_cover_wild_centre(self):
        with self.assertRaises(GameError):
            Board().analyze([P(7, 7, "A"), P(7, 8, "B")])
        words = Board().analyze([P(12, 11, "A"), P(12, 12, "B")])
        self.assertEqual(words[0].text, "AB")

    def test_first_word_on_centre_has_no_word_bonus(self):
        words = Board().analyze([P(12, 12, "A"), P(12, 13, "B")])  # no premium on either square
        self.assertEqual(score_move(words, 2, "en", "wild").total, 1 + 3)

    def test_word_through_triple_word_square(self):
        b = Board()
        b.place_all([P(6, 5, "A"), P(6, 7, "A")])
        words = b.analyze([P(6, 6, "B")])
        self.assertEqual(words[0].text, "ABA")
        # 3W at (6,6): (1 + 3 + 1) * 3
        self.assertEqual(score_move(words, 1, "en", "wild").total, 15)

    def test_board_grows_in_wild_after_edge_tiles(self):
        b = Board()
        b.place_all([P(12, 20, "A")])
        self.assertTrue(b.expand_to_margin(7))
        self.assertEqual(b.bounds()["right"], 27)
        self.assertEqual(initial_bounds()["right"], 24)


if __name__ == "__main__":
    unittest.main()
