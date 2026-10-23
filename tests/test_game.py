"""Unit tests for the rules engine. Run with:  python -m unittest discover -s tests -v"""
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from game import room as room_module  # noqa: E402
from game.board import Board, GameError, Placement, initial_bounds  # noqa: E402
from game.room import (  # noqa: E402
    CONFIG, Room, RoomRegistry, clean_name, diff_views, load_words, set_words,
)
from game.scoring import PREMIUM, WILD_PREMIUM, premium_at, score_move  # noqa: E402
from game.tiles import BLANK, LANGUAGES, TILE_DISTRIBUTIONS, TILE_VALUES, new_bag  # noqa: E402

TILE_DISTRIBUTION = TILE_DISTRIBUTIONS["en"]
TILE_VALUES_EN = TILE_VALUES["en"]


def P(row, col, letter, blank=False):
    return Placement(row, col, letter, blank)


def word_placements(word, row, col, horizontal=True):
    return [
        P(row, col + i, ch) if horizontal else P(row + i, col, ch)
        for i, ch in enumerate(word)
    ]


class TileTests(unittest.TestCase):
    def test_bag_has_standard_distribution(self):
        bag = new_bag("en", random.Random(1))
        self.assertEqual(len(bag), 100)
        for tile, count in TILE_DISTRIBUTION.items():
            self.assertEqual(bag.count(tile), count, tile)
        self.assertEqual(bag.count(BLANK), 2)

    def test_total_face_value(self):
        total = sum(TILE_VALUES_EN[t] * n for t, n in TILE_DISTRIBUTION.items())
        # Scrabble's 187, minus an N (1), plus a second K (5), plus 1 for each of the four Ls.
        self.assertEqual(total, 195)

    def test_english_set_has_letter_league_changes(self):
        self.assertEqual((TILE_DISTRIBUTION["N"], TILE_DISTRIBUTION["K"]), (5, 2))
        self.assertEqual(TILE_VALUES_EN["L"], 2)
        self.assertEqual(sum(TILE_DISTRIBUTION.values()), 100)

    def test_bag_size_option(self):
        rng = random.Random(1)
        self.assertEqual(len(new_bag("en", rng, 50)), 50)
        self.assertEqual(len(new_bag("en", rng, 150)), 150)

    def test_bag_is_shuffled_and_rng_is_respected(self):
        a, b = new_bag("en", random.Random(5)), new_bag("en", random.Random(5))
        self.assertEqual(a, b)
        self.assertNotEqual(a, new_bag("en", random.Random(6)))


class PremiumTests(unittest.TestCase):
    def test_counts(self):
        kinds = list(PREMIUM.values())
        self.assertEqual(kinds.count("TW"), 8)
        self.assertEqual(kinds.count("DW"), 17)  # includes the centre star
        self.assertEqual(kinds.count("TL"), 12)
        self.assertEqual(kinds.count("DL"), 24)

    def test_board_is_symmetric(self):
        for (r, c), kind in PREMIUM.items():
            for rr, cc in ((c, r), (r, 14 - c), (14 - r, c), (14 - r, 14 - c)):
                self.assertEqual(PREMIUM.get((rr, cc)), kind, ((r, c), (rr, cc)))

    def test_centre_is_double_word(self):
        self.assertEqual(PREMIUM[(7, 7)], "DW")

    def test_pattern_repeats_so_the_board_can_grow(self):
        for (r, c), kind in PREMIUM.items():
            if r < 14 and c < 14:
                self.assertEqual(premium_at(r + 14, c - 14), kind)
        self.assertEqual(premium_at(7, 7), "DW")
        self.assertEqual(premium_at(21, 7), "DW")
        self.assertEqual(premium_at(-7, 7), "DW")
        self.assertEqual(premium_at(-14, 0), "TW")
        for row in range(0, 15):
            for col in range(0, 15):
                self.assertEqual(premium_at(row, col), PREMIUM.get((row, col)))

    def test_client_config_matches(self):
        self.assertEqual(len(CONFIG["premiums"]), len(PREMIUM))
        self.assertEqual(CONFIG["values"]["en"]["Q"], 10)


class BoardTests(unittest.TestCase):
    def test_first_move_must_cover_centre(self):
        with self.assertRaisesRegex(GameError, "centre"):
            Board().analyze(word_placements("CAT", 0, 0))

    def test_first_move_needs_two_tiles(self):
        with self.assertRaisesRegex(GameError, "two letters"):
            Board().analyze([P(7, 7, "A")])

    def test_first_move_ok_both_directions(self):
        for horizontal in (True, False):
            board = Board()
            row, col = (7, 5) if horizontal else (5, 7)
            words = board.analyze(word_placements("CAT", row, col, horizontal))
            self.assertEqual([w.text for w in words], ["CAT"])

    def test_tiles_must_be_in_one_line(self):
        with self.assertRaisesRegex(GameError, "single row or column"):
            Board().analyze([P(7, 7, "A"), P(8, 8, "B")])

    def test_gaps_are_rejected(self):
        with self.assertRaisesRegex(GameError, "no gaps"):
            Board().analyze([P(7, 5, "A"), P(7, 7, "B")])

    def test_gap_filled_by_existing_tile_is_ok(self):
        board = Board()
        board.place_all(word_placements("CAT", 7, 6))  # C(7,6) A(7,7) T(7,8)
        words = board.analyze([P(6, 7, "X"), P(8, 7, "Y")])  # vertical through the A
        self.assertEqual([w.text for w in words], ["XAY"])

    def test_must_connect(self):
        board = Board()
        board.place_all(word_placements("CAT", 7, 6))
        with self.assertRaisesRegex(GameError, "connect"):
            board.analyze(word_placements("DOG", 0, 0))

    def test_cannot_overlap(self):
        board = Board()
        board.place_all(word_placements("CAT", 7, 6))
        with self.assertRaisesRegex(GameError, "taken"):
            board.analyze([P(7, 7, "Z"), P(6, 7, "Q")])

    def test_off_board(self):
        with self.assertRaises(GameError):
            Board().analyze([P(7, 20, "A"), P(7, 21, "B")])

    def test_board_starts_27_by_19_around_the_star(self):
        board = Board()
        b = board.bounds()
        self.assertEqual((b["right"] - b["left"] + 1, b["bottom"] - b["top"] + 1), (27, 19))
        self.assertTrue(board.in_bounds(7, 7))
        self.assertEqual(b, initial_bounds())
        self.assertTrue(board.in_bounds(7, 20) and not board.in_bounds(7, 21))
        self.assertTrue(board.in_bounds(-2, 7) and not board.in_bounds(-3, 7))

    def test_board_grows_towards_the_tiles_and_never_shrinks(self):
        board = Board()
        board.place_all([P(7, 15, "A")])
        self.assertTrue(board.expand_to_margin(7))
        self.assertEqual(board.bounds()["right"], 22)
        self.assertEqual(board.bounds()["left"], -6)  # the other sides did not move
        board.place_all([P(-4, 7, "B")])
        self.assertTrue(board.expand_to_margin(7))
        self.assertEqual(board.bounds()["top"], -11)
        board.remove_all([P(7, 15, "A")])
        self.assertFalse(board.expand_to_margin(7))
        self.assertEqual(board.bounds()["right"], 22)

    def test_no_growth_while_tiles_stay_clear_of_the_edge(self):
        board = Board()
        board.place_all(word_placements("HELLO", 7, 3))
        self.assertFalse(board.expand_to_margin(7))
        self.assertEqual(board.bounds(), initial_bounds())

    def test_expanded_squares_are_playable_and_have_premiums(self):
        board = Board()
        board.place_all(word_placements("CAT", 7, 18))
        board.expand_to_margin(7)
        words = board.analyze([P(7, 21, "S"), P(7, 22, "Y")])
        self.assertEqual([w.text for w in words], ["CATSY"])

    def test_multiply_boosts(self):
        board = Board()
        board.place_all([P(7, 7, "A")], boosts={(7, 7): 2})
        board.multiply_boosts({(7, 7): 3, (0, 0): 5})
        self.assertEqual(board.get(7, 7).boost, 6)

    def test_extending_an_existing_word(self):
        board = Board()
        board.place_all(word_placements("CAT", 7, 6))
        words = board.analyze([P(7, 9, "S")])
        self.assertEqual([w.text for w in words], ["CATS"])

    def test_prefix_and_suffix_run_together(self):
        board = Board()
        board.place_all(word_placements("AT", 7, 7))
        words = board.analyze([P(7, 6, "C"), P(7, 9, "S")])
        # C _ A T S has a gap at (7,8)? no: AT occupies (7,7),(7,8); new tiles are at 6 and 9
        self.assertEqual([w.text for w in words], ["CATS"])

    def test_cross_words_are_found(self):
        board = Board()
        board.place_all(word_placements("CAT", 7, 6))
        # horizontal play on row 8 directly beneath CAT: forms CA? vertical pairs
        words = board.analyze([P(8, 6, "O"), P(8, 7, "N")])
        self.assertEqual(sorted(w.text for w in words), sorted(["ON", "CO", "AN"]))
        self.assertEqual(words[0].text, "ON")  # main word first

    def test_single_tile_forms_both_directions(self):
        board = Board()
        board.place_all(word_placements("CAT", 7, 6))
        board.place_all(word_placements("ON", 8, 6)[1:])  # N under A at (8,7)... keep it simple
        words = board.analyze([P(8, 8, "O")])  # right of N, under T
        self.assertEqual(sorted(w.text for w in words), ["NO", "TO"])

    def test_single_tile_that_forms_no_word(self):
        board = Board()
        board.place_all(word_placements("CAT", 7, 6))
        with self.assertRaisesRegex(GameError, "connect"):
            board.analyze([P(3, 3, "A")])

    def test_remove_all(self):
        board = Board()
        tiles = word_placements("CAT", 7, 6)
        board.place_all(tiles)
        board.remove_all(tiles)
        self.assertTrue(board.is_empty())
        self.assertEqual(board.to_dict(), {})


