"""Board coordinate translation, bounds validation, and path traversal."""

from dataclasses import dataclass

@dataclass(frozen=True)
class Coord:
    row: int
    col: int

def in_bounds(top, bottom, left, right, row, col):
    return top <= row <= bottom and left <= col <= right

def clamp(val, low, high):
    return max(low, min(high, val))
    
def manhattan_distance(r1, c1, r2, c2):
    return abs(r1 - r2) + abs(c1 - c2)