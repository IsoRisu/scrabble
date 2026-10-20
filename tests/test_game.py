"""Unit tests for the rules engine. Run with:  python -m unittest discover -s tests -v"""
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from game import room as room_module  # noqa: E402
from game.board import Board, GameError, Placement  # noqa: E402
from game.room import (  # noqa: E402
    CONFIG, Room, RoomRegistry, clean_name, diff_views, load_words, set_words,
)
from game.scoring import PREMIUM, score_move  # noqa: E402
from game.tiles import BLANK, TILE_DISTRIBUTION, TILE_VALUES, new_bag  # noqa: E402


def P(row, col, letter, blank=False):
    return Placement(row, col, letter, blank)


def word_placements(word, row, col, horizontal=True):
    return [
        P(row, col + i, ch) if horizontal else P(row + i, col, ch)
        for i, ch in enumerate(word)
    ]


class TileTests(unittest.TestCase):
    def test_bag_has_standard_distribution(self):
        bag = new_bag(random.Random(1))
        self.assertEqual(len(bag), 100)
        for tile, count in TILE_DISTRIBUTION.items():
            self.assertEqual(bag.count(tile), count, tile)
        self.assertEqual(bag.count(BLANK), 2)

    def test_total_face_value(self):
        total = sum(TILE_VALUES[t] * n for t, n in TILE_DISTRIBUTION.items())
        self.assertEqual(total, 187)  # the well-known total for the English set

    def test_bag_is_shuffled_and_rng_is_respected(self):
        a, b = new_bag(random.Random(5)), new_bag(random.Random(5))
        self.assertEqual(a, b)
        self.assertNotEqual(a, new_bag(random.Random(6)))


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

    def test_client_config_matches(self):
        self.assertEqual(len(CONFIG["premiums"]), len(PREMIUM))
        self.assertEqual(CONFIG["values"]["Q"], 10)


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
            Board().analyze([P(7, 14, "A"), P(7, 15, "B")])

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
        # H on a double letter (7,3), O on the centre double word: (8 + 1 + 1 + 1 + 1) * 2
        result = self.score(Board(), word_placements("HELLO", 7, 3))
        self.assertEqual(result.total, 24)
        self.assertFalse(result.bingo)

    def test_premium_squares_only_count_once(self):
        board = Board()
        board.place_all(word_placements("HELLO", 7, 3))
        # Extend to HELLOS at (7,8): no premium there, and the old DW must not re-apply.
        result = self.score(board, [P(7, 8, "S")])
        self.assertEqual(result.total, 4 + 1 + 1 + 1 + 1 + 1)

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
        letters = sum(TILE_VALUES[ch] for ch in "RETINAS")
        # premium squares on row 7: (7,3) DL -> T doubled, (7,7) DW
        expected = (letters + TILE_VALUES["T"]) * 2 + 50
        self.assertEqual(result.total, expected)


WORDS = ["CAT", "CATS", "AT", "ON", "NO", "TO", "HELLO", "ACE", "DOG", "GO", "OX", "XI", "AX", "ZA", "QI"]


def make_room(rules="strict", seed=1):
    set_words(WORDS)
    room = Room("TESTROOM", rules=rules, rng=random.Random(seed))
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
        self.assertEqual(result["score"], 24)
        self.assertEqual(mover.score, 24)
        self.assertEqual(len(mover.rack), 7)  # drew 5 replacements
        self.assertEqual(len(room.bag), 86 - 5)
        self.assertIs(room.players[room.current], opp)
        self.assertEqual(room.board.get(7, 7).letter, "O")

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

    def test_pending_is_visible_to_opponent_without_rack_indexes(self):
        room, a, b = make_room()
        mover = room.players[room.current]
        opp = room.players[1 - room.current]
        give(mover, list("CATSEEE"))
        room.place_tiles(mover, [{"rack_index": 0, "row": 7, "col": 7}])
        mine, theirs = room.view_for(mover), room.view_for(opp)
        self.assertIn("rack_index", mine["pending"][0])
        self.assertNotIn("rack_index", theirs["pending"][0])
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
            [-sum(TILE_VALUES[t] for t in a.rack), -sum(TILE_VALUES[t] for t in b.rack)],
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
        self.assertGreaterEqual(result["score"], 50)


class ChallengeTests(unittest.TestCase):
    def test_strict_mode_rejects_challenges(self):
        room, a, b = make_room("strict")
        with self.assertRaisesRegex(GameError, "challenge mode"):
            room.challenge(room.players[room.current])

    def test_challenge_mode_accepts_bogus_word_then_challenge_reverts_it(self):
        room, a, b = make_room("challenge")
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
        room, a, b = make_room("challenge")
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
        room, a, b = make_room("challenge")
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
        room, a, b = make_room("challenge")
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
        room, a, b = make_room("challenge")
        mover = room.players[room.current]
        opp = room.players[1 - room.current]
        give(mover, list("CATSEEE"))
        move(room, mover, "CAT", 7, 6)
        with self.assertRaisesRegex(GameError, "not your turn"):
            room.challenge(mover)

    def test_going_out_in_challenge_mode_waits_for_the_opponent(self):
        room, a, b = make_room("challenge")
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
        room, a, b = make_room("challenge")
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
        room, a, b = make_room("challenge")
        mover = room.players[room.current]
        opp = room.players[1 - room.current]
        room.bag = []
        give(mover, list("CAT"))
        give(opp, list("Q"))
        move(room, mover, "CAT", 7, 6)
        room.challenge(opp)
        self.assertEqual(room.status, "finished")


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
        room = registry.create("strict")
        self.assertEqual(len(room.code), 8)
        self.assertIs(registry.get(room.code.lower()), room)
        self.assertIsNone(registry.get("nope"))
        self.assertIsNone(registry.get(None))
        self.assertIsNone(registry.get("OOOOOOOO"))  # contains letters outside the alphabet
        registry.create("challenge")
        with self.assertRaisesRegex(GameError, "busy"):
            registry.create("strict")

    def test_registry_purges_stale_rooms(self):
        registry = RoomRegistry(abandoned_ttl=10)
        room = registry.create()
        room.last_active -= 100
        registry.purge()
        self.assertIsNone(registry.get(room.code))

    def test_unknown_rules(self):
        with self.assertRaises(GameError):
            Room("X", rules="chaos")

    def test_bundled_word_list(self):
        words = load_words()
        self.assertGreater(len(words), 20000)
        for w in ("QUIZ", "ZA", "QI", "XYLOPHONE", "SCRABBLE", "CATS"):
            self.assertIn(w, words)
        for w in ("ADJ", "XVIII", "BRRRR"):
            self.assertNotIn(w, words)
        self.assertTrue(all(2 <= len(w) <= 15 and w.isalpha() and w.isupper() for w in words))


if __name__ == "__main__":
    unittest.main()