class ScoringTests(unittest.TestCase):
    def score(self, board, placements):
        words = board.analyze(placements)
        return score_move(words, len(placements))

    def test_hello_on_the_star(self):
        # H on a double letter (7,3), O on the centre double word: (8 + 1 + 2 + 2 + 1) * 2
        result = self.score(Board(), word_placements("HELLO", 7, 3))
        self.assertEqual(result.total, 28)
        self.assertFalse(result.bingo)

    def test_premium_squares_only_count_once(self):
        board = Board()
        board.place_all(word_placements("HELLO", 7, 3))
        # Extend to HELLOS at (7,8): no premium there, and the old DW must not re-apply.
        result = self.score(board, [P(7, 8, "S")])
        self.assertEqual(result.total, 4 + 1 + 2 + 2 + 1 + 1)

    def test_cross_word_scoring(self):
        board = Board()
        board.place_all(word_placements("CAT", 7, 6))
        # Vertical word through the C at (7,6): 'ACE'? use A(6,6) C E(8,6): premium at (6,6) is DL
        placements = [P(6, 6, "A"), P(8, 6, "E")]
        words = board.analyze(placements)
        self.assertEqual([w.text for w in words], ["ACE"])
        result = score_move(words, 2)
        # A on DL (6,6) = 2, C = 3, E at (8,6) is DL = 2 -> 7
        self.assertEqual(result.total, 7)

    def test_blank_is_worth_zero_but_keeps_word_multiplier(self):
        board = Board()
        placements = [P(7, 6, "C"), P(7, 7, "A", blank=True), P(7, 8, "T")]
        result = self.score(board, placements)
        # C(3) + blank(0) on DW + T(1) = 4, doubled
        self.assertEqual(result.total, 8)

    def test_triple_word(self):
        board = Board()
        board.place_all(word_placements("AAAAAA", 7, 1))  # A at (7,1)..(7,6) -> to the left of centre
        # Extend through (7,0) TW: 7 letters... place a single tile at (7,0) -> word of 7 letters
        words = board.analyze([P(7, 0, "B")])
        self.assertEqual(score_move(words, 1).total, (3 + 6) * 3)

    def test_bingo_bonus(self):
        placements = word_placements("RETINAS", 7, 1)  # row 7, cols 1..7 (covers the star)
        result = self.score(Board(), placements)
        self.assertTrue(result.bingo)
        letters = sum(TILE_VALUES_EN[ch] for ch in "RETINAS")
        # premium squares on row 7: (7,3) DL -> T doubled, (7,7) DW
        expected = (letters + TILE_VALUES_EN["T"]) * 2 + 50
        self.assertEqual(result.total, expected)
        self.assertEqual(result.bonus, 50)

    def test_wild_bingo_doubles_only_the_main_word(self):
        board = Board()
        board.place_all([P(6, 10, "A"), P(8, 10, "E")])  # a tile above and below column 10
        placements = word_placements("RETINAS", 7, 4)  # row 7, cols 4..10; S crosses A_E at col 10
        words = board.analyze(placements)
        self.assertEqual(words[0].text, "RETINAS")
        self.assertEqual(words[1].text, "ASE")
        base = score_move(words, 7, "en", "classic")
        wild = score_move(words, 7, "en", "wild")
        self.assertTrue(wild.bingo)
        self.assertEqual(wild.word_scores, base.word_scores)
        self.assertEqual(wild.bonus, base.word_scores[0])  # main word counted twice
        self.assertEqual(wild.total, sum(base.word_scores) + base.word_scores[0])
        self.assertEqual(base.total, sum(base.word_scores) + 50)

    def test_bingo_mode_defaults_to_classic(self):
        words = Board().analyze(word_placements("RETINAS", 7, 1))
        self.assertEqual(score_move(words, 7).bonus, 50)
        self.assertEqual(score_move(words, 7, "en", "wild").bonus, score_move(words, 7).word_scores[0])


class WildScoringTests(unittest.TestCase):
    """Wild mode: a tile placed on a DL/TL keeps its letter multiplier for good."""

    def test_letter_boost_values(self):
        from game.scoring import letter_boost
        self.assertEqual(letter_boost(7, 3), 2)   # DL
        self.assertEqual(letter_boost(5, 5), 3)   # TL
        self.assertEqual(letter_boost(7, 7), 1)   # DW is a word premium, not a letter one
        self.assertEqual(letter_boost(0, 0), 1)   # TW
        self.assertEqual(letter_boost(1, 2), 1)   # plain square

    def test_old_tile_counts_its_boost(self):
        board = Board()
        board.place_all(word_placements("CAT", 7, 6), boosts={(7, 6): 3})  # C is worth 3, boosted x3
        words = board.analyze([P(7, 9, "S")])
        self.assertEqual(score_move(words, 1).total, 9 + 1 + 1 + 1)

    def test_old_boost_is_not_applied_twice_to_premium(self):
        board = Board()
        board.place_all(word_placements("HELLO", 7, 3), boosts={(7, 3): 2})  # H boosted x2 = 8
        words = board.analyze([P(7, 8, "S")])
        # H 8 + E + L + L + O + S = 15, no premium re-applied to old tiles
        self.assertEqual(score_move(words, 1).total, 8 + 1 + 2 + 2 + 1 + 1)

    def test_blank_stays_worth_zero_when_boosted(self):
        board = Board()
        board.place_all([P(7, 6, "C", True), P(7, 7, "A"), P(7, 8, "T")], boosts={(7, 6): 3})
        words = board.analyze([P(7, 9, "S")])
        self.assertEqual(score_move(words, 1).total, 0 + 1 + 1 + 1)

    def test_board_snapshot_includes_boost(self):
        board = Board()
        board.place_all([P(7, 6, "C")], boosts={(7, 6): 2})
        self.assertEqual(board.to_dict()["7,6"], {"l": "C", "b": False, "m": 2})


WORDS = ["CAT", "CATS", "AT", "ON", "NO", "TO", "HELLO", "ACE", "DOG", "GO", "OX", "XI", "AX", "ZA", "QI"]


def make_room(mode="wild", seed=1):
    set_words(WORDS)
    room = Room("TESTROOM", mode=mode, rng=random.Random(seed))
    a = room.add_player("Alice")
    b = room.add_player("Bob")
    room.start()
    return room, a, b


def give(player, tiles):
    player.rack = list(tiles)


def move(room, player, word, row, col, horizontal=True):
    """Place `word` (every tile from the rack) and submit."""
    items = []
    for i, ch in enumerate(word):
        index = player.rack.index(ch)
        # use distinct indices for repeated letters
        taken = {it["rack_index"] for it in items}
        while index in taken:
            index = player.rack.index(ch, index + 1)
        items.append({
            "rack_index": index,
            "row": row if horizontal else row + i,
            "col": col + i if horizontal else col,
        })
    room.place_tiles(player, items)
    return room.submit(player)


