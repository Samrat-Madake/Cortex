import json
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from typing import Any, Dict, List, Optional, Tuple, Union

from accelerate import Accelerator, DistributedType
from loguru import logger as eval_logger
from requests import Session
from requests.exceptions import RequestException
from tqdm import tqdm

from lmms_eval.api.instance import GenerationResult, Instance, TokenCounts
from lmms_eval.api.model import lmms
from lmms_eval.models.model_utils.concurrency_control import (
    AdaptiveConcurrencyConfig,
    decide_next_concurrency,
    is_rate_limit_error,
    parse_bool,
)
from lmms_eval.models.model_utils.usage_metrics import (
    get_running_totals,
    is_budget_exceeded,
    log_usage,
)


def _as_list(values: Any) -> List[Any]:
    if values is None:
        return []
    if isinstance(values, list):
        flattened = []
        for item in values:
            if isinstance(item, list):
                flattened.extend(item)
            else:
                flattened.append(item)
        return flattened
    return [values]


def _normalize_response_text(resp_json: Dict[str, Any]) -> str:
    for key in ("text", "response", "output", "answer"):
        value = resp_json.get(key)
        if isinstance(value, str):
            return value

    choices = resp_json.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            message = first.get("message")
            if isinstance(message, dict):
                content = message.get("content")
                if isinstance(content, str):
                    return content
                if isinstance(content, list):
                    texts = []
                    for block in content:
                        if isinstance(block, dict) and isinstance(block.get("text"), str):
                            texts.append(block["text"])
                    if texts:
                        return "".join(texts)
            content = first.get("text")
            if isinstance(content, str):
                return content

    return ""


def _parse_token_counts(resp_json: Dict[str, Any]) -> Optional[TokenCounts]:
    usage = resp_json.get("usage")
    if not isinstance(usage, dict):
        return None
    input_tokens = usage.get("prompt_tokens")
    output_tokens = usage.get("completion_tokens")
    reasoning_tokens = usage.get("reasoning_tokens")
    if input_tokens is None and output_tokens is None and reasoning_tokens is None:
        return None
    return TokenCounts(
        input_tokens=int(input_tokens) if input_tokens is not None else None,
        output_tokens=int(output_tokens) if output_tokens is not None else None,
        reasoning_tokens=int(reasoning_tokens) if reasoning_tokens is not None else None,
    )


