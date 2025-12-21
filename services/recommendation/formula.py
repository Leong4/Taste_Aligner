from typing import Union


def cz_score(seed: Union[str, int], idx: int) -> float:
    base = (hash(str(seed)) + idx) % 100 / 100.0
    return round(0.5 + 0.25 * base, 3)


def ez_score(seed: Union[str, int], idx: int) -> float:
    base = (hash(f"{seed}-{idx}") % 100) / 100.0
    return round(0.4 + 0.3 * base, 3)


def combined_score(cz: float, ez: float) -> float:
    return round(0.65 * cz + 0.35 * ez, 3)