class RoomFlowTests(unittest.TestCase):
    def test_start_deals_racks_and_picks_a_starter(self):
        room, a, b = make_room()
        self.assertEqual(room.status, "playing")
        self.assertEqual((len(a.rack), len(b.rack), len(room.bag)), (7, 7, 86))
        self.assertIn(room.current, (0, 1))

    def test_room_is_full_at_two_players(self):
        room, _, _ = make_room()
        with self.assertRaisesRegex(GameError, "full"):
            room.add_player("Carol")

    def test_duplicate_names_are_disambiguated(self):
        room = Room("X")
        room.add_player("Sam")
        self.assertNotEqual(room.add_player("sam").name.lower(), "sam")

    def test_token_lookup(self):
        room, a, b = make_room()
        self.assertIs(room.player_by_token(a.token), a)
        self.assertIsNone(room.player_by_token("nope"))
        self.assertIsNone(room.player_by_token("ünïcode"))
        self.assertIsNone(room.player_by_token(None))

    def test_turn_enforcement(self):
        room, a, b = make_room()
        other = b if room.current == 0 else a
        with self.assertRaisesRegex(GameError, "not your turn"):
            room.place_tiles(other, [])
        with self.assertRaisesRegex(GameError, "not your turn"):
            room.pass_turn(other)

    def test_play_scores_draws_and_passes_turn(self):
        room, a, b = make_room()
        mover = room.players[room.current]
        opp = room.players[1 - room.current]
        give(mover, list("HELLOXY"))
        result = move(room, mover, "HELLO", 7, 3)
        self.assertEqual(result["score"], 28)
        self.assertEqual(mover.score, 28)
        self.assertEqual(len(mover.rack), 7)  # drew 5 replacements
        self.assertEqual(len(room.bag), 86 - 5)
        self.assertIs(room.players[room.current], opp)
        self.assertEqual(room.board.get(7, 7).letter, "O")

    def test_wild_bingo_is_the_main_word_doubled(self):
        room, a, b = make_room("wild")
        mover = room.players[room.current]
        set_words(["RETINAS"])
        give(mover, list("RETINAS"))
        result = move(room, mover, "RETINAS", 7, 1)
        base = (7 + 1) * 2  # T on the DL at (7,3), S on the centre DW
        self.assertEqual((result["bingo"], result["bingo_bonus"]), (True, base))
        self.assertEqual(result["score"], base * 2)

    def test_classic_bingo_is_a_flat_fifty(self):
        room, a, b = make_room("classic")
        mover = room.players[room.current]
        set_words(["RETINAS"])
        give(mover, list("RETINAS"))
        result = move(room, mover, "RETINAS", 7, 1)
        self.assertEqual((result["bingo_bonus"], result["score"]), (50, 16 + 50))

    def test_invalid_word_rejected_in_strict_mode_and_pending_kept(self):
        room, a, b = make_room()
        mover = room.players[room.current]
        give(mover, list("ZZQXJKV"))
        room.place_tiles(mover, [
            {"rack_index": 0, "row": 7, "col": 7},
            {"rack_index": 1, "row": 7, "col": 8},
        ])
        self.assertFalse(mover.preview["ok"])
        with self.assertRaisesRegex(GameError, "dictionary"):
            room.submit(mover)
        self.assertEqual(len(mover.pending), 2)
        self.assertEqual(room.players[room.current], mover)
        self.assertEqual(mover.rack, list("ZZQXJKV"))

    def test_place_tiles_validation(self):
        room, a, b = make_room()
        mover = room.players[room.current]
        bad_inputs = [
            "nope",
            [{"rack_index": 99, "row": 7, "col": 7}],
            [{"rack_index": 0, "row": 99, "col": 7}],
            [{"rack_index": 0, "row": 7, "col": 7}, {"rack_index": 0, "row": 7, "col": 8}],
            [{"rack_index": 0, "row": 7, "col": 7}, {"rack_index": 1, "row": 7, "col": 7}],
            [{"rack_index": "0", "row": 7, "col": 7}],
            [{"rack_index": True, "row": 7, "col": 7}],
            [None],
        ]
        for bad in bad_inputs:
            with self.assertRaises(GameError, msg=repr(bad)):
                room.place_tiles(mover, bad)

    def test_blank_requires_letter_and_scores_zero(self):
        room, a, b = make_room()
        mover = room.players[room.current]
        give(mover, [BLANK, "A", "T", "E", "E", "E", "E"])
        with self.assertRaisesRegex(GameError, "blank"):
            room.place_tiles(mover, [{"rack_index": 0, "row": 7, "col": 6}])
        room.place_tiles(mover, [
            {"rack_index": 0, "row": 7, "col": 6, "letter": "c"},
            {"rack_index": 1, "row": 7, "col": 7},
            {"rack_index": 2, "row": 7, "col": 8},
        ])
        self.assertEqual(mover.preview["words"][0]["word"], "CAT")
        result = room.submit(mover)
        self.assertEqual(result["score"], (0 + 1 + 1) * 2)
        self.assertTrue(room.board.get(7, 6).blank)

    def test_pending_tiles_are_private_to_their_owner(self):
        room, a, b = make_room()
        mover = room.players[room.current]
        opp = room.players[1 - room.current]
        give(mover, list("CATSEEE"))
        room.place_tiles(mover, [{"rack_index": 0, "row": 7, "col": 7}])
        mine, theirs = room.view_for(mover), room.view_for(opp)
        self.assertIn("rack_index", mine["pending"][0])
        self.assertEqual(theirs["pending"], [])
        self.assertIsNotNone(mine["preview"])
        self.assertIsNone(theirs["preview"])

    def test_views_never_leak_the_opponents_rack(self):
        room, a, b = make_room()
        view = room.view_for(a)
        self.assertEqual(view["rack"], a.rack)
        self.assertEqual(view["players"][1]["rack_count"], 7)
        self.assertNotIn("rack", view["players"][1])  # only a count is exposed
        self.assertIsNone(view["final"])  # final racks are revealed only once the game is over
        # And the other player's view carries *their* rack, not ours.
        self.assertEqual(room.view_for(b)["rack"], b.rack)

    def test_second_move_must_connect(self):
        room, a, b = make_room()
        first = room.players[room.current]
        give(first, list("CATSEEE"))
        move(room, first, "CAT", 7, 6)
        second = room.players[room.current]
        give(second, list("DOGEEEE"))
        second.pending = []
        with self.assertRaisesRegex(GameError, "connect"):
            room.place_tiles(second, [
                {"rack_index": 0, "row": 0, "col": 0}, {"rack_index": 1, "row": 0, "col": 1},
            ])
            room.submit(second)

    def test_pass_and_scoreless_limit_ends_the_game(self):
        room, a, b = make_room()
        for _ in range(5):
            room.pass_turn(room.players[room.current])
            self.assertEqual(room.status, "playing")
        room.pass_turn(room.players[room.current])
        self.assertEqual(room.status, "finished")
        self.assertEqual(room.winner, "tie" if a.score == b.score else room.winner)
        # every player loses the value of their own rack
        self.assertEqual(
            [a.score, b.score],
            [-sum(TILE_VALUES_EN[t] for t in a.rack), -sum(TILE_VALUES_EN[t] for t in b.rack)],
        )
        with self.assertRaisesRegex(GameError, "over"):
            room.pass_turn(room.players[0])

    def test_scoring_move_resets_scoreless_counter(self):
        room, a, b = make_room()
        room.pass_turn(room.players[room.current])
        mover = room.players[room.current]
        give(mover, list("CATSEEE"))
        move(room, mover, "CAT", 7, 6)
        self.assertEqual(room.scoreless_turns, 0)

    def test_swap(self):
        room, a, b = make_room()
        mover = room.players[room.current]
        before = list(mover.rack)
        bag_before = len(room.bag)
        room.swap(mover, [0, 1, 2])
        self.assertEqual(len(mover.rack), 7)
        self.assertEqual(len(room.bag), bag_before)
        self.assertEqual(mover.rack[:4], before[3:])  # kept tiles first
        self.assertIsNot(room.players[room.current], mover)

    def test_swap_validation(self):
        room, a, b = make_room()
        mover = room.players[room.current]
        for bad in (None, [], [0, 0], [9], ["a"], [True]):
            with self.assertRaises(GameError, msg=repr(bad)):
                room.swap(mover, bad)
        room.bag = room.bag[:6]
        with self.assertRaisesRegex(GameError, "cannot swap"):
            room.swap(mover, [0])

    def test_going_out_ends_the_game_with_rack_adjustments(self):
        room, a, b = make_room()
        mover = room.players[room.current]
        opp = room.players[1 - room.current]
        room.bag = []
        give(mover, list("CAT"))
        give(opp, list("QZ"))  # 20 points of tiles left
        move(room, mover, "CAT", 7, 6)
        self.assertEqual(room.status, "finished")
        base = (3 + 1 + 1) * 2  # CAT across the star: C(3)+A(1)+T(1) with DW at (7,7)
        self.assertEqual(mover.score, base + 20)
        self.assertEqual(opp.score, -20)
        self.assertEqual(room.winner, mover.seat)
        self.assertEqual(room.final["out_seat"], mover.seat)

    def test_bingo_through_the_room(self):
        room, a, b = make_room()
        mover = room.players[room.current]
        set_words(["RETINAS"])
        give(mover, list("RETINAS"))
        result = move(room, mover, "RETINAS", 7, 1)
        self.assertTrue(result["bingo"])
        self.assertGreaterEqual(result["score"], 16)


