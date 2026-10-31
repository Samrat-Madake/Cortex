#!/usr/bin/env python3
"""Evaluate M3-Bench predictions with the same GPT judge logic as M3-Agent.

This script intentionally vendors the small judge path from M3-Agent instead
of importing that package, so it can be run directly from this repository.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[3]
M3_AGENT_SYSTEM_PROMPT = "You are an expert in video understanding."

M3_AGENT_VERIFY_PROMPT = """You are provided with a question, a ground truth answer, and an answer from an agent model. Your task is to determine whether the ground truth answer can be logically inferred from the agent's answer, in the context of the question.

Do not directly compare the surface forms of the agent answer and the ground truth answer. Instead, assess whether the meaning expressed by the agent answer supports or implies the ground truth answer. If the ground truth can be reasonably derived from the agent answer, return "Yes". If it cannot, return "No".

Important notes:
\t•\tDo not require exact wording or matching structure.
\t•\tSemantic inference is sufficient, as long as the agent answer entails or implies the meaning of the ground truth answer, given the question.
\t•\tOnly return "Yes" or "No", with no additional explanation or formatting.

Input fields:
\t•\tquestion: the question asked
\t•\tground_truth_answer: the correct answer
\t•\tagent_answer: the model's answer to be evaluated

Now evaluate the following input:

Input:
\t•\tquestion: {question}
\t•\tground_truth_answer: {ground_truth_answer}
\t•\tagent_answer: {agent_answer}

