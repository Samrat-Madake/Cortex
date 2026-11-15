#!/usr/bin/env python3
"""Build a reproducible stratified M3-Bench Web subset task."""

from __future__ import annotations

import argparse
import collections
import json
import math
import os
import random
from pathlib import Path
from typing import Any


DEFAULT_SOURCE = Path(os.environ["M3_BENCH_WEB_JSONL"]) if os.environ.get("M3_BENCH_WEB_JSONL") else None
DEFAULT_OUTPUT = Path(os.environ.get("M3_BENCH_WEB_SUBSET_JSONL", "m3_bench_web_subset_240.jsonl"))
DEFAULT_MANIFEST = Path(os.environ.get("M3_BENCH_WEB_SUBSET_MANIFEST", "m3_bench_web_subset_240_manifest.json"))
DEFAULT_SIZE = 240
DEFAULT_SEED = 20260522


def load_rows(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def group_by_video(rows: list[dict[str, Any]]) -> collections.OrderedDict[str, dict[str, Any]]:
    grouped: collections.OrderedDict[str, dict[str, Any]] = collections.OrderedDict()
    for row in rows:
        video = grouped.setdefault(
            row["video_id"],
            {
                "rows": [],
                "labels": set(),
                "question_type_counts": collections.Counter(),
            },
        )
        video["rows"].append(row)
        for label in row.get("type") or []:
            video["labels"].add(label)
            video["question_type_counts"][label] += 1
    return grouped


def allocate_signature_quotas(
    grouped: collections.OrderedDict[str, dict[str, Any]],
    sample_size: int,
) -> dict[tuple[str, ...], int]:
    strata: dict[tuple[str, ...], list[str]] = collections.defaultdict(list)
    for video_id, video in grouped.items():
        strata[tuple(sorted(video["labels"]))].append(video_id)

    allocations = []
    for signature, video_ids in strata.items():
        exact = len(video_ids) * sample_size / len(grouped)
        base = math.floor(exact)
        allocations.append(
            {
                "signature": signature,
                "size": len(video_ids),
                "quota": base,
                "remainder": exact - base,
            },
        )

    remaining = sample_size - sum(item["quota"] for item in allocations)
    allocations.sort(key=lambda item: (item["remainder"], item["size"], item["signature"]), reverse=True)
    for item in allocations[:remaining]:
        item["quota"] += 1

    return {item["signature"]: item["quota"] for item in allocations}


def select_videos(
    grouped: collections.OrderedDict[str, dict[str, Any]],
    sample_size: int,
    seed: int,
) -> list[str]:
    strata: dict[tuple[str, ...], list[str]] = collections.defaultdict(list)
    for video_id, video in grouped.items():
        strata[tuple(sorted(video["labels"]))].append(video_id)

    quotas = allocate_signature_quotas(grouped, sample_size)
    rng = random.Random(seed)
    selected: set[str] = set()
    for signature, video_ids in strata.items():
        shuffled = list(video_ids)
        rng.shuffle(shuffled)
        selected.update(shuffled[: quotas[signature]])

    if len(selected) != sample_size:
        raise RuntimeError(f"Expected {sample_size} selected videos, got {len(selected)}")

    # Preserve source order in the task file so all questions for a video remain adjacent.
    return [video_id for video_id in grouped if video_id in selected]


def summarize(grouped: collections.OrderedDict[str, dict[str, Any]], video_ids: list[str]) -> dict[str, Any]:
    video_label_presence: collections.Counter[str] = collections.Counter()
    question_type_counts: collections.Counter[str] = collections.Counter()
    question_count = 0
    signature_counts: collections.Counter[str] = collections.Counter()
    for video_id in video_ids:
        video = grouped[video_id]
        video_label_presence.update(video["labels"])
        question_type_counts.update(video["question_type_counts"])
        question_count += len(video["rows"])
        signature_counts[" | ".join(sorted(video["labels"]))] += 1

    return {
        "videos": len(video_ids),
        "questions": question_count,
        "video_label_presence": dict(sorted(video_label_presence.items())),
        "video_label_presence_ratio": {
            label: count / len(video_ids)
            for label, count in sorted(video_label_presence.items())
        },
        "question_type_counts": dict(sorted(question_type_counts.items())),
        "question_type_ratio": {
            label: count / question_count
            for label, count in sorted(question_type_counts.items())
        },
        "signature_counts": dict(sorted(signature_counts.items())),
    }


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, required=DEFAULT_SOURCE is None)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--sample-size", type=int, default=DEFAULT_SIZE)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    args = parser.parse_args()

    rows = load_rows(args.source)
    grouped = group_by_video(rows)
    selected_video_ids = select_videos(grouped, args.sample_size, args.seed)
    selected = [
        row
        for video_id in selected_video_ids
        for row in grouped[video_id]["rows"]
    ]

    write_jsonl(args.output, selected)
    manifest = {
        "source": str(args.source),
        "output": str(args.output),
        "sample_size": args.sample_size,
        "seed": args.seed,
        "method": "Proportional stratified sampling by per-video multi-label type signature, with largest-remainder quota allocation and seeded random selection within each signature.",
        "full": summarize(grouped, list(grouped.keys())),
        "subset": summarize(grouped, selected_video_ids),
        "selected_video_ids": selected_video_ids,
    }
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