class ChallengeTests(unittest.TestCase):
    def test_wild_mode_rejects_challenges(self):
        room, a, b = make_room("wild")
        with self.assertRaisesRegex(GameError, "challenge mode"):
            room.challenge(room.players[room.current])

    def test_challenge_mode_accepts_bogus_word_then_challenge_reverts_it(self):
        room, a, b = make_room("classic")
        mover = room.players[room.current]
        opp = room.players[1 - room.current]
        give(mover, list("ZZQXJKV"))
        racks_before = sorted(mover.rack)
        bag_before = len(room.bag)
        room.place_tiles(mover, [
            {"rack_index": 0, "row": 7, "col": 7}, {"rack_index": 1, "row": 7, "col": 8},
        ])
        self.assertIsNone(mover.preview["words"][0]["valid"])  # validity hidden
        result = room.submit(mover)
        self.assertGreater(result["score"], 0)
        self.assertEqual(room.status, "playing")
        view = room.view_for(opp)
        self.assertTrue(view["can_challenge"])
        self.assertFalse(room.view_for(mover)["can_challenge"])

        outcome = room.challenge(opp)
        self.assertTrue(outcome["success"])
        self.assertEqual(outcome["invalid"], ["ZZ"])
        self.assertTrue(room.board.is_empty())
        self.assertEqual(mover.score, 0)
        self.assertEqual(sorted(mover.rack), racks_before)
        self.assertEqual(len(room.bag), bag_before)
        self.assertIs(room.players[room.current], opp)  # challenger plays on; mover lost the turn
        self.assertIsNone(room.last_move)
        self.assertEqual(room.scoreless_turns, 1)

    def test_failed_challenge_costs_the_challenger_their_turn(self):
        room, a, b = make_room("classic")
        mover = room.players[room.current]
        opp = room.players[1 - room.current]
        give(mover, list("CATSEEE"))
        move(room, mover, "CAT", 7, 6)
        outcome = room.challenge(opp)
        self.assertFalse(outcome["success"])
        self.assertIs(room.players[room.current], mover)
        self.assertEqual(room.board.get(7, 6).letter, "C")
        self.assertEqual(room.scoreless_turns, 1)
        with self.assertRaisesRegex(GameError, "no play"):
            room.challenge(mover)

    def test_passing_closes_the_challenge_window(self):
        room, a, b = make_room("classic")
        mover = room.players[room.current]
        opp = room.players[1 - room.current]
        give(mover, list("CATSEEE"))
        move(room, mover, "CAT", 7, 6)
        room.pass_turn(opp)  # declining to challenge
        self.assertIsNone(room.last_move)
        self.assertFalse(room.view_for(mover)["can_challenge"])
        with self.assertRaisesRegex(GameError, "no play"):
            room.challenge(mover)

    def test_playing_on_replaces_the_challengeable_move(self):
        room, a, b = make_room("classic")
        mover = room.players[room.current]
        opp = room.players[1 - room.current]
        give(mover, list("CATSEEE"))
        move(room, mover, "CAT", 7, 6)
        give(opp, list("SXEEEEE"))
        move(room, opp, "S", 7, 9)  # CATS
        self.assertEqual(room.last_move["seat"], opp.seat)
        self.assertTrue(room.view_for(mover)["can_challenge"])
        self.assertFalse(room.view_for(opp)["can_challenge"])
        outcome = room.challenge(mover)  # CATS is valid, so this challenge fails
        self.assertFalse(outcome["success"])
        self.assertIs(room.players[room.current], opp)

    def test_cannot_challenge_own_move_or_out_of_turn(self):
        room, a, b = make_room("classic")
        mover = room.players[room.current]
        opp = room.players[1 - room.current]
        give(mover, list("CATSEEE"))
        move(room, mover, "CAT", 7, 6)
        with self.assertRaisesRegex(GameError, "not your turn"):
            room.challenge(mover)

    def test_going_out_in_challenge_mode_waits_for_the_opponent(self):
        room, a, b = make_room("classic")
        mover = room.players[room.current]
        opp = room.players[1 - room.current]
        room.bag = []
        give(mover, list("ZZ"))
        give(opp, list("QA"))
        move(room, mover, "ZZ", 7, 7)
        self.assertEqual(room.status, "playing")
        self.assertTrue(room.awaiting_final)
        with self.assertRaisesRegex(GameError, "gone out"):
            room.place_tiles(opp, [])
        outcome = room.challenge(opp)
        self.assertTrue(outcome["success"])
        self.assertFalse(room.awaiting_final)
        self.assertEqual(sorted(mover.rack), ["Z", "Z"])
        self.assertEqual(room.status, "playing")

    def test_accepting_the_final_play_by_passing(self):
        room, a, b = make_room("classic")
        mover = room.players[room.current]
        opp = room.players[1 - room.current]
        room.bag = []
        give(mover, list("CAT"))
        give(opp, list("Q"))
        move(room, mover, "CAT", 7, 6)
        room.pass_turn(opp)
        self.assertEqual(room.status, "finished")
        self.assertEqual(room.winner, mover.seat)

    def test_failed_challenge_on_final_play_ends_the_game(self):
        room, a, b = make_room("classic")
        mover = room.players[room.current]
        opp = room.players[1 - room.current]
        room.bag = []
        give(mover, list("CAT"))
        give(opp, list("Q"))
        move(room, mover, "CAT", 7, 6)
        room.challenge(opp)
        self.assertEqual(room.status, "finished")


class ModeTests(unittest.TestCase):
    def play_first(self, mode):
        room, a, b = make_room(mode)
        mover = room.players[room.current]
        give(mover, list("HELLOXY"))
        move(room, mover, "HELLO", 7, 3)  # H lands on the DL at (7,3)
        return room, mover

    def test_default_mode_is_wild_with_automatic_checking(self):
        room = Room("X")
        self.assertEqual((room.mode, room.rules, room.length), ("wild", "strict", "medium"))

    def test_wild_keeps_bonuses_on_board(self):
        room, _ = self.play_first("wild")
        # HELLO: H on a DL (x2) and the word covers the DW star (x2 for every letter).
        self.assertEqual(room.board.get(7, 3).boost, 4)
        self.assertEqual(room.board.get(7, 4).boost, 2)
        self.assertEqual(room.board.get(7, 7).boost, 2)
        self.assertEqual(room.view_for(room.players[0])["board"]["7,3"]["m"], 4)

    def test_classic_never_keeps_boost(self):
        room, _ = self.play_first("classic")
        self.assertTrue(all(t.boost == 1 for t in room.board.grid.values()))

    def test_wild_extension_scores_the_boosted_tile(self):
        room, mover = self.play_first("wild")
        other = room.players[room.current]
        set_words(WORDS + ["HELLOS"])
        give(other, list("SQQQQQQ"))
        before = other.score
        move(room, other, "S", 7, 8)  # HELLOS: H, E, L, L, O keep their x4 / x2 values
        self.assertEqual(other.score - before, 16 + 2 + 4 + 4 + 2 + 1)
        self.assertEqual(room.board.get(7, 8).boost, 1)  # the added S is not multiplied
        self.assertEqual(room.board.get(7, 3).boost, 4)  # and the old letters are not multiplied again

    def test_classic_extension_ignores_old_premium(self):
        room, mover = self.play_first("classic")
        other = room.players[room.current]
        set_words(WORDS + ["HELLOS"])
        give(other, list("SQQQQQQ"))
        before = other.score
        move(room, other, "S", 7, 8)
        self.assertEqual(other.score - before, 4 + 1 + 2 + 2 + 1 + 1)

    def test_word_bonus_boosts_every_letter_of_the_word_permanently(self):
        room, _, _ = make_room("wild")
        mover = room.players[room.current]
        give(mover, list("CATQQQQ"))
        move(room, mover, "CAT", 7, 6)  # covers the centre DW
        self.assertEqual([room.board.get(7, c).boost for c in (6, 7, 8)], [2, 2, 2])

    def test_classic_word_bonus_is_not_kept(self):
        room, _, _ = make_room("classic")
        mover = room.players[room.current]
        give(mover, list("CATQQQQ"))
        move(room, mover, "CAT", 7, 6)
        self.assertTrue(all(t.boost == 1 for t in room.board.grid.values()))

    def test_wild_rejects_invalid_word_and_shows_validity(self):
        room, a, b = make_room("wild")
        mover = room.players[room.current]
        give(mover, list("ZZQXJKV"))
        room.place_tiles(mover, [{"rack_index": 0, "row": 7, "col": 7}, {"rack_index": 1, "row": 7, "col": 8}])
        self.assertFalse(mover.preview["ok"])
        self.assertIs(mover.preview["words"][0]["valid"], False)
        with self.assertRaisesRegex(GameError, "dictionary"):
            room.submit(mover)


class SettingsTests(unittest.TestCase):
    def test_either_player_can_change_settings_before_first_turn(self):
        room, a, b = make_room("wild")
        room.update_settings(a, mode="classic")
        self.assertEqual((room.mode, room.rules), ("classic", "challenge"))
        room.update_settings(b, length="short")
        self.assertEqual(room.length, "short")

    def test_length_controls_the_bag(self):
        room, a, b = make_room("wild")
        room.update_settings(a, length="short")
        self.assertEqual(len(room.bag), 50 - 14)
        self.assertTrue(all(len(p.rack) == 7 for p in room.players))
        room.update_settings(a, length="medium")
        self.assertEqual(len(room.bag), 100 - 14)
        room.update_settings(a, length="full")
        self.assertEqual(len(room.bag), 150 - 14)

    def test_settings_apply_before_the_opponent_joins(self):
        set_words(WORDS)
        room = Room("X", rng=random.Random(2))
        p = room.add_player("Alice")
        room.update_settings(p, mode="classic", length="medium")
        room.add_player("Bob")
        room.start()
        self.assertEqual(len(room.bag), 100 - 14)
        self.assertEqual(room.mode, "classic")

    def test_settings_lock_after_first_turn(self):
        room, a, b = make_room("wild")
        self.assertFalse(room.view_for(a)["settings_locked"])
        room.pass_turn(room.players[room.current])
        self.assertTrue(room.view_for(a)["settings_locked"])
        with self.assertRaisesRegex(GameError, "before the first turn"):
            room.update_settings(a, mode="classic")

    def test_invalid_settings_rejected(self):
        room, a, b = make_room("wild")
        with self.assertRaises(GameError):
            room.update_settings(a, mode="chaos")
        with self.assertRaises(GameError):
            room.update_settings(a, length="endless")

    def test_changing_mode_refreshes_preview_validity(self):
        room, a, b = make_room("wild")
        mover = room.players[room.current]
        give(mover, list("ZZQXJKV"))
        room.place_tiles(mover, [{"rack_index": 0, "row": 7, "col": 7}, {"rack_index": 1, "row": 7, "col": 8}])
        self.assertFalse(mover.preview["ok"])
        room.update_settings(mover, mode="classic")
        self.assertTrue(mover.preview["ok"])
        self.assertIsNone(mover.preview["words"][0]["valid"])

    def test_view_exposes_mode_and_length(self):
        room, a, b = make_room("classic")
        view = room.view_for(a)
        self.assertEqual((view["mode"], view["length"], view["rules"]), ("classic", "medium", "challenge"))
        self.assertEqual(CONFIG["modes"], ["wild", "classic"])
        self.assertEqual(CONFIG["lengths"], {"short": 50, "medium": 100, "full": 150})
        self.assertEqual((CONFIG["cols"], CONFIG["rows"]), (27, 19))
        self.assertEqual(CONFIG["classic_bounds"], view["bounds"])  # classic room: fixed 15x15