Output ('Yes' or 'No'):"""


def as_record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def first_text(*values: Any) -> str:
    for value in values:
        if value is None:
            continue
        if isinstance(value, str):
            text = value.strip()
            if text:
                return text
        elif isinstance(value, (int, float, bool)):
            return str(value)
        elif isinstance(value, list):
            text = first_text(*value)
            if text:
                return text
    return ""


def load_dotenv(path: Path, override: bool = False) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key or (not override and key in os.environ):
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ[key] = value


def first_env(*names: str) -> str | None:
    for name in names:
        value = os.getenv(name)
        if value and value.strip():
            return value.strip()
    return None


def load_json_or_jsonl(path: Path) -> list[dict[str, Any]]:
    if path.suffix == ".jsonl":
        rows: list[dict[str, Any]] = []
        with path.open("r", encoding="utf-8") as f:
            for line_no, line in enumerate(f, 1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise ValueError(f"Failed to parse {path}:{line_no}: {exc}") from exc
                if isinstance(value, dict):
                    rows.append(value)
        return rows

    value = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict)]
    if isinstance(value, dict):
        # M3-Agent annotation format: {video_id: {qa_list: [...]}}
        rows = []
        for video_id, video_data in value.items():
            video_record = as_record(video_data)
            for qa in video_record.get("qa_list", []):
                if not isinstance(qa, dict):
                    continue
                rows.append(
                    {
                        **qa,
                        "video_id": first_text(qa.get("video_id"), video_id),
                        "mem_path": first_text(qa.get("mem_path"), video_record.get("mem_path")),
                    }
                )
        if rows:
            return rows
        return [value]
    return []


def load_annotations(paths: list[Path]) -> dict[str, dict[str, Any]]:
    by_qid: dict[str, dict[str, Any]] = {}
    for path in paths:
        for row in load_json_or_jsonl(path):
            qid = first_text(row.get("question_id"), row.get("id"))
            if qid:
                by_qid[qid] = row
    return by_qid


def is_prediction_file(path: Path) -> bool:
    return path.name == "qa_results.jsonl" or (
        path.suffix == ".jsonl" and "_samples_" in path.name
    )


def find_prediction_files(paths: list[Path], qa_run_version: str | None) -> list[Path]:
    files: list[Path] = []
    for path in paths:
        if path.is_file():
            files.append(path)
            continue
        if not path.is_dir():
            raise FileNotFoundError(f"Prediction path not found: {path}")
        for child in path.rglob("*.jsonl"):
            if not is_prediction_file(child):
                continue
            if qa_run_version and f"/qa_runs/{qa_run_version}/" not in str(child):
                continue
            files.append(child)
    return sorted(set(files))


def iter_prediction_rows(files: list[Path]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in files:
        for row in load_json_or_jsonl(path):
            row["_source_path"] = str(path)
            rows.append(row)
    return rows


def get_question_id(row: dict[str, Any]) -> str:
    metric = as_record(row.get("videomme_perception_score"))
    submission = as_record(row.get("submission"))
    metadata = as_record(row.get("dataset_metadata"))
    return first_text(
        metric.get("question_id"),
        row.get("question_id"),
        submission.get("question_id"),
        metadata.get("question_id"),
        row.get("doc_id"),
        row.get("id"),
    )


def get_prediction(row: dict[str, Any]) -> str:
    metric = as_record(row.get("videomme_perception_score"))
    submission = as_record(row.get("submission"))
    payload = as_record(row.get("answer_payload"))
    return first_text(
        row.get("raw_answer"),
        payload.get("answer"),
        metric.get("pred_answer"),
        row.get("pred_answer"),
        row.get("prediction"),
        row.get("response"),
        submission.get("prediction"),
        row.get("filtered_resps"),
    )


def get_field(row: dict[str, Any], annotation: dict[str, Any], field: str) -> str:
    metric = as_record(row.get("videomme_perception_score"))
    submission = as_record(row.get("submission"))
    metadata = as_record(row.get("dataset_metadata"))
    return first_text(
        row.get(field),
        metric.get(field),
        submission.get(field),
        metadata.get(field),
        annotation.get(field),
    )


def get_answer(row: dict[str, Any], annotation: dict[str, Any]) -> str:
    metric = as_record(row.get("videomme_perception_score"))
    submission = as_record(row.get("submission"))
    return first_text(
        row.get("gt_answer"),
        row.get("target"),
        row.get("answer"),
        metric.get("answer"),
        metric.get("target"),
        submission.get("answer"),
        annotation.get("answer"),
    )


def build_messages(question: str, ground_truth: str, prediction: str) -> list[dict[str, Any]]:
    content = M3_AGENT_VERIFY_PROMPT.format(
        question=question,
        ground_truth_answer=ground_truth,
        agent_answer=prediction,
    )
    return [
        {"role": "system", "content": M3_AGENT_SYSTEM_PROMPT},
        {"role": "user", "content": [{"type": "text", "text": content}]},
    ]


class JudgeClient:
    def __init__(self, args: argparse.Namespace) -> None:
        self.model = args.model
        self.mode = args.api_mode
        self.timeout = args.timeout
        self.max_retries = args.max_retries
        self.retry_sleep = args.retry_sleep
        self.base_url = args.base_url or first_env("VLM_BASE_URL")
        self.api_key = args.api_key or first_env("VLM_API_KEY")
        self.azure_endpoint = args.azure_endpoint or os.getenv("AZURE_OPENAI_ENDPOINT")
        self.azure_api_key = args.azure_api_key or os.getenv("AZURE_OPENAI_API_KEY")
        self.azure_api_version = args.azure_api_version or os.getenv("AZURE_OPENAI_API_VERSION")
        self._load_m3_agent_config(args.m3_agent_config)

    def _load_m3_agent_config(self, config_path: str | None) -> None:
        if not config_path:
            return
        config = json.loads(Path(config_path).read_text(encoding="utf-8"))
        model_config = as_record(config.get(self.model))
        if not model_config:
            return
        self.base_url = first_text(model_config.get("base_url"), self.base_url)
        self.api_key = first_text(model_config.get("api_key"), self.api_key)
        self.azure_endpoint = first_text(model_config.get("azure_endpoint"), self.azure_endpoint)
        self.azure_api_key = first_text(model_config.get("api_key"), self.azure_api_key)
        self.azure_api_version = first_text(model_config.get("api_version"), self.azure_api_version)
        if model_config.get("azure_endpoint"):
            self.mode = "azure"

    def complete(self, messages: list[dict[str, Any]]) -> tuple[str, int | None]:
        last_error: Exception | None = None
        for attempt in range(self.max_retries):
            try:
                return self._complete_once(messages)
            except Exception as exc:  # noqa: BLE001 - matches M3-Agent retry behavior.
                last_error = exc
                print(
                    f"Retry {attempt} times, exception: {exc} from message {messages}",
                    file=sys.stderr,
                    flush=True,
                )
                if attempt + 1 < self.max_retries:
                    time.sleep(self.retry_sleep)
        raise RuntimeError(f"Failed to get response after {self.max_retries} retries") from last_error

    def _complete_once(self, messages: list[dict[str, Any]]) -> tuple[str, int | None]:
        if self.mode == "azure":
            if not self.azure_endpoint or not self.azure_api_key or not self.azure_api_version:
                raise ValueError("Azure mode requires endpoint, api key, and api version")
            endpoint = self.azure_endpoint.rstrip("/")
            deployment = urllib.parse.quote(self.model, safe="")
            query = urllib.parse.urlencode({"api-version": self.azure_api_version})
            url = f"{endpoint}/openai/deployments/{deployment}/chat/completions?{query}"
            headers = {"api-key": self.azure_api_key, "Content-Type": "application/json"}
            body = {"messages": messages, "temperature": 0, "max_tokens": 2048}
        else:
            if not self.base_url or not self.api_key:
                raise ValueError("OpenAI-compatible mode requires --base-url/VLM_BASE_URL and --api-key/VLM_API_KEY")
            url = f"{self.base_url.rstrip('/')}/chat/completions"
            headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
            body = {"model": self.model, "messages": messages, "temperature": 0, "max_tokens": 2048}

        request = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc

        content = payload["choices"][0]["message"]["content"]
        usage = as_record(payload.get("usage")).get("total_tokens")
        return str(content), int(usage) if isinstance(usage, int) else None


def m3_agent_eval_answer(
    client: JudgeClient,
    question: str,
    prediction: str,
    ground_truth: str,
) -> tuple[bool, str, int | None, str | None]:
    if prediction == "":
        return False, "", None, None
    try:
        response, tokens = client.complete(build_messages(question, ground_truth, prediction))
        result = response.lower()
    except Exception as exc:  # noqa: BLE001 - M3-Agent returns False on judge errors.
        print(f"Error verifying qa: {question} | {exc}", file=sys.stderr, flush=True)
        return False, "", None, str(exc)
    return ("yes" in result), response, tokens, None


def load_existing(path: Path) -> set[str]:
    if not path.exists():
        return set()
    done: set[str] = set()
    for row in load_json_or_jsonl(path):
        qid = first_text(row.get("question_id"))
        if qid:
            done.add(qid)
    return done


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    judged = [row for row in rows if not row.get("skipped")]
    correct = [row for row in judged if row.get("gpt_eval") is True]
    by_type: dict[str, dict[str, Any]] = {}
    type_counts: dict[str, list[bool]] = defaultdict(list)
    for row in judged:
        types = row.get("type")
        if isinstance(types, list):
            labels = [str(item) for item in types]
        else:
            labels = [first_text(types) or "unknown"]
        for label in labels:
            type_counts[label].append(row.get("gpt_eval") is True)
    for label, values in sorted(type_counts.items()):
        by_type[label] = {
            "correct": sum(values),
            "total": len(values),
            "accuracy": sum(values) / len(values) if values else 0.0,
        }
    return {
        "total_rows": len(rows),
        "judged": len(judged),
        "correct": len(correct),
        "accuracy": len(correct) / len(judged) if judged else 0.0,
        "skipped": len(rows) - len(judged),
        "by_status": dict(Counter(first_text(row.get("status")) or "unknown" for row in judged)),
        "by_type": by_type,
    }


def parse_args() -> argparse.Namespace:
    env_parser = argparse.ArgumentParser(add_help=False)
    env_parser.add_argument(
        "--env-file",
        type=Path,
        default=Path(os.getenv("REFLECTWORLD_ENV_FILE", REPO_ROOT / ".env")),
        help="Env file to load before resolving endpoint/model defaults. Defaults to repo .env.",
    )
    env_parser.add_argument("--env-override", action="store_true", help="Allow --env-file values to override shell env.")
    env_args, _ = env_parser.parse_known_args()
    load_dotenv(env_args.env_file, override=env_args.env_override)

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--env-file",
        type=Path,
        default=env_args.env_file,
        help="Env file to load before resolving endpoint/model defaults. Defaults to repo .env.",
    )
    parser.add_argument("--env-override", action="store_true", default=env_args.env_override)
    parser.add_argument("--pred", nargs="+", required=True, type=Path, help="Prediction jsonl file(s) or run directory/directories.")
    parser.add_argument(
        "--annotations",
        nargs="+",
        type=Path,
        required=True,
        help="M3-Bench annotation json/jsonl file(s), used to fill question and ground-truth answer.",
    )
    parser.add_argument("--qa-run-version", help="Only read qa_results.jsonl under this qa_runs/<version> directory.")
    parser.add_argument("--output", required=True, type=Path, help="Output JSONL with per-question judge results.")
    parser.add_argument("--summary", type=Path, help="Output summary JSON. Defaults to <output>.summary.json")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing output instead of resuming.")
    parser.add_argument("--limit", type=int, help="Evaluate only the first N rows after filtering.")
    parser.add_argument("--dry-run", action="store_true", help="Resolve inputs and write skipped-ready rows without calling the judge.")
    parser.add_argument(
        "--model",
        default=first_env("M3_AGENT_JUDGE_MODEL", "LLM_MODEL") or "gpt-4o-2024-11-20",
    )
    parser.add_argument("--api-mode", choices=["openai", "azure"], default=os.getenv("M3_AGENT_JUDGE_API_MODE", "openai"))
    parser.add_argument("--base-url", default=os.getenv("M3_AGENT_JUDGE_BASE_URL"))
    parser.add_argument("--api-key", default=os.getenv("M3_AGENT_JUDGE_API_KEY"))
    parser.add_argument("--azure-endpoint", default=os.getenv("M3_AGENT_JUDGE_AZURE_ENDPOINT"))
    parser.add_argument("--azure-api-key", default=os.getenv("M3_AGENT_JUDGE_AZURE_API_KEY"))
    parser.add_argument("--azure-api-version", default=os.getenv("M3_AGENT_JUDGE_AZURE_API_VERSION"))
    parser.add_argument("--m3-agent-config", help="Optional M3-Agent configs/api_config.json to mirror its model endpoint.")
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--max-retries", type=int, default=20)
    parser.add_argument("--retry-sleep", type=float, default=20.0)
    parser.add_argument("--workers", type=int, default=1, help="Parallel judge workers. Per-item judge prompt and scoring remain unchanged.")
    return parser.parse_args()


def build_result(row: dict[str, Any], annotations: dict[str, dict[str, Any]]) -> dict[str, Any]:
    qid = get_question_id(row)
    annotation = annotations.get(qid, {})
    question = get_field(row, annotation, "question")
    ground_truth = get_answer(row, annotation)
    prediction = get_prediction(row)
    return {
        "question_id": qid,
        "video_id": get_field(row, annotation, "video_id"),
        "question": question,
        "answer": ground_truth,
        "prediction": prediction,
        "type": annotation.get("type", row.get("type")),
        "status": row.get("status"),
        "answer_mode": row.get("answer_mode"),
        "failure_reason": row.get("failure_reason"),
        "source_path": row.get("_source_path"),
    }


def judge_row(
    row: dict[str, Any],
    annotations: dict[str, dict[str, Any]],
    client: JudgeClient | None,
    dry_run: bool,
) -> dict[str, Any]:
    result = build_result(row, annotations)
    qid = result["question_id"]
    question = result["question"]
    ground_truth = result["answer"]
    prediction = result["prediction"]
    if not qid or not question or not ground_truth:
        result.update({"skipped": True, "skip_reason": "missing_question_or_answer", "gpt_eval": False})
    elif dry_run:
        result.update({"skipped": True, "skip_reason": "dry_run", "gpt_eval": False})
    else:
        assert client is not None
        correct, judge_response, tokens, error = m3_agent_eval_answer(
            client,
            question=question,
            prediction=prediction,
            ground_truth=ground_truth,
        )
        result.update(
            {
                "gpt_eval": correct,
                "judge_response": judge_response,
                "judge_total_tokens": tokens,
                "judge_error": error,
            }
        )
        time.sleep(0.5)
    return result


def main() -> int:
    args = parse_args()
    annotations = load_annotations(args.annotations)
    files = find_prediction_files(args.pred, args.qa_run_version)
    rows = iter_prediction_rows(files)
    if args.limit is not None:
        rows = rows[: args.limit]

    args.output.parent.mkdir(parents=True, exist_ok=True)
    summary_path = args.summary or args.output.with_suffix(args.output.suffix + ".summary.json")
    if args.overwrite and args.output.exists():
        args.output.unlink()
    done = set() if args.overwrite else load_existing(args.output)
    client = None if args.dry_run else JudgeClient(args)

    all_results = [] if args.overwrite or not args.output.exists() else load_json_or_jsonl(args.output)
    pending_rows = [row for row in rows if get_question_id(row) not in done]
    with args.output.open("a", encoding="utf-8") as out:
        if args.workers <= 1:
            completed = len(all_results)
            for row in pending_rows:
                result = judge_row(row, annotations, client, args.dry_run)
                completed += 1
                out.write(json.dumps(result, ensure_ascii=False) + "\n")
                out.flush()
                all_results.append(result)
                if completed % 10 == 0:
                    print(f"processed={completed} written={len(all_results)} output={args.output}", file=sys.stderr, flush=True)
        else:
            completed = len(all_results)
            with ThreadPoolExecutor(max_workers=args.workers) as executor:
                futures = [
                    executor.submit(judge_row, row, annotations, client, args.dry_run)
                    for row in pending_rows
                ]
                for future in as_completed(futures):
                    result = future.result()
                    completed += 1
                    out.write(json.dumps(result, ensure_ascii=False) + "\n")
                    out.flush()
                    all_results.append(result)
                    if completed % 10 == 0:
                        print(f"processed={completed} written={len(all_results)} output={args.output}", file=sys.stderr, flush=True)

    summary = {
        **summarize(all_results),
        "model": args.model,
        "api_mode": args.api_mode,
        "prediction_files": [str(path) for path in files],
        "annotation_files": [str(path) for path in args.annotations],
        "output": str(args.output),
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