class MemoryAPI(lmms):
    """Thin bridge backend for stateful video-memory pipelines.

    This backend forwards `video_path + prompt + metadata` to a user service.
    The service is expected to return JSON containing at least one of:
      - `text`
      - `response`
      - `output`
      - OpenAI-style `choices[0].message.content`
    """

    def __init__(
        self,
        endpoint: str = "http://127.0.0.1:8000/v1/lmms_eval/generate",
        api_key: Optional[str] = None,
        model_version: Optional[str] = None,
        timeout: int = 600,
        max_retries: int = 5,
        retry_backoff_s: float = 1.0,
        batch_size: int = 1,
        num_concurrent: int = 8,
        adaptive_concurrency: bool = False,
        adaptive_min_concurrency: int = 1,
        adaptive_max_concurrency: int = 64,
        adaptive_target_latency_s: float = 15.0,
        adaptive_increase_step: float = 0.1,
        adaptive_decrease_factor: float = 0.7,
        adaptive_failure_threshold: float = 0.05,
        include_doc_fields: str = "video_id,videoID,question_id,domain,sub_category,task_type,duration,url,group_type,group_structure,level,second_head,third_head,answer,before_clip,query_time_ms,query_time_id,video_start_time_ms,media_time_offset_ms",
        **kwargs,
    ) -> None:
        super().__init__()
        self.endpoint = endpoint.rstrip("/")
        self.api_key = api_key
        self.model_version = model_version
        self.timeout = int(timeout)
        self.max_retries = int(max_retries)
        self.retry_backoff_s = max(0.0, float(retry_backoff_s))
        self.batch_size_per_gpu = int(batch_size)
        self.num_concurrent = max(1, int(num_concurrent))
        self.include_doc_fields = [f.strip() for f in include_doc_fields.split(",") if f.strip()]

        self.adaptive_concurrency = parse_bool(adaptive_concurrency)
        self.adaptive_config = AdaptiveConcurrencyConfig.from_raw(
            min_concurrency=adaptive_min_concurrency,
            max_concurrency=adaptive_max_concurrency,
            target_latency_s=adaptive_target_latency_s,
            increase_step=adaptive_increase_step,
            decrease_factor=adaptive_decrease_factor,
            failure_threshold=adaptive_failure_threshold,
        )

        if kwargs:
            eval_logger.warning(f"Unknown model_args ignored: {list(kwargs.keys())}")

        accelerator = Accelerator()
        if accelerator.num_processes > 1:
            assert accelerator.distributed_type in [
                DistributedType.FSDP,
                DistributedType.MULTI_GPU,
                DistributedType.DEEPSPEED,
            ], "Unsupported distributed type provided. Only DDP and FSDP are supported."
            self.accelerator = accelerator
            if self.accelerator.is_local_main_process:
                eval_logger.info(f"Using {accelerator.num_processes} devices with data parallelism")
            self._rank = self.accelerator.local_process_index
            self._world_size = self.accelerator.num_processes
        else:
            self.accelerator = accelerator
            self._rank = self.accelerator.local_process_index
            self._world_size = self.accelerator.num_processes

        self.device = self.accelerator.device
        self._session = Session()

    @property
    def batch_size(self):
        return self.batch_size_per_gpu

    def _make_payload(
        self,
        context: str,
        gen_kwargs: Dict[str, Any],
        doc_to_visual_fn,
        doc_id: int,
        task: str,
        split: str,
    ) -> Dict[str, Any]:
        doc = self.task_dict[task][split][doc_id]
        raw_visuals = doc_to_visual_fn(doc)
        visual_paths = [v for v in _as_list(raw_visuals) if isinstance(v, str)]

        metadata = {
            "task": task,
            "split": split,
            "doc_id": int(doc_id),
        }
        for field in self.include_doc_fields:
            if isinstance(doc, dict) and field in doc:
                metadata[field] = doc[field]

        payload = {
            "prompt": context,
            "visual_paths": visual_paths,
            "generation_kwargs": dict(gen_kwargs),
            "metadata": metadata,
        }
        if self.model_version:
            payload["model"] = self.model_version
        return payload

    def _post_single(self, payload: Dict[str, Any]) -> Tuple[str, bool, bool, float, Optional[TokenCounts]]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        started = time.time()
        rate_limited = False
        last_error = "unknown error"
        for attempt in range(self.max_retries):
            try:
                response = self._session.post(
                    self.endpoint,
                    headers=headers,
                    data=json.dumps(payload, ensure_ascii=False),
                    timeout=self.timeout,
                )
                if response.status_code >= 400:
                    error_text = f"HTTP {response.status_code}: {response.text[:200]}"
                    raise RequestException(error_text)
                resp_json = response.json()
                text = _normalize_response_text(resp_json)
                token_counts = _parse_token_counts(resp_json)
                elapsed = time.time() - started
                return text, True, rate_limited, elapsed, token_counts
            except Exception as exc:
                last_error = str(exc)
                rate_limited = rate_limited or is_rate_limit_error(last_error)
                eval_logger.info(f"Attempt {attempt + 1}/{self.max_retries} failed with error: {last_error}")
                if attempt < self.max_retries - 1:
                    time.sleep(self.retry_backoff_s)

        elapsed = time.time() - started
        failure_text = f"[LMMS_EVAL_REQUEST_FAILED after {self.max_retries} retries] {last_error[:200]}"
        return failure_text, False, rate_limited, elapsed, None

    def generate_until(self, requests) -> List[GenerationResult]:
        ordered_requests = list(requests)
        if not ordered_requests:
            return []

        pbar = tqdm(total=len(ordered_requests), disable=(self.rank != 0), desc="Model Responding")
        responses: List[Union[GenerationResult, None]] = [None] * len(ordered_requests)

        current_concurrency = min(self.num_concurrent, self.adaptive_config.max_concurrency)
        max_workers = max(1, self.adaptive_config.max_concurrency if self.adaptive_concurrency else current_concurrency)

        cursor = 0
        in_flight = {}
        failed_requests = 0
        rate_limited_requests = 0
        latencies: List[float] = []
        completed_since_adapt = 0

        def maybe_update_concurrency(force: bool = False) -> None:
            nonlocal current_concurrency
            nonlocal failed_requests
            nonlocal rate_limited_requests
            nonlocal latencies
            nonlocal completed_since_adapt

            if not self.adaptive_concurrency:
                return

            sample_threshold = max(4, current_concurrency)
            if not force and completed_since_adapt < sample_threshold:
                return
            if completed_since_adapt <= 0:
                return

            decision = decide_next_concurrency(
                current_concurrency=current_concurrency,
                total_requests=completed_since_adapt,
                failed_requests=failed_requests,
                rate_limited_requests=rate_limited_requests,
                latencies=latencies,
                config=self.adaptive_config,
            )
            if decision.next_concurrency != decision.current_concurrency:
                eval_logger.info(
                    "Adaptive concurrency update: "
                    f"{decision.current_concurrency} -> {decision.next_concurrency} "
                    f"(fail_rate={decision.failure_rate:.3f}, "
                    f"rate_limit_rate={decision.rate_limit_rate:.3f}, "
                    f"p95_latency={decision.p95_latency_s:.3f}s)"
                )
            current_concurrency = decision.next_concurrency
            failed_requests = 0
            rate_limited_requests = 0
            latencies = []
            completed_since_adapt = 0

        def run_one(global_index: int):
            context, gen_kwargs, doc_to_visual_fn, doc_id, task, split = ordered_requests[global_index].args
            payload = self._make_payload(
                context=context,
                gen_kwargs=gen_kwargs,
                doc_to_visual_fn=doc_to_visual_fn,
                doc_id=doc_id,
                task=task,
                split=split,
            )
            return global_index, self._post_single(payload)

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            while cursor < len(ordered_requests) or in_flight:
                while cursor < len(ordered_requests) and len(in_flight) < max(1, current_concurrency):
                    request_index = cursor
                    if is_budget_exceeded():
                        responses[request_index] = GenerationResult(text="", token_counts=None)
                        pbar.update(1)
                        cursor += 1
                        continue
                    fut = executor.submit(run_one, request_index)
                    in_flight[fut] = request_index
                    cursor += 1

                if not in_flight:
                    break

                done, _ = wait(in_flight, return_when=FIRST_COMPLETED)
                for fut in done:
                    idx = in_flight.pop(fut)
                    local_index, (text, success, rate_limited, elapsed, token_counts) = fut.result()
                    assert idx == local_index

                    if token_counts is not None:
                        log_usage(
                            model_name=self.model_version or "memory_api",
                            task_name=None,
                            input_tokens=token_counts.input_tokens or 0,
                            output_tokens=token_counts.output_tokens or 0,
                            reasoning_tokens=token_counts.reasoning_tokens or 0,
                            source="model",
                        )
                    responses[idx] = GenerationResult(text=text, token_counts=token_counts)
                    if not success:
                        failed_requests += 1
                    if rate_limited:
                        rate_limited_requests += 1
                    latencies.append(elapsed)
                    completed_since_adapt += 1
                    totals = get_running_totals()
                    pbar.set_postfix({"tokens": f"{totals['total_tokens']:,}"}, refresh=False)
                    pbar.update(1)
                    maybe_update_concurrency(force=False)

        maybe_update_concurrency(force=True)
        pbar.close()
        return [resp if resp is not None else GenerationResult(text="", token_counts=None) for resp in responses]

    def loglikelihood(self, requests: List[Instance]) -> List[Tuple[float, bool]]:
        raise NotImplementedError("memory_api does not support loglikelihood")

    def generate_until_multi_round(self, requests) -> List[str]:
        raise NotImplementedError("memory_api does not support generate_until_multi_round")