class MultiplayerTests(unittest.TestCase):
    def lobby(self, count, mode="wild"):
        set_words(WORDS)
        room = Room("MULTI", mode=mode, max_players=count, rng=random.Random(4))
        players = [room.add_player(name) for name in ("Ann", "Ben", "Cy", "Di")[:count]]
        return room, players

    def test_three_player_game_starts_when_full_and_turns_rotate(self):
        room, players = self.lobby(3)
        self.assertEqual(room.status, "waiting")
        self.assertTrue(room.maybe_start())
        self.assertEqual((room.status, len(room.players)), ("playing", 3))
        self.assertTrue(all(len(p.rack) == 7 for p in players))
        order = []
        for _ in range(3):
            order.append(room.current)
            room.pass_turn(room.players[room.current])
        self.assertEqual(sorted(order), [0, 1, 2])

    def test_host_can_start_early_with_two_of_four(self):
        room, players = self.lobby(2)
        room.update_settings(players[0], max_players=4)
        self.assertEqual(room.status, "waiting")
        self.assertTrue(room.view_for(players[0])["can_start"])
        self.assertFalse(room.view_for(players[1])["can_start"])
        with self.assertRaisesRegex(GameError, "host"):
            room.start_now(players[1])
        room.start_now(players[0])
        self.assertEqual((room.status, room.max_players), ("playing", 2))

    def test_classic_is_two_players_only(self):
        room, players = self.lobby(2)
        with self.assertRaises(GameError):
            room.update_settings(players[0], mode="classic", max_players=3)

    def test_everyone_sees_only_their_own_rack_and_tentative_tiles(self):
        room, players = self.lobby(3)
        room.maybe_start()
        mover = room.players[room.current]
        give(mover, list("CATSEEE"))
        room.place_tiles(mover, [{"rack_index": 0, "row": 7, "col": 7}])
        for p in players:
            view = room.view_for(p)
            self.assertEqual(view["rack"], p.rack)
            self.assertEqual(len(view["pending"]), 1 if p is mover else 0)
            self.assertEqual(len(view["players"]), 3)

    def test_scores_and_winner_with_three_players(self):
        room, players = self.lobby(3)
        room.maybe_start()
        players[0].score, players[1].score, players[2].score = 10, 30, 20
        for p in players:
            p.rack = []
        room._finish(out_seat=None)
        self.assertEqual(room.winner, 1)
        room.status = "playing"
        room._finish(out_seat=None)

    def test_wild_supports_many_players(self):
        set_words(WORDS)
        room = Room("BIG", max_players=12, rng=random.Random(5))
        for i in range(12):
            room.add_player(f"P{i}")
        self.assertTrue(room.maybe_start())
        self.assertTrue(all(len(p.rack) == 7 for p in room.players))
        self.assertEqual(len(room.bag), 100 - 84)
        seen = []
        for _ in range(12):
            seen.append(room.current)
            room.pass_turn(room.players[room.current])
        self.assertEqual(sorted(seen), list(range(12)))

    def test_player_count_is_limited_by_the_bag(self):
        with self.assertRaisesRegex(GameError, "not enough"):
            Room("X", length="short", max_players=8)
        room = Room("X", max_players=14)  # 98 of 100 tiles
        with self.assertRaisesRegex(GameError, "not enough"):
            room.update_settings(room.add_player("A"), length="medium", max_players=15)  # explicit: rejected
        with self.assertRaises(GameError):
            Room("X", max_players=17)
        room.update_settings(room.players[0], length="full", max_players=16)
        self.assertEqual(room.max_players, 16)

    def test_full_room_rejects_a_fourth_player(self):
        room, _ = self.lobby(3)
        with self.assertRaisesRegex(GameError, "full"):
            room.add_player("Zed")


class ExpansionTests(unittest.TestCase):
    def test_expansion_is_wild_only_by_default(self):
        self.assertTrue(Room("X", mode="wild").auto_expand)
        self.assertFalse(Room("X", mode="classic").auto_expand)
        self.assertEqual(Room("X").expand_margin, 7)

    def test_classic_is_the_standard_15x15_board(self):
        room = Room("X", mode="classic")
        b = room.board.bounds()
        self.assertEqual(b, {"top": 0, "bottom": 14, "left": 0, "right": 14})
        self.assertFalse(room.board.in_bounds(7, 15))
        self.assertFalse(room.board.in_bounds(-1, 7))

    def test_switching_mode_swaps_the_board_before_the_first_turn(self):
        set_words(WORDS)
        room = Room("X", rng=random.Random(1))
        a = room.add_player("A")
        self.assertEqual(room.board.bounds(), initial_bounds())
        room.update_settings(a, mode="classic")
        self.assertEqual(room.board.bounds()["right"], 14)
        room.update_settings(a, mode="wild")
        self.assertEqual(room.board.bounds(), initial_bounds())

    def test_a_play_near_the_edge_grows_the_board_and_the_view_reports_it(self):
        set_words(["CATS", "CAT", "ZA", "ZAX"])
        room = Room("X", mode="wild", rng=random.Random(2))
        a, b = room.add_player("A"), room.add_player("B")
        room.start()
        first = room.players[room.current]
        before = dict(room.view_for(first)["bounds"])
        self.assertEqual(before, initial_bounds())
        # Put a word at the far right so that its last tile is within the margin of the edge.
        room.board.place_all(word_placements("CAT", 7, 16))
        mover = room.players[room.current]
        give(mover, list("SQQQQQQ"))
        move(room, mover, "S", 7, 19)
        after = room.view_for(mover)["bounds"]
        self.assertEqual(after["right"], 19 + 7)
        self.assertEqual(after["left"], before["left"])
        self.assertIn("The board expanded.", " ".join(h["text"] for h in room.history))
        # The next player can already place a tile in the new area.
        other = room.players[room.current]
        self.assertTrue(room.board.in_bounds(7, 26))

    def test_fixed_board_when_expansion_is_switched_off(self):
        room = Room("X", auto_expand=False)
        room.board.place_all(word_placements("CAT", 7, 18))
        self.assertFalse(room.auto_expand)
        self.assertEqual(room.board.bounds(), initial_bounds())


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def timed_room(timer="30s", mode="wild"):
    set_words(WORDS)
    clock = FakeClock()
    room = Room("TESTROOM", mode=mode, timer=timer, rng=random.Random(1), clock=clock)
    a, b = room.add_player("Alice"), room.add_player("Bob")
    room.start()
    return room, a, b, clock


class TimerTests(unittest.TestCase):
    def test_default_is_no_timer(self):
        room, a, b = make_room()
        self.assertEqual(room.timer, "off")
        self.assertIsNone(room.view_for(a)["turn_ms_left"])
        self.assertFalse(room.expire_turn())

    def test_clock_counts_down_in_the_view(self):
        room, a, b, clock = timed_room("30s")
        self.assertEqual(room.view_for(a)["turn_ms_left"], 30000)
        clock.t += 10
        self.assertEqual(room.view_for(b)["turn_ms_left"], 20000)
        self.assertEqual(room.view_for(a)["timer"], "30s")

    def test_expiry_passes_the_turn(self):
        room, a, b, clock = timed_room("30s", mode="classic")  # Classic enforces the timer
        first = room.current
        clock.t += 29
        self.assertFalse(room.expire_turn())
        clock.t += 2
        self.assertTrue(room.expire_turn())
        self.assertEqual(room.current, 1 - first)
        self.assertEqual(room.scoreless_turns, 1)
        self.assertIn("ran out of time", " ".join(h["text"] for h in room.history))
        self.assertEqual(room.view_for(a)["turn_ms_left"], 30000)  # fresh clock for the next player

    def test_clock_restarts_after_a_move(self):
        room, a, b, clock = timed_room("60s")
        mover = room.players[room.current]
        give(mover, list("CATQQQQ"))
        clock.t += 40
        move(room, mover, "CAT", 7, 6)
        room.touch()
        self.assertEqual(room.view_for(mover)["turn_ms_left"], 60000)
        self.assertFalse(room.expire_turn())

    def test_repeated_timeouts_end_the_game(self):
        room, a, b, clock = timed_room("30s", mode="classic")
        for _ in range(6):
            clock.t += 31
            room.expire_turn()
        self.assertEqual(room.status, "finished")
        self.assertIsNone(room.view_for(a)["turn_ms_left"])

    def test_timeout_on_final_play_accepts_it_in_classic(self):
        room, a, b, clock = timed_room("30s", mode="classic")
        mover = room.players[room.current]
        opp = room.players[1 - room.current]
        room.bag.clear()
        give(mover, list("CAT"))
        move(room, mover, "CAT", 7, 6)
        room.touch()  # what the server does after every action
        self.assertTrue(room.awaiting_final)
        clock.t += 31
        self.assertTrue(room.expire_turn())
        self.assertEqual(room.status, "finished")

    def test_timer_setting_can_be_changed_before_the_first_turn(self):
        room, a, b, clock = timed_room("off")
        room.update_settings(a, timer="60s")
        self.assertEqual(room.view_for(a)["turn_ms_left"], 60000)
        room.update_settings(a, timer="off")
        self.assertIsNone(room.view_for(a)["turn_ms_left"])
        with self.assertRaises(GameError):
            room.update_settings(a, timer="forever")

    def test_unknown_timer_rejected_and_config_lists_timers(self):
        with self.assertRaises(GameError):
            Room("X", timer="forever")
        self.assertEqual(CONFIG["timers"]["off"], 0)
        self.assertEqual(CONFIG["timers"]["5m"], 300)

    def test_registry_lists_rooms(self):
        registry = RoomRegistry()
        room = registry.create()
        self.assertEqual(registry.rooms(), [room])


class DiffTests(unittest.TestCase):
    def test_diff_only_contains_changes(self):
        room, a, b = make_room()
        mover = room.players[room.current]
        old = room.view_for(mover)
        self.assertEqual(diff_views(old, room.view_for(mover)), {})
        give(mover, list("CATSEEE"))
        move(room, mover, "CAT", 7, 6)
        patch = diff_views(old, room.view_for(mover))
        self.assertEqual(set(patch["board"]["set"]), {"7,6", "7,7", "7,8"})
        self.assertEqual(patch["board"]["del"], [])
        self.assertIn("current", patch)
        self.assertIn("history", patch)
        self.assertNotIn("room", patch)
        self.assertNotIn("rules", patch)

    def test_diff_reports_removed_cells(self):
        old = {"board": {"1,1": {"l": "A", "b": False}}, "x": 1}
        new = {"board": {}, "x": 1}
        self.assertEqual(diff_views(old, new), {"board": {"set": {}, "del": ["1,1"]}})

    def test_applying_diffs_reproduces_the_view(self):
        room, a, b = make_room()
        mover = room.players[room.current]
        state = room.view_for(mover)
        give(mover, list("CATSEEE"))
        move(room, mover, "CAT", 7, 6)
        new = room.view_for(mover)
        patch = diff_views(state, new)
        rebuilt = {k: v for k, v in state.items()}
        board = dict(rebuilt["board"])
        for k, v in patch.items():
            if k == "board":
                board.update(v["set"])
                for key in v["del"]:
                    board.pop(key, None)
            else:
                rebuilt[k] = v
        rebuilt["board"] = board
        self.assertEqual(rebuilt, new)


class MiscTests(unittest.TestCase):
    def test_clean_name(self):
        self.assertEqual(clean_name("  Al   ice \n"), "Al ice")
        self.assertEqual(clean_name("x" * 50), "x" * 20)
        self.assertEqual(clean_name(None), "")
        self.assertEqual(clean_name(12), "")
        self.assertEqual(clean_name("a\x00b\x07c"), "abc")

    def test_registry(self):
        registry = RoomRegistry(max_rooms=2)
        room = registry.create()
        self.assertEqual(len(room.code), 8)
        self.assertEqual((room.mode, room.length), ("wild", "medium"))
        self.assertIs(registry.get(room.code.lower()), room)
        self.assertIsNone(registry.get("nope"))
        self.assertIsNone(registry.get(None))
        self.assertIsNone(registry.get("OOOOOOOO"))  # contains letters outside the alphabet
        registry.create()
        with self.assertRaisesRegex(GameError, "busy"):
            registry.create()

    def test_registry_create_with_settings(self):
        registry = RoomRegistry()
        room = registry.create(mode="classic", length="short", timer="60s")
        self.assertEqual((room.mode, room.length, room.timer), ("classic", "short", "60s"))
        with self.assertRaises(GameError):
            registry.create(mode="chaos")

    def test_registry_purges_stale_rooms(self):
        registry = RoomRegistry(abandoned_ttl=10)
        room = registry.create()
        room.last_active -= 100
        registry.purge()
        self.assertIsNone(registry.get(room.code))

    def test_unknown_mode_and_length(self):
        with self.assertRaises(GameError):
            Room("X", mode="chaos")
        with self.assertRaises(GameError):
            Room("X", length="endless")

    def test_bundled_word_list(self):
        words = load_words()
        self.assertGreater(len(words), 20000)
        for w in ("QUIZ", "ZA", "QI", "XYLOPHONE", "SCRABBLE", "CATS"):
            self.assertIn(w, words)
        for w in ("ADJ", "XVIII", "BRRRR"):
            self.assertNotIn(w, words)
        self.assertTrue(all(2 <= len(w) <= 15 and w.isalpha() and w.isupper() for w in words))


class LanguageTests(unittest.TestCase):
    def setUp(self):
        self._saved = dict(room_module._words)
        set_words(["TERVE", "KÄÄ", "ÖÖ"], "fi")
        self._exists = room_module.os.path.exists
        # Pretend only the languages we install in a test have a word list on disk.
        room_module.os.path.exists = lambda p: True if p.endswith("fi.txt") else self._exists(p)

    def tearDown(self):
        room_module.os.path.exists = self._exists
        room_module._words.clear()
        room_module._words.update(self._saved)

    def test_tile_tables_are_consistent(self):
        for lang in LANGUAGES:
            dist, values = TILE_DISTRIBUTIONS[lang], TILE_VALUES[lang]
            self.assertEqual(set(dist), set(values), lang)
            self.assertTrue(all(len(t) == 1 for t in dist), lang)  # one letter per board square
            self.assertEqual(values[BLANK], 0)
            self.assertEqual(len(new_bag(lang, random.Random(1))), sum(dist.values()))

    def test_unknown_or_unavailable_language_is_rejected(self):
        with self.assertRaises(GameError):
            Room("X", language="xx")
        from unittest import mock
        with mock.patch.object(room_module, "dictionary_path", lambda lang: "/nonexistent/word-list.txt"):
            with self.assertRaises(GameError):
                Room("X", language="sv")  # no word list installed
        with self.assertRaises(GameError):
            RoomRegistry().create(language="klingon")

    def test_non_ascii_words_survive_loading(self):
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".txt", encoding="utf-8", delete=False) as handle:
            handle.write("kää\nÖÖ\nab1\n")
        original = room_module.dictionary_path
        room_module.dictionary_path = lambda lang: handle.name
        try:
            self.assertEqual(load_words("fi"), frozenset({"KÄÄ", "ÖÖ"}))
        finally:
            room_module.dictionary_path = original
            os.unlink(handle.name)

    def test_set_words_is_per_language(self):
        set_words(["HELLO"], "en")
        self.assertIn("HELLO", room_module.get_words("en"))
        self.assertIn("TERVE", room_module.get_words("fi"))
        self.assertNotIn("TERVE", room_module.get_words("en"))

    def test_finnish_game_deals_finnish_tiles_and_values(self):
        room = Room("FI", language="fi", rng=random.Random(3))
        a, b = room.add_player("A"), room.add_player("B")
        room.start()
        letters = set(TILE_DISTRIBUTIONS["fi"])
        self.assertTrue(all(t in letters for p in room.players for t in p.rack + room.bag))
        self.assertEqual(len(room.bag) + 14, 100)
        self.assertEqual(room.view_for(a)["language"], "fi")
        self.assertEqual(CONFIG["values"]["fi"]["Ö"], 7)

    def test_blank_may_stand_for_a_non_english_letter(self):
        room = Room("FI", language="fi", rng=random.Random(3))
        a, _ = room.add_player("A"), room.add_player("B")
        room.start()
        mover = room.players[room.current]
        mover.rack[0] = BLANK
        room.place_tiles(mover, [{"rack_index": 0, "row": 7, "col": 7, "letter": "ä"}])
        self.assertEqual(mover.pending[0]["letter"], "Ä")
        with self.assertRaises(GameError):
            room.place_tiles(mover, [{"rack_index": 0, "row": 7, "col": 7, "letter": "W"}])  # not a Finnish tile

    def test_scoring_uses_the_room_language(self):
        words = Board().analyze([Placement(7, 7, "Ö", False), Placement(7, 8, "Ö", False)])
        self.assertEqual(score_move(words, 2, "fi").total, (7 + 7) * 2)
        self.assertEqual(score_move(words, 2, "en").total, 0)

    def test_changing_language_redeals(self):
        set_words(["TERVE"], "fi")
        room = Room("CH", rng=random.Random(2))
        a, _ = room.add_player("A"), room.add_player("B")
        room.start()
        room.update_settings(a, language="fi")
        self.assertEqual(room.language, "fi")
        self.assertTrue(all(t in TILE_DISTRIBUTIONS["fi"] for t in room.players[0].rack))


class FollowUpTests(unittest.TestCase):
    """Auto game length, shrinking after a won challenge, skipping offline players."""

    def test_raising_the_player_count_raises_the_length_when_none_was_chosen(self):
        room = Room("X", length="short", rng=random.Random(1))
        host = room.add_player("A")
        room.update_settings(host, max_players=8)  # 56 tiles do not fit in a 50-tile bag
        self.assertEqual((room.length, room.max_players), ("medium", 8))
        room.update_settings(host, max_players=15)  # 105 tiles
        self.assertEqual(room.length, "full")
        self.assertTrue(any("raised" in entry["text"] for entry in room.history))

    def test_an_explicit_length_that_is_too_small_is_still_rejected(self):
        room = Room("X", rng=random.Random(1))
        host = room.add_player("A")
        with self.assertRaisesRegex(GameError, "not enough"):
            room.update_settings(host, length="short", max_players=8)
        self.assertEqual((room.length, room.max_players), ("medium", 2))

    def test_length_for_players(self):
        from game.room import length_for_players
        self.assertEqual([length_for_players(n, "short") for n in (2, 7, 8, 14, 15, 16)],
                         ["short", "short", "medium", "medium", "full", "full"])
        self.assertEqual(length_for_players(2), "medium")

    def test_board_shrink_to_margin_restores_the_start_area(self):
        board = Board()
        start = board.bounds()
        board.place_all([P(7, 20, "A"), P(7, 21, "T")])
        self.assertTrue(board.expand_to_margin(7))
        self.assertGreater(board.right, start["right"])
        board.remove_all([P(7, 20, "A"), P(7, 21, "T")])
        self.assertTrue(board.shrink_to_margin(7))
        self.assertEqual(board.bounds(), start)
        self.assertFalse(board.shrink_to_margin(7))

    def test_board_keeps_growth_needed_by_remaining_tiles(self):
        board = Board()
        board.place_all([P(7, 7, "A"), P(7, 25, "T")])
        board.expand_to_margin(7)
        wide = board.bounds()
        board.place_all([P(7, 26, "S")])
        board.expand_to_margin(7)
        board.remove_all([P(7, 26, "S")])
        board.shrink_to_margin(7)
        self.assertEqual(board.bounds(), wide)

    def test_successful_challenge_undoes_board_growth(self):
        set_words(WORDS)
        room = Room("CH", mode="classic", auto_expand=True, rng=random.Random(3))
        room.add_player("A"), room.add_player("B")
        room.start()
        before = room.board.bounds()
        mover = room.players[room.current]
        opp = room.players[1 - room.current]
        give(mover, list("CTAXXXX"))
        move(room, mover, "CTA", 7, 6)  # not a word, accepted in Classic until challenged
        self.assertNotEqual(room.board.bounds(), before)
        room.challenge(opp)
        self.assertTrue(room.board.is_empty())
        self.assertEqual(room.board.bounds(), before)

    def make_three(self):
        set_words(WORDS)
        now = [1000.0]
        room = Room("SK", max_players=3, rng=random.Random(6), clock=lambda: now[0])
        players = [room.add_player(n) for n in ("Ann", "Ben", "Cy")]
        for p in players:
            room.player_joined(p, f"sid-{p.seat}")
        room.maybe_start()
        return room, players, now

    def test_an_offline_player_can_be_skipped_after_the_grace_period(self):
        from game.room import SKIP_GRACE
        room, players, now = self.make_three()
        away = room.players[room.current]
        helper = room.players[(room.current + 1) % 3]
        room.player_left(away)
        self.assertIsNone(room.skippable_seat())
        with self.assertRaisesRegex(GameError, "offline"):
            room.skip_player(helper, away.seat)
        self.assertFalse(room.expire_turn())  # nothing to announce yet
        now[0] += SKIP_GRACE
        self.assertEqual(room.skippable_seat(), away.seat)
        self.assertTrue(room.expire_turn())   # tells the server to push the new "skippable" flag
        self.assertFalse(room.expire_turn())  # ...only once
        self.assertEqual(room.view_for(helper)["skippable"], away.seat)
        self.assertIsNone(room.view_for(away)["skippable"])
        with self.assertRaisesRegex(GameError, "yourself"):
            room.skip_player(away, away.seat)
        room.skip_player(helper, away.seat)
        self.assertEqual(room.current, (away.seat + 1) % 3)
        self.assertTrue(any("skipped" in entry["text"] for entry in room.history))

    def test_a_connected_or_returning_player_cannot_be_skipped(self):
        from game.room import SKIP_GRACE
        room, players, now = self.make_three()
        away = room.players[room.current]
        helper = room.players[(room.current + 1) % 3]
        room.player_left(away)
        now[0] += SKIP_GRACE + 5
        room.player_joined(away, "sid-new")  # came back in time
        self.assertIsNone(room.skippable_seat())
        with self.assertRaises(GameError):
            room.skip_player(helper, away.seat)
        other = players[(away.seat + 2) % 3]
        room.player_left(other)  # someone offline who is not on turn is not skippable
        now[0] += SKIP_GRACE + 5
        self.assertIsNone(room.skippable_seat())


class RulesFileTests(unittest.TestCase):
    """The layouts and rules written in wild_rules.txt / classic_rules.txt."""

    @staticmethod
    def board_from(filename, name):
        path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), filename)
        if not os.path.exists(path):
            return None
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
        namespace = {}
        exec(text[text.index(name + " = ["):], namespace)  # the board literal is valid Python
        return namespace[name]

    NAMES = {"": None, "DL": "DL", "TL": "TL", "DW": "DW", "TW": "TW", "2L": "DL", "3L": "TL", "2W": "DW", "3W": "TW"}

    def check_layout(self, table, board):
        for r in range(15):
            for c in range(15):
                cell = board[r][c]
                expected = "DW" if cell == "\u2605" else self.NAMES[cell]
                self.assertEqual(table.get((r, c)), expected, (r, c))

    def test_wild_layout_matches_the_rules_file(self):
        board = self.board_from("wild_rules.txt", "WILD_SCRABBLE_BOARD")
        if board is None:
            self.skipTest("wild_rules.txt not present")
        self.check_layout(WILD_PREMIUM, board)

    def test_classic_layout_matches_the_rules_file(self):
        board = self.board_from("classic_rules.txt", "SCRABBLE_BOARD")
        if board is None:
            self.skipTest("classic_rules.txt not present")
        self.check_layout(PREMIUM, board)

    def test_wild_has_no_triple_word_squares_and_blank_corners(self):
        self.assertNotIn("TW", WILD_PREMIUM.values())
        self.assertIsNone(premium_at(0, 0, "wild"))
        self.assertEqual(premium_at(0, 7, "wild"), "TL")
        self.assertEqual(premium_at(7, 0, "wild"), "TL")
        self.assertEqual(premium_at(0, 0, "classic"), "TW")
        self.assertEqual(premium_at(0, 0), "TW")  # classic is the default layout
        self.assertEqual(premium_at(-14, 0, "wild"), None)  # pattern repeats off the 15x15 grid
        self.assertEqual(premium_at(-7, 7, "wild"), "DW")

    def test_client_config_has_both_layouts(self):
        self.assertEqual(len(CONFIG["wild_premiums"]), len(WILD_PREMIUM))
        self.assertNotIn("TW", CONFIG["wild_premiums"].values())

    def test_wild_centre_star_still_doubles_the_first_word(self):
        room, a, b = make_room("wild")
        mover = room.players[room.current]
        # (7,7) is the centre; the TL on (7,3) triples its letter in Wild too.
        give(mover, list("CATQQQQ"))
        result = move(room, mover, "CAT", 7, 6)
        self.assertEqual(result["score"], (3 + 1 + 1) * 2)  # centre DW only
        room2, a2, b2 = make_room("wild")
        mover2 = room2.players[room2.current]
        give(mover2, list("CATQQQQ"))
        move(room2, mover2, "CAT", 7, 7)  # C on the star, A (7,8), T (7,9): no premiums but the star
        self.assertEqual(mover2.score, (3 + 1 + 1) * 2)

    def test_wild_edge_square_is_a_triple_letter_not_a_triple_word(self):
        from game.board import Word, WordCell
        from game.scoring import score_word
        cells = tuple(WordCell(0, c, ch, False, True) for c, ch in zip(range(6, 9), "CAT"))
        # (0,7) holds the A: TL in Wild (3x), TW in Classic (word x3).
        self.assertEqual(score_word(Word(cells), "en", "wild"), 3 + 1 * 3 + 1)
        self.assertEqual(score_word(Word(cells), "en", "classic"), (3 + 1 + 1) * 3)

    def test_zero_point_play_gets_the_easter_egg(self):
        room, a, b = make_room("wild")
        mover = room.players[room.current]
        give(mover, [BLANK, BLANK, "Q", "Q", "Q", "Q", "Q"])
        items = [
            {"rack_index": 0, "row": 7, "col": 7, "letter": "G"},
            {"rack_index": 1, "row": 7, "col": 8, "letter": "O"},
        ]
        room.place_tiles(mover, items)
        result = room.submit(mover)
        self.assertEqual(result["score"], 0)
        self.assertIn("0 points? 0 points!", room.history[-1]["text"])

    def test_normal_play_has_no_easter_egg(self):
        room, a, b = make_room("wild")
        mover = room.players[room.current]
        give(mover, list("CATQQQQ"))
        move(room, mover, "CAT", 7, 6)
        self.assertNotIn("0 points", room.history[-1]["text"])

    def test_history_play_entries_carry_their_words(self):
        room, a, b = make_room("wild")
        mover = room.players[room.current]
        give(mover, list("CATQQQQ"))
        move(room, mover, "CAT", 7, 6)
        self.assertEqual(room.history[-1]["words"], ["CAT"])
        self.assertNotIn("words", room.history[0])  # system lines carry none


class TileTrackerTests(unittest.TestCase):
    def test_tracker_is_bag_plus_opponent_racks(self):
        room, a, b = make_room("wild")
        seen = room.view_for(a)["tiles"]
        self.assertEqual(seen["total"], len(room.bag) + len(b.rack))
        self.assertEqual(sum(seen["letters"].values()), seen["total"])
        self.assertEqual(seen["vowels"] + seen["consonants"] + seen["blanks"], seen["total"])

    def test_tracker_never_reveals_the_players_own_rack(self):
        room, a, b = make_room("wild")
        room.bag.clear()
        give(a, list("CATQQQQ"))
        give(b, list("DOGZZZZ"))
        mine = room.view_for(a)["tiles"]
        self.assertEqual(mine["letters"], {"D": 1, "O": 1, "G": 1, "Z": 4})
        theirs = room.view_for(b)["tiles"]
        self.assertEqual(theirs["letters"], {"C": 1, "A": 1, "T": 1, "Q": 4})
        self.assertEqual((mine["vowels"], mine["consonants"]), (1, 6))

    def test_empty_bag_shows_the_opponents_exact_tiles(self):
        room, a, b = make_room("wild")
        room.bag.clear()
        self.assertEqual(sorted(room.view_for(a)["tiles"]["letters"].items()),
                         sorted((t, b.rack.count(t)) for t in set(b.rack)))

    def test_blanks_are_counted_apart_and_finnish_vowels_include_umlauts(self):
        set_words(WORDS)
        room = Room("FI", language="fi", rng=random.Random(2))
        a, b = room.add_player("A"), room.add_player("B")
        room.start()
        room.bag.clear()
        give(b, ["Ä", "Ö", "K", BLANK, "Y", "S", "T"])
        tiles = room.view_for(a)["tiles"]
        self.assertEqual((tiles["vowels"], tiles["consonants"], tiles["blanks"]), (3, 3, 1))


class ResignTests(unittest.TestCase):
    def lobby(self, count):
        set_words(WORDS)
        room = Room("RESIGN", mode="wild", max_players=count, rng=random.Random(4))
        players = [room.add_player(n) for n in ("Ann", "Ben", "Cy", "Di")[:count]]
        room.maybe_start()
        return room, players

    def test_two_player_resign_gives_the_win_to_the_opponent(self):
        room, (a, b) = self.lobby(2)
        a.score, b.score = 99, 3  # the leader resigning still loses
        room.resign(a)
        self.assertEqual(room.status, "finished")
        self.assertEqual(room.winner, b.seat)
        self.assertEqual(room.final["winners"], [b.seat])
        self.assertEqual(room.final["adjustments"], [0, 0])
        self.assertIn("resigned", " ".join(h["text"] for h in room.history))

    def test_resigning_returns_tiles_to_the_bag(self):
        room, (a, b, c) = self.lobby(3)
        bag_before = len(room.bag)
        room.resign(b)
        self.assertEqual(len(room.bag), bag_before + 7)
        self.assertEqual(b.rack, [])
        self.assertTrue(b.resigned)

    def test_three_player_game_goes_on_without_the_quitter(self):
        room, players = self.lobby(3)
        room.current = 0
        room.resign(players[1])  # not on turn
        self.assertEqual(room.status, "playing")
        room.pass_turn(players[0])
        self.assertEqual(room.current, 2)  # Ben is skipped in the turn order
        room.pass_turn(players[2])
        self.assertEqual(room.current, 0)

    def test_resigning_on_turn_passes_the_turn_on(self):
        room, players = self.lobby(3)
        room.current = 1
        room.resign(players[1])
        self.assertEqual(room.current, 2)
        self.assertEqual(room.status, "playing")

    def test_last_player_standing_wins_and_a_resigned_player_cannot(self):
        room, players = self.lobby(3)
        players[1].score = 500
        room.resign(players[1])
        room.resign(players[0])
        self.assertEqual(room.status, "finished")
        self.assertEqual(room.winner, players[2].seat)

    def test_normal_ending_ignores_resigned_players_scores(self):
        room, players = self.lobby(3)
        players[2].score = 500
        room.resign(players[2])
        room.current = 0
        room.bag.clear()
        give(players[0], list("CAT"))
        players[1].rack = ["Q"]
        move(room, players[0], "CAT", 7, 6)
        self.assertEqual(room.status, "finished")
        self.assertEqual(room.winner, players[0].seat)

    def test_resigned_players_cannot_act_again(self):
        room, (a, b, c) = self.lobby(3)
        room.resign(c)
        with self.assertRaisesRegex(GameError, "already"):
            room.resign(c)
        with self.assertRaises(GameError):
            room.stage_tiles(c, [])
        self.assertTrue(room.view_for(a)["players"][c.seat]["resigned"])

    def test_cannot_resign_before_the_start_or_after_the_end(self):
        set_words(WORDS)
        room = Room("RESIGN2", rng=random.Random(1))
        a = room.add_player("A")
        with self.assertRaisesRegex(GameError, "not started"):
            room.resign(a)
        b = room.add_player("B")
        room.maybe_start()
        room.resign(a)
        with self.assertRaisesRegex(GameError, "over"):
            room.resign(b)

    def test_scoreless_limit_counts_only_active_players(self):
        room, players = self.lobby(3)
        self.assertEqual(room.scoreless_limit, 9)
        room.resign(players[0])
        self.assertEqual(room.scoreless_limit, 6)

    def test_classic_resign_ends_the_game_even_while_a_final_play_awaits(self):
        room, a, b = make_room("classic")
        mover = room.players[room.current]
        opp = room.players[1 - room.current]
        room.bag.clear()
        give(mover, list("CAT"))
        move(room, mover, "CAT", 7, 6)
        self.assertTrue(room.awaiting_final)
        room.resign(opp)
        self.assertEqual(room.status, "finished")
        self.assertEqual(room.winner, mover.seat)


class WildTimerTests(unittest.TestCase):
    def test_wild_timer_running_out_costs_nothing(self):
        room, a, b, clock = timed_room("30s", mode="wild")
        first = room.current
        clock.t += 500
        self.assertFalse(room.expire_turn())
        self.assertEqual(room.current, first)
        self.assertEqual(room.view_for(a)["turn_ms_left"], 0)
        self.assertEqual(room.scoreless_turns, 0)

    def test_pause_freezes_and_resume_continues(self):
        room, a, b, clock = timed_room("60s")
        clock.t += 20
        room.pause_timer(b)  # anyone can pause, on turn or not
        clock.t += 300
        view = room.view_for(a)
        self.assertTrue(view["timer_paused"])
        self.assertEqual(view["turn_ms_left"], 40000)
        with self.assertRaisesRegex(GameError, "already"):
            room.pause_timer(a)
        room.resume_timer(a)
        self.assertFalse(room.view_for(a)["timer_paused"])
        clock.t += 10
        self.assertEqual(room.view_for(a)["turn_ms_left"], 30000)
        with self.assertRaisesRegex(GameError, "not paused"):
            room.resume_timer(a)

    def test_a_new_turn_starts_with_a_running_fresh_clock(self):
        room, a, b, clock = timed_room("60s")
        room.pause_timer(a)
        mover = room.players[room.current]
        room.pass_turn(mover)
        room.touch()
        view = room.view_for(a)
        self.assertFalse(view["timer_paused"])
        self.assertEqual(view["turn_ms_left"], 60000)

    def test_only_the_host_can_skip_and_only_after_time_is_up(self):
        room, a, b, clock = timed_room("30s")
        host, guest = room.players[0], room.players[1]
        self.assertEqual(room.view_for(guest)["host"], 0)
        with self.assertRaisesRegex(GameError, "not up"):
            room.skip_overtime(host)
        clock.t += 31
        self.assertTrue(room.timer_overtime())
        with self.assertRaisesRegex(GameError, "host"):
            room.skip_overtime(guest)
        on_turn = room.current
        room.skip_overtime(host)
        self.assertNotEqual(room.current, on_turn)
        self.assertIn("time ran out", room.history[-2]["text"])

    def test_paused_timer_cannot_be_skipped_and_no_timer_means_no_pause(self):
        room, a, b, clock = timed_room("30s")
        clock.t += 31
        room.pause_timer(a)
        with self.assertRaisesRegex(GameError, "not up"):
            room.skip_overtime(room.players[0])
        room2, a2, b2, _ = timed_room("off")
        with self.assertRaisesRegex(GameError, "no timer"):
            room2.pause_timer(a2)

    def test_classic_timer_cannot_be_paused(self):
        room, a, b, clock = timed_room("30s", mode="classic")
        with self.assertRaisesRegex(GameError, "Wild"):
            room.pause_timer(a)
        with self.assertRaisesRegex(GameError, "Wild"):
            room.skip_overtime(room.players[0])


if __name__ == "__main__":
    unittest.main()
